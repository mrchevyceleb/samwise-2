import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { ASSISTANT_HUB_PATH } from './config.ts';
import {
  getClaudeSelection,
  getPlanMode,
  getSessionId,
  setClaudeSelection,
  setPlanMode,
  setSessionId,
} from './sessions.ts';
import { resolveClaudeSelection } from './claude-models.ts';
import { CodexSession, getOrCreateCodexSession } from './codex-runner.ts';
import { BananaSession, getOrCreateBananaSession } from './banana-runner.ts';
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

export type CliKind = 'claude' | 'codex' | 'assistant' | 'banana';

export type StreamEvent = unknown;

type Listener = (msg: SessionEvent) => void;

export type SessionEvent =
  | { type: 'event'; event: any }       // raw stream-json event from claude
  | { type: 'turnEnd'; sessionId?: string }
  | { type: 'closed'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; message: string; code?: string; retryable?: boolean; fatal?: boolean };

// The Claude model + reasoning effort are chosen per (cli, repo, chatId) via the
// UI picker and persisted through sessions.ts. They are spawn-time `--model` /
// `--effort` args (low|medium|high|xhigh|max; "max" is top), so a picker change
// recycles the warm process. resolveClaudeSelection is the trust boundary that
// validates the values and falls back to the signed catalog default (Opus 5).

const ASSISTANT_AGENT_PROMPT =
  "You are Samwise — a calm, literary, helpful assistant. The user is Matt. " +
  "You're working inside the ASSISTANT-HUB repo, which contains his task system, " +
  "client dashboards, and personal automation. Address him directly. Stay terse.";

/** stderr signatures the `claude` CLI prints when its in-memory OAuth token
 *  can't be refreshed — the refresh token was rotated out from under this
 *  long-lived child by another concurrent `claude` process sharing
 *  ~/.claude/.credentials.json. This is NOT an API 401 (it fails locally,
 *  before any request is made), so it never arrives as a 401 stream event and
 *  must be matched here to trigger the same respawn-from-disk recovery. Kept
 *  narrow (an OAuth/credential/token context is required) so an unrelated MCP
 *  server's "authenticate" stderr chatter can't tear the session down. */
export function isAuthFailureText(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes('oauth session expired')) return true;
  if (t.includes('oauth token') && t.includes('expired')) return true;
  if ((t.includes('oauth') || t.includes('credential')) && t.includes('could not be refreshed')) return true;
  if (
    t.includes('failed to authenticate') &&
    (t.includes('oauth') || t.includes('session') || t.includes('token') || t.includes('refresh'))
  ) {
    return true;
  }
  return false;
}

/** Re-sync the claude OAuth credentials for this process's CLAUDE_CONFIG_DIR
 *  before respawning after an auth failure. This is THE fix for the recurring
 *  "OAuth session expired" outage: the samwise-2 service reads creds from an
 *  isolated config dir (~/.config/autosam/claude-config) that is a *copy* of
 *  the source-of-truth ~/.claude login. When ~/.claude rotates its refresh
 *  token, the copy goes stale, and the next refresh gets invalid_grant and the
 *  CLI BLANKS the tokens on disk. `claude-auth-keepalive --ensure <dir>` heals
 *  the source login and re-copies fresh tokens into the config dir, so the
 *  respawn reads working credentials. Best-effort: on any failure (script
 *  missing, network down, source login also dead) we resolve anyway and let the
 *  respawn surface a real error. Bounded by a timeout so recovery can't hang. */
export function refreshClaudeCredentials(timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const home = process.env.HOME;
    if (!home) return resolve();
    const script = `${home}/bin/claude-auth-keepalive`;
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    const args = configDir ? ['--ensure', configDir] : [];
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      execFile(script, args, { timeout: timeoutMs }, (err) => {
        if (err) console.warn(`[claude] credential keepalive failed: ${err.message}`);
        else console.log(`[claude] credential keepalive re-synced ${configDir ?? '(default)'}`);
        done();
      });
    } catch (e) {
      console.warn(`[claude] credential keepalive spawn error: ${(e as Error).message}`);
      done();
    }
  });
}

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

export type SeqEvent = { seq: number; ev: SessionEvent; /** wall-clock ms when the event was emitted; replayed so block timestamps survive restarts */ ts?: number };

class ClaudeSession {
  readonly key: string;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  /** Whether this process was spawned with --permission-mode plan. Spawn-time
   *  arg, so toggling requires a recycle. */
  readonly planMode: boolean;
  /** Model + reasoning effort this process was spawned with (--model/--effort).
   *  Spawn-time args, so changing either requires a recycle. */
  readonly model: string;
  readonly effort: string;
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
  /** Set once we detect a fatal auth failure (401/403) from the CLI's stream.
   *  Guards failAuth() so a 10-deep retry storm only tears the child down once. */
  private authFailed = false;
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
    model: string,
    effort: string,
  ) {
    this.cli = cli;
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = keyOf(cli, cwd, chatId);
    this.pendingResumeId = resumeId;
    this.startedResumeId = resumeId;
    this.planMode = planMode;
    this.model = model;
    this.effort = effort;
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
      '--model', model,
      '--effort', effort,
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
      const text = chunk.trim();
      // A LOCAL OAuth refresh failure (this warm child's cached refresh token
      // was rotated out from under it by another concurrent `claude` process
      // sharing ~/.claude/.credentials.json) never reaches the API, so it
      // surfaces here on stderr as plain text rather than as a 401 stream
      // event. The disk credentials are almost always still valid (whoever
      // rotated them wrote a fresh pair), so this is recoverable: tear down
      // this stale child so the next spawn re-reads the fresh creds. Route it
      // through failAuth, exactly like an API 401, and mark it fatal so
      // index.ts drives the respawn+replay even when no turn is in flight.
      if (isAuthFailureText(text)) {
        this.emit({
          type: 'error',
          message: 'Claude OAuth session expired. Reconnecting with fresh credentials…',
          code: 'oauth',
          fatal: true,
        });
        this.failAuth();
        return;
      }
      // Surface stderr as a soft error event but don't kill the session — the
      // CLI prints harmless warnings here too.
      this.emit({ type: 'error', message: text });
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

  /** Compact the conversation in place: the CLI's own /compact. The child
   *  keeps its session id (the transcript on disk gets a compact boundary),
   *  so the next turn continues under the summarized context. The CLI emits
   *  `system compact_boundary` with pre/post token counts when it lands, and
   *  a final `result`, which ends the turn like any other. */
  compact(instructions?: string): void {
    if (this.child.exitCode !== null) {
      this.emit({ type: 'error', message: 'session has exited' });
      // The turn was already announced upstream; a turn with no turnEnd
      // leaves the client streaming until its watchdog fires.
      this.turnStartedAt = null;
      this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      return;
    }
    this.turnStartedAt = Date.now();
    // Marker for the thread: no _user_echo here, because the user did not
    // type anything. The client renders this as a small rule, then updates
    // it with the compact_boundary's token counts.
    this.emit({ type: 'event', event: { type: '_compact', ts: Date.now() } });
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: instructions ? `/compact ${instructions}` : '/compact',
      },
    });
    try {
      this.child.stdin.write(payload + '\n');
    } catch (e) {
      this.emit({ type: 'error', message: `compact write failed: ${(e as Error).message}` });
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
    // SIGKILL backstop: a claude child mid-backoff-sleep (e.g. an auth retry
    // storm) can ignore SIGTERM, leaving it lingering on the same --resume id
    // while a fresh process respawns. Force-kill after a grace period so we
    // never run two processes against one session. (Mirrors Rivendell.)
    setTimeout(() => {
      // A child reaped via SIGTERM leaves exitCode === null (signalCode is set
      // instead), so check both before force-killing — otherwise we'd SIGKILL a
      // PID that already exited.
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGKILL'); } catch {}
      }
    }, 3000).unref();
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
    return this.child.exitCode === null && !this.spawnError && !this.authFailed;
  }

  /** The warm child's OAuth token is dead (401/403). Retrying in-process can't
   *  recover it — its cached refresh token was rotated out from under it. Tear
   *  the child down so the next getOrCreateSession respawns a fresh process that
   *  re-reads credentials from disk. Guarded so a retry storm only kills once. */
  private failAuth(): void {
    if (this.authFailed) return;
    this.authFailed = true;
    // Kill immediately. The fatal error was already emitted synchronously just
    // above, and the child's 'exit'→'closed' fires on a later tick regardless,
    // so ordering is safe without deferring. Killing now (rather than a tick
    // later) shrinks the window before the process dies: the respawn only
    // happens on the user's NEXT send (human-timescale away), by which point
    // SIGTERM + the 3s SIGKILL backstop have reaped this process — so two
    // `claude --resume` processes never run against the same session id.
    this.shutdown();
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
    const se: SeqEvent = { seq: this.nextSeq++, ev: msg, ts: Date.now() };
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

    // Set when this event is a fatal OAuth failure. Suppresses the normal
    // turnEnd below: the turn is NOT done, it's being recovered (respawn +
    // replay) by index.ts. Emitting turnEnd here would let index.ts clear its
    // recovery arm and the in-flight turn, defeating the auto-replay. The
    // failure arrives as a `result` (with the auth text in `ev.result`) far
    // more often than as raw stderr, so this guard is load-bearing.
    let fatalAuthThisEvent = false;

    // Surface API failures the CLI otherwise buries as ordinary stream events.
    // A `result` with is_error / api_error_status is otherwise invisible — the
    // turn just ends and the user sees nothing. (Ported from Rivendell's runner,
    // which already surfaces these; samwise-2 was silent.)
    if (ev?.type === 'result' && (ev.is_error === true || typeof ev.api_error_status === 'number')) {
      const status = typeof ev.api_error_status === 'number' ? ` (${ev.api_error_status})` : '';
      const reason = typeof ev.result === 'string' && ev.result.trim()
        ? ev.result.trim()
        : `Request failed${status}`;
      // Only a 401 (dead/rotated OAuth token) or a local OAuth-refresh failure
      // is recoverable by respawning a fresh process that re-reads disk creds.
      // A 403 is usually a plan/permission problem that a respawn can't fix —
      // surface it, but don't kill the session over it.
      const fatalAuth = ev.api_error_status === 401
        || (typeof ev.result === 'string' && isAuthFailureText(ev.result));
      const statusSuffix = typeof ev.api_error_status === 'number' ? ` (${ev.api_error_status})` : '';
      this.emit({
        type: 'error',
        message: fatalAuth
          ? `Claude OAuth session expired${statusSuffix}. Reconnecting with fresh credentials…`
          : reason,
        code: typeof ev.api_error_status === 'number'
          ? String(ev.api_error_status)
          : (fatalAuth ? 'oauth' : undefined),
        retryable: ev.api_error_status === 429,
        fatal: fatalAuth,
      });
      if (fatalAuth) {
        fatalAuthThisEvent = true;
        this.failAuth();
      }
    }

    // A mid-turn API retry storm is otherwise invisible — the session just
    // appears to hang while the CLI silently retries up to 10× with backoff.
    // A 401/403 means the OAuth token is dead: retrying in-process can't fix it,
    // so surface it and kill the child (failAuth) to force a fresh respawn on the
    // next send. A 429 is retryable — surface it and let the CLI back off.
    if (ev?.type === 'system' && ev.subtype === 'api_retry' && typeof ev.error_status === 'number') {
      // error_status is always present here, so key strictly off 401 — a 403
      // carrying error:"authentication_failed" is a plan/permission problem a
      // respawn can't fix, so it must NOT be treated as fatal.
      const fatalAuth = ev.error_status === 401;
      if (fatalAuth) {
        this.emit({
          type: 'error',
          message: `Claude authentication failed (${ev.error_status}). Reconnecting with fresh credentials…`,
          code: String(ev.error_status),
          fatal: true,
        });
        fatalAuthThisEvent = true;
        this.failAuth();
      } else {
        const attempt = ev.attempt ? ` (attempt ${ev.attempt}/${ev.max_retries ?? '?'})` : '';
        this.emit({
          type: 'error',
          message: `API ${ev.error} ${ev.error_status}${attempt} — retrying…`,
          code: String(ev.error_status),
          retryable: true,
        });
      }
    }

    // turn end = `result` event from the CLI. But a fatal-auth result is NOT a
    // finished turn — it's being recovered (respawn + replay). Suppressing the
    // turnEnd keeps the client in its streaming state and preserves index.ts's
    // recovery arm + in-flight turn so the replay can fire. The replayed turn
    // emits its own result → turnEnd when it genuinely completes.
    if (ev?.type === 'result' && !fatalAuthThisEvent) {
      this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      this.turnStartedAt = null;
    } else if (ev?.type === 'result') {
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

// Returned by getOrCreateSession — common interface across all runners.
export type AnySession = ClaudeSession | CodexSession | BananaSession;

export async function getOrCreateSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
  /** Chosen Claude model/effort (claude/assistant only). When provided they win
   *  over the persisted selection and are persisted; a change from the warm
   *  process's spawn args recycles it. Ignored by codex/banana. */
  model?: string;
  effort?: string;
}): Promise<AnySession> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex') {
    return getOrCreateCodexSession({ repoPath: opts.repoPath, chatId });
  }
  if (opts.cli === 'banana') {
    return getOrCreateBananaSession({ repoPath: opts.repoPath, chatId });
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const planMode = await getPlanMode(opts.cli, cwd, chatId);
  const { model, effort } = await resolveClaudeSelectionForSession(
    opts.cli, cwd, chatId, opts.model, opts.effort,
  );

  const existing = sessions.get(key);
  // If a warm session is alive but its spawn args (plan mode, model, effort)
  // don't match what we want, recycle it. The session_id is preserved in
  // storage so the new process resumes the same conversation — just with
  // different spawn args.
  if (
    existing && existing.isAlive()
    && existing.planMode === planMode
    && existing.model === model
    && existing.effort === effort
  ) {
    return existing;
  }
  if (existing) {
    existing.shutdown();
    sessions.delete(key);
  }

  const resumeId = (await getSessionId(opts.cli, cwd, chatId)) ?? null;
  const session = await spawnSession(opts.cli, cwd, chatId, resumeId, key, planMode, model, effort);
  return session;
}

/** Resolve the Claude model/effort for a spawn. A browser-provided value (from
 *  the send/steer payload) wins and is persisted; otherwise the last persisted
 *  selection is used; otherwise the catalog default (Opus 5 / max). Persisting
 *  here keeps every caller — hello, send, recovery replay — spawning the SAME
 *  model without re-sending it, mirroring how getPlanMode is read fresh. */
async function resolveClaudeSelectionForSession(
  cli: CliKind,
  cwd: string,
  chatId: string,
  requestedModel?: string,
  requestedEffort?: string,
): Promise<{ model: string; effort: string }> {
  const stored = await getClaudeSelection(cli, cwd, chatId);
  const resolved = resolveClaudeSelection(
    requestedModel ?? stored.model,
    requestedEffort ?? stored.effort,
  );
  if (resolved.model !== stored.model || resolved.effort !== stored.effort) {
    await setClaudeSelection(cli, cwd, resolved.model, resolved.effort, chatId);
  }
  return resolved;
}

async function spawnSession(
  cli: CliKind,
  cwd: string,
  chatId: string,
  resumeId: string | null,
  key: string,
  planMode: boolean,
  model: string,
  effort: string,
  attempt = 0,
): Promise<ClaudeSession> {
  const session = new ClaudeSession(cli, cwd, chatId, resumeId, planMode, model, effort);
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
      return spawnSession(cli, cwd, chatId, null, key, planMode, model, effort, attempt + 1);
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
  if (opts.cli === 'banana') {
    const { freshStartBanana } = await import('./banana-runner.ts');
    return freshStartBanana({ repoPath: opts.repoPath, chatId });
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const planMode = await getPlanMode(opts.cli, cwd, chatId);
  // Fresh thread keeps the chosen model/effort — read the persisted selection
  // (the next send re-sends it anyway and would recycle if it differs).
  const { model, effort } = await resolveClaudeSelectionForSession(opts.cli, cwd, chatId);
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
  return spawnSession(opts.cli, cwd, chatId, null, key, planMode, model, effort);
}

export async function dropSession(cli: CliKind, repoPath: string, chatId = 'main'): Promise<void> {
  if (cli === 'codex') {
    const { dropCodexSession } = await import('./codex-runner.ts');
    await dropCodexSession({ repoPath, chatId });
    return;
  }
  if (cli === 'banana') {
    const { dropBananaSession } = await import('./banana-runner.ts');
    dropBananaSession({ repoPath, chatId });
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
  if (opts.cli === 'banana') {
    const { setBananaPlanMode } = await import('./banana-runner.ts');
    await setBananaPlanMode({ repoPath: opts.repoPath, chatId, enabled: opts.enabled });
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
  if (opts.cli === 'banana') {
    throw new Error('banana tools do not accept inline replies');
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
    await interruptCodex({ repoPath: opts.repoPath, chatId });
    return;
  }
  if (opts.cli === 'banana') {
    const { interruptBanana } = await import('./banana-runner.ts');
    interruptBanana({ repoPath: opts.repoPath, chatId });
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
