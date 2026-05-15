import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { ASSISTANT_HUB_PATH } from './config.ts';
import { getPlanMode, getSessionId, setPlanMode, setSessionId } from './sessions.ts';
import { CodexSession, getOrCreateCodexSession } from './codex-runner.ts';
import {
  appendEventLog,
  clearEventLog,
  compactEventLog,
  loadEventLogSync,
} from './event-log-store.ts';

// One persistent `claude` process per (cli, repoPath) pair, fed JSON over
// stdin and reading JSONL events from stdout. This kills the per-turn startup
// tax of the previous spawn-per-message model and matches the architecture
// proven out in Banana IDE.
//
// Lessons borrowed from Banana IDE:
// - Persistent stdin/stdout stream-json so the model warms once.
// - Detect "silent resume failure": if init reports a session_id that doesn't
//   match the one we asked for, the CLI started a fresh session. Treat as a
//   resume failure, drop the stale id, and let the conversation continue from
//   the new one (don't spawn again — the user's message hasn't been sent yet).

export type CliKind = 'claude' | 'codex' | 'assistant';

export type StreamEvent = unknown;

type Listener = (msg: SessionEvent) => void;

export type SessionEvent =
  | { type: 'event'; event: any }       // raw stream-json event from claude
  | { type: 'turnEnd'; sessionId?: string }
  | { type: 'closed'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; message: string };

const ASSISTANT_AGENT_PROMPT =
  "You are Samwise — a calm, literary, helpful assistant. The user is Matt. " +
  "You're working inside the ASSISTANT-HUB repo, which contains his task system, " +
  "client dashboards, and personal automation. Address him directly. Stay terse.";

// Each session keeps a rolling tail of recent events so a reconnecting client
// gets the in-flight turn's output even if its WS dropped mid-stream. Bigger
// is better here — claude emits ~30+ events per turn and the user might run a
// dozen turns before reconnecting; old events fall off the tail.
const EVENT_BUFFER_SIZE = 2000;

// A session with zero subscribers and no active turn for this long is killed
// by the per-session idle timer (or, as a backstop, by the global reaper in
// index.ts). 30 minutes lets a reasonable phone-lock-then-resume case still
// reattach to the warm process; longer than that we give back the resources.
export const IDLE_TTL_MS = 30 * 60 * 1000;

export type SeqEvent = { seq: number; ev: SessionEvent };

class ClaudeSession {
  readonly key: string;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  /** Whether this process was spawned with --permission-mode plan. Spawn-time
   *  arg, so toggling requires a recycle. */
  readonly planMode: boolean;
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private listeners = new Set<(e: SeqEvent) => void>();
  private subscriberCount = 0;
  /** Rolling tail of recent events (with sequence numbers) for reconnect replay. */
  private eventLog: SeqEvent[] = [];
  private mirrorEvents = true;
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  /** session_id we asked the CLI to resume (cleared once the init event arrives). */
  private pendingResumeId: string | null = null;
  /** session_id reported by the most recent init event. Persisted on every change. */
  private currentSessionId: string | null = null;
  private readonly startedResumeId: string | null = null;
  private resumeFailed = false;
  private spawnError: string | null = null;
  private initSeen = false;
  private exitedBeforeInit = false;
  private startupWaiters = new Set<(state: 'initialized' | 'closed') => void>();
  /** Self-expiring idle timer. Armed when subscriberCount drops to zero and
   *  no turn is in flight; disarmed on activity or new subscribers. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** Resolves true once init is received, false if the process exits before init. */
  readonly ready: Promise<boolean>;
  private resolveReady!: (ok: boolean) => void;

  constructor(
    cli: CliKind,
    cwd: string,
    chatId: string,
    resumeId: string | null,
    planMode: boolean,
  ) {
    this.cli = cli;
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = keyOf(cli, cwd, chatId);
    this.pendingResumeId = resumeId;
    this.startedResumeId = resumeId;
    this.planMode = planMode;
    this.ready = new Promise<boolean>((res) => { this.resolveReady = res; });

    try {
      const restored = loadEventLogSync(this.key);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
        console.log(
          `[${cli}] restored ${restored.events.length} event(s) for ${this.key} (nextSeq=${this.nextSeq})`,
        );
      }
    } catch (err) {
      console.warn(`[${cli}] event-log restore failed for ${this.key}:`, (err as Error).message);
    }
    void compactEventLog(this.key);

    // Quiet-ready: the modern claude binary doesn't emit system/init until it
    // receives its first stdin message. Per Banana IDE: if the process is
    // alive after a short window and stderr is clean, treat it as ready so
    // the first send can go through. Init will fire later, after that send.
    setTimeout(() => {
      if (!this.initSeen && !this.exitedBeforeInit && !this.spawnError) {
        this.resolveReady(true);
      }
    }, 2000).unref();

    // Plan mode and skip-permissions are mutually exclusive. In plan mode the
    // CLI restricts the model to read-only tools and ExitPlanMode; the user
    // approves the plan via tool_result before the model can act.
    //
    // AskUserQuestion is disallowed because in -p (non-interactive) stream-json
    // mode the CLI itself auto-fails the call within milliseconds with a
    // tool_result `{content:"Answer questions?",is_error:true}` — our host can
    // never write a real reply in time, so the answer card collapses unanswered
    // and the user has no way to respond. Blocking the tool forces the model
    // to ask inline in plain text instead, which the user can reply to normally.
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--disallowedTools', 'AskUserQuestion',
      ...(planMode
        ? ['--permission-mode', 'plan']
        : ['--dangerously-skip-permissions']),
    ];
    if (resumeId) args.push('--resume', resumeId);
    if (cli === 'assistant') args.push('--append-system-prompt', ASSISTANT_AGENT_PROMPT);

    this.child = spawn('claude', args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      // Surface stderr as a soft error event but don't kill the session — the
      // CLI prints harmless warnings here too.
      this.emit({ type: 'error', message: chunk.trim() });
    });

    this.child.on('exit', (code, signal) => {
      if (!this.initSeen) {
        this.exitedBeforeInit = true;
        if (this.pendingResumeId) void setSessionId(this.cli, this.cwd, '', this.chatId);
        this.resolveReady(false);
        this.resolveStartupWaiters('closed');
      }
      this.emit({ type: 'closed', code, signal });
    });

    this.child.on('error', (err) => {
      this.spawnError = String(err?.message ?? err);
      if (!this.initSeen) {
        this.resolveReady(false);
        this.resolveStartupWaiters('closed');
      }
      this.emit({ type: 'error', message: this.spawnError });
    });
  }

  /**
   * Subscribe to live events. If `sinceSeq` is provided, immediately replays
   * any buffered events with seq > sinceSeq before returning. Pass 0 for
   * "give me everything in the buffer."
   */
  subscribe(fn: (e: SeqEvent) => void, sinceSeq = -1, countSubscriber = true): () => void {
    // A new live subscriber cancels any pending idle death.
    if (countSubscriber) this.disarmIdleTimer();
    if (sinceSeq >= 0) {
      for (const se of this.eventLog) {
        if (se.seq > sinceSeq) fn(se);
      }
    }
    this.listeners.add(fn);
    if (countSubscriber) this.subscriberCount += 1;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(fn);
      if (countSubscriber) {
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
        if (this.subscriberCount === 0) {
          this.lastActivityAtMs = Date.now();
          this.armIdleTimer();
        }
      }
    };
  }

  /** The latest sequence number (clients can send this on reconnect). */
  latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Most recent turn start (ms) — used for telegram-ping duration. */
  private turnStartedAt: number | null = null;

  /** Send a user message into the running CLI as one turn. */
  send(text: string, images?: Array<{ mediaType: string; base64: string }>): void {
    if (this.child.exitCode !== null) {
      this.emit({ type: 'error', message: 'session has exited' });
      return;
    }
    this.turnStartedAt = Date.now();
    // Echo the user message into our event log so reconnecting clients can
    // replay the full conversation, not just Sam's responses (claude doesn't
    // re-emit the user turn in its stream).
    this.emit({
      type: 'event',
      event: {
        type: '_user_echo',
        text,
        imageCount: images?.length ?? 0,
        ts: Date.now(),
      },
    });
    // Build claude's content array. Images come first so claude sees them
    // before the prompt.
    const content: Array<any> = [];
    if (images && images.length) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        });
      }
    }
    if (text) content.push({ type: 'text', text });
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: content.length === 1 && content[0].type === 'text' && !images?.length
          ? text
          : content,
      },
    });
    try {
      this.child.stdin.write(payload + '\n');
    } catch (e) {
      this.emit({ type: 'error', message: `stdin write failed: ${(e as Error).message}` });
    }
  }

  /** Reply to a tool the model is waiting on (AskUserQuestion, ExitPlanMode,
   *  any other interactive tool that needs a tool_result to advance the turn).
   *  We keep this separate from `send` because tool_result is part of the
   *  current turn — emitting an echo would render it as a fresh user message.
   *  The plan-mode toolUseId pairs with claude's own ExitPlanMode emission;
   *  AskUserQuestion pairs with whichever id the model assigned. */
  respondToTool(toolUseId: string, content: string): void {
    if (this.child.exitCode !== null) {
      this.emit({ type: 'error', message: 'session has exited' });
      return;
    }
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'text', text: content }],
          },
        ],
      },
    });
    try {
      this.child.stdin.write(payload + '\n');
      // Surface a synthetic echo so the chat shows what the user answered.
      // Marked as a tool reply so the reducer doesn't render a duplicate user
      // bubble — the answer card already shows the choice inline.
      this.emit({
        type: 'event',
        event: {
          type: '_tool_response',
          toolUseId,
          content,
          ts: Date.now(),
        },
      });
    } catch (e) {
      this.emit({ type: 'error', message: `tool_result write failed: ${(e as Error).message}` });
    }
  }

  /** Tear down the underlying process. */
  shutdown(): void {
    this.disarmIdleTimer();
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill('SIGTERM'); } catch {}
  }

  detachEventLog(): void {
    this.mirrorEvents = false;
  }

  /** Same as shutdown, but framed for the user's "stop" button — keeps the
   *  saved session_id so the next message resumes the conversation.
   *  We deliberately do NOT clear listeners here: other tabs subscribed to
   *  the same session need to receive the `closed` event the child's exit
   *  handler emits, so they can drop their sessionPromise and rebind on
   *  the next send. Per-subscribe `unsubscribe()` already removes any stale
   *  listener owned by the rebinding socket itself. */
  interrupt(): void {
    this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
    this.shutdown();
  }

  isAlive(): boolean {
    return this.child.exitCode === null && !this.spawnError;
  }

  hasResumeFailed(): boolean {
    return this.resumeFailed;
  }

  /** True while this session is actively processing a turn (between user send and result event). */
  isBusy(): boolean {
    return this.turnStartedAt !== null;
  }

  sessionId(): string | null {
    return this.currentSessionId ?? this.pendingResumeId;
  }

  startedWithResume(): boolean {
    return Boolean(this.startedResumeId);
  }

  waitForInitOrExit(timeoutMs: number): Promise<'initialized' | 'closed' | 'timeout'> {
    if (this.initSeen) return Promise.resolve('initialized');
    if (this.exitedBeforeInit || this.child.exitCode !== null || this.spawnError) {
      return Promise.resolve('closed');
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (state: 'initialized' | 'closed' | 'timeout') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startupWaiters.delete(waiter);
        resolve(state);
      };
      const waiter = (state: 'initialized' | 'closed') => finish(state);
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      timer.unref?.();
      this.startupWaiters.add(waiter);
    });
  }

  listenerCount(): number {
    return this.subscriberCount;
  }

  /** Most recent activity timestamp (ms). */
  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  // ── private ────────────────────────────────────────────────

  private emit(msg: SessionEvent): void {
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.nextSeq++, ev: msg };
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    }
    if (this.mirrorEvents) appendEventLog(this.key, se);
    // Activity resets the idle clock. If no one's listening, immediately
    // re-arm so an event-only session (background work nobody's watching)
    // still expires on schedule.
    this.disarmIdleTimer();
    if (this.subscriberCount === 0) this.armIdleTimer();
    for (const fn of this.listeners) fn(se);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) return;
    if (this.subscriberCount > 0 || this.isBusy()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.idleExpire();
    }, IDLE_TTL_MS);
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private idleExpire(): void {
    if (this.subscriberCount > 0) return;
    if (this.isBusy()) return;
    if (Date.now() - this.lastActivityAtMs < IDLE_TTL_MS) {
      // Activity squeezed in just before the timer fired — re-arm.
      this.armIdleTimer();
      return;
    }
    // Drop ourselves from the manager Map (only if we're still the registered
    // entry — a fresh spawn could have replaced us) and shut down the child.
    removeFromSessionMap(this.key, this);
    this.shutdown();
  }

  private resolveStartupWaiters(state: 'initialized' | 'closed'): void {
    const waiters = Array.from(this.startupWaiters);
    this.startupWaiters.clear();
    for (const fn of waiters) fn(state);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf('\n');
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      nl = this.stdoutBuf.indexOf('\n');
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); }
      catch { continue; }
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: any): void {
    // Detect init + silent-resume-failure.
    if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
      const pending = this.pendingResumeId;
      this.pendingResumeId = null;
      this.initSeen = true;
      this.resolveReady(true);
      this.resolveStartupWaiters('initialized');
      if (pending && pending !== ev.session_id) {
        this.resumeFailed = true;
        this.emit({
          type: 'error',
          message: `Resume failed (session ${pending.slice(0, 8)}… not found). Started a fresh thread.`,
        });
      }
      this.currentSessionId = ev.session_id;
      void setSessionId(this.cli, this.cwd, ev.session_id, this.chatId);
    }

    // Track session_id from any event that carries it (some events carry it
    // as well as init; persisting on every change keeps us safe across forks).
    if (ev && typeof ev === 'object' && typeof ev.session_id === 'string'
        && ev.session_id !== this.currentSessionId) {
      this.currentSessionId = ev.session_id;
      void setSessionId(this.cli, this.cwd, ev.session_id, this.chatId);
    }

    this.emit({ type: 'event', event: ev });

    // turn end = `result` event from the CLI
    if (ev?.type === 'result') {
      this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      this.turnStartedAt = null;
    }
  }
}

// ── Session manager ────────────────────────────────────────────────

const sessions = new Map<string, ClaudeSession>();

function keyOf(cli: CliKind, cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${cwd}` : `${cli}|${cwd}|${normalized}`;
}

/** Used by ClaudeSession.idleExpire to evict itself. No-op if a different
 *  session has since taken the key (e.g., a fresh spawn replaced us). */
function removeFromSessionMap(key: string, expected: ClaudeSession): void {
  if (sessions.get(key) === expected) sessions.delete(key);
}

// Returned by getOrCreateSession — common interface across both runners.
export type AnySession = ClaudeSession | CodexSession;

export async function getOrCreateSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
}): Promise<AnySession> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex') {
    return getOrCreateCodexSession({ repoPath: opts.repoPath, chatId });
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const planMode = await getPlanMode(opts.cli, cwd, chatId);

  const existing = sessions.get(key);
  // If a warm session is alive but its plan-mode flag doesn't match what
  // we want, recycle it. The session_id is preserved in storage so the new
  // process resumes the same conversation — just with different spawn args.
  if (existing && existing.isAlive() && existing.planMode === planMode) return existing;
  if (existing) {
    existing.shutdown();
    sessions.delete(key);
  }

  const resumeId = (await getSessionId(opts.cli, cwd, chatId)) ?? null;
  const session = await spawnSession(opts.cli, cwd, chatId, resumeId, key, planMode);
  return session;
}

async function spawnSession(
  cli: CliKind,
  cwd: string,
  chatId: string,
  resumeId: string | null,
  key: string,
  planMode: boolean,
  attempt = 0,
): Promise<ClaudeSession> {
  const session = new ClaudeSession(cli, cwd, chatId, resumeId, planMode);
  sessions.set(key, session);

  session.subscribe((se) => {
    if (se.ev.type === 'closed' && sessions.get(key) === session) {
      sessions.delete(key);
    }
  }, -1, false);

  const ok = await session.ready;
  if (!ok) {
    sessions.delete(key);
    // Recover from a stale persisted session id: drop it and retry without
    // --resume. Only one retry — if even a fresh spawn dies before init,
    // something else is wrong.
    if (resumeId && attempt === 0) {
      await setSessionId(cli, cwd, '', chatId); // clear the bad id
      return spawnSession(cli, cwd, chatId, null, key, planMode, attempt + 1);
    }
    throw new Error('claude exited before initializing — check the CLI install or auth');
  }
  return session;
}

export function shutdownAllSessions(): void {
  for (const s of sessions.values()) s.shutdown();
  sessions.clear();
}

export type LiveSession = {
  cli: CliKind;
  cwd: string;
  chatId: string;
  busy: boolean;
  sessionId: string | null;
  /** ms since epoch of the most recent event (or spawn time if no events yet). */
  lastActivityAt: number;
};

export function activeClaudeSessions(): LiveSession[] {
  const out: LiveSession[] = [];
  for (const s of sessions.values()) {
    out.push({
      cli: s.cli,
      cwd: s.cwd,
      chatId: s.chatId,
      busy: s.isBusy(),
      sessionId: s.sessionId(),
      lastActivityAt: s.lastActivityAt(),
    });
  }
  return out;
}

export function pruneIdleClaudeSessions(ttlMs: number, now = Date.now()): number {
  let pruned = 0;
  for (const [key, session] of sessions) {
    if (session.isBusy()) continue;
    if (session.listenerCount() > 0) continue;
    if (now - session.lastActivityAt() < ttlMs) continue;
    session.shutdown();
    sessions.delete(key);
    pruned += 1;
  }
  return pruned;
}

// Drop the warm process AND the stored session id so the next spawn starts a
// fresh thread. Picks up any `claude update` you've run since the process
// last spawned.
export async function freshStart(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
}): Promise<AnySession> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex') {
    const { freshStartCodex } = await import('./codex-runner.ts');
    return freshStartCodex({ repoPath: opts.repoPath, chatId });
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const planMode = await getPlanMode(opts.cli, cwd, chatId);
  const existing = sessions.get(key);
  if (existing) {
    // Don't clear listeners — let the child's exit handler emit `closed` to
    // any other tabs subscribed to this session so they rebind cleanly.
    existing.detachEventLog();
    existing.shutdown();
    sessions.delete(key);
  }
  await clearEventLog(key);
  await setSessionId(opts.cli, cwd, '', chatId); // drop the stored id so we don't --resume
  return spawnSession(opts.cli, cwd, chatId, null, key, planMode);
}

export async function dropSession(cli: CliKind, repoPath: string, chatId = 'main'): Promise<void> {
  if (cli === 'codex') {
    const { dropCodexSession } = await import('./codex-runner.ts');
    dropCodexSession({ repoPath, chatId });
    return;
  }
  const cwd = cli === 'assistant' ? ASSISTANT_HUB_PATH : repoPath;
  const key = keyOf(cli, cwd, chatId);
  const s = sessions.get(key);
  if (s) {
    // Don't clear listeners — other tabs need the `closed` event from the
    // child's exit handler to drop their sessionPromise.
    s.shutdown();
    sessions.delete(key);
  }
}

/** Toggle plan mode for a (cli, repo, chatId) and recycle the warm process if
 *  the flag changed. The persisted session_id stays put — the next send will
 *  resume the same conversation, but with the new spawn args (Claude flips
 *  between `--permission-mode plan` and `--dangerously-skip-permissions`;
 *  Codex flips between read-only sandbox and bypass). */
export async function setPlanModeForSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
  enabled: boolean;
}): Promise<void> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex') {
    const { setCodexPlanMode } = await import('./codex-runner.ts');
    await setCodexPlanMode({ repoPath: opts.repoPath, chatId, enabled: opts.enabled });
    return;
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  await setPlanMode(opts.cli, cwd, opts.enabled, chatId);
  const existing = sessions.get(key);
  if (existing && existing.planMode !== opts.enabled) {
    existing.shutdown();
    sessions.delete(key);
  }
}

/** Forward a tool_result into the in-flight turn for this (cli, repo, chatId).
 *  Used by the UI's answer cards for AskUserQuestion / ExitPlanMode. Codex
 *  doesn't have these tools (it's spawn-per-turn), so the codex path is a
 *  no-op error. */
export async function respondToToolForSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
  toolUseId: string;
  content: string;
}): Promise<void> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex') {
    throw new Error('codex tools do not accept inline replies');
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const session = sessions.get(key);
  if (!session) throw new Error('no warm session to reply to');
  session.respondToTool(opts.toolUseId, opts.content);
}

/** Interrupt the in-flight turn for this (cli, repo) pair. Preserves the
 *  saved session_id so the next message resumes the conversation. */
export async function interruptSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
}): Promise<void> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex') {
    const { interruptCodex } = await import('./codex-runner.ts');
    interruptCodex({ repoPath: opts.repoPath, chatId });
    return;
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const s = sessions.get(key);
  if (s) {
    s.interrupt();
    sessions.delete(key);
  }
}

// Re-export so callers can ignore the manager and use the class type.
export { ClaudeSession };

// Convenience for index.ts: stable ids per WebSocket subscription.
export function newSubscriberId(): string {
  return randomUUID();
}
