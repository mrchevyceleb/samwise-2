import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliKind, SessionEvent, SeqEvent } from './runner.ts';
import { IDLE_TTL_MS } from './runner.ts';
import { getPlanMode, getSessionId, setPlanMode, setSessionId } from './sessions.ts';
import { resolveCodexSelection } from './codex-models.ts';
import { compactCodexThread } from './codex-app-server.ts';
import {
  appendEventLog,
  clearEventLog,
  compactEventLog,
  loadEventLogSync,
} from './event-log-store.ts';

/** Kill the entire process group (codex spawns tool subprocesses), then sweep
 *  any straggling descendants pgrep finds. Mirrors banana-runner's approach.
 *  Needed for steering: codex's tool subprocesses (sh, gh, etc.) outlive
 *  `child.kill()` and continue to write to the rollout JSONL. */
function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const descendants = child.pid ? collectDescendantPids(child.pid) : [];
  try { child.kill(signal); } catch {}
  if (child.pid) {
    try { process.kill(-child.pid, signal); } catch {}
  }
  for (const pid of descendants.reverse()) {
    try { process.kill(pid, signal); } catch {}
  }
}

function collectDescendantPids(pid: number): number[] {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const children = out
      .split(/\s+/)
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);
    return children.flatMap((c) => [c, ...collectDescendantPids(c)]);
  } catch {
    return [];
  }
}

/** Resolve once the child has fully exited. SIGTERM first; SIGKILL after 3s
 *  if it's still alive. Returns immediately if the child is already dead.
 *  Used by shutdown() so the next `codex exec resume` only starts after the
 *  prior child has released the rollout JSONL. Without this, steer races
 *  against the dying child's final writes and the resume reads partial state. */
async function waitForTreeExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    child.once('error', done);
  });
  terminateProcessTree(child, 'SIGTERM');
  const sigkill = setTimeout(() => {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
  }, 3000);
  sigkill.unref();
  await exited;
  clearTimeout(sigkill);
}

const EVENT_BUFFER_SIZE = 2000;

// Codex doesn't have a stdin-streaming mode (the way claude does with
// --input-format stream-json), so each turn spawns a fresh `codex exec --json`
// process that runs to completion. We normalize codex's `item.started` /
// `item.completed` events into the same claude-shaped stream-json event
// vocabulary the front-end already understands, so the reducer doesn't need
// to know there's a second CLI behind the curtain.

export type Listener = (e: SeqEvent) => void;

let nextSyntheticId = 1;
const synth = (prefix: string) => `${prefix}_${nextSyntheticId++}`;
type ChatImage = { mediaType: string; base64: string };
type CodexSendOptions = { images?: ChatImage[]; model?: unknown; effort?: unknown };
type ToolUseBlock = { index: number; toolUseId: string };
type CodexUsage = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
};
type CodexTurnState = {
  messageId: string;
  nextBlockIndex: number;
  toolUseBlocks: Map<string, ToolUseBlock>;
  usage: CodexUsage | null;
};

const CODEX_TURN_PREAMBLE = [
  '<samwise-codex-runtime>',
  'When you run shell commands that may take more than a few seconds or need polling, use exec_command with tty=true. This includes gh run watch, dev servers, test watchers, and other watch or follow commands.',
  'If you see "stdin is closed for this session", rerun the command with tty=true.',
  '</samwise-codex-runtime>',
].join('\n');

const imageExtension = (mediaType: string): string => {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  const subtype = mediaType.split('/')[1]?.split('+')[0] ?? 'img';
  return subtype.replace(/[^a-z0-9]/gi, '') || 'img';
};

const CODEX_TRACING_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+[\w_]+(?:::[\w_]+)*:/;

function isIgnorableCodexStderr(line: string): boolean {
  if (/Reading additional input from stdin/i.test(line)) return true;
  if (/failed to record rollout items/i.test(line)) return true;
  if (/write_stdin failed: stdin is closed for this session/i.test(line)) return true;
  return CODEX_TRACING_LINE.test(line);
}

export class CodexSession {
  readonly key: string;
  readonly cli: CliKind = 'codex';
  readonly cwd: string;
  readonly chatId: string;
  private listeners = new Set<Listener>();
  private subscriberCount = 0;
  private threadId: string | null = null;
  private busy = false;
  /** Last model + effort this thread actually ran, reported to a reopening
   *  browser so its picker shows the truth rather than a stale default. */
  model: string | null = null;
  effort: string | null = null;
  /** Aborts an in-flight manual compaction's app-server child when the chat
   *  is stopped or the server shuts down, and lets shutdown wait for it. */
  private compactionAbort: AbortController | null = null;
  private compactionRun: Promise<void> | null = null;
  /** Suppresses emits while a stopped session is being torn down. */
  private silent = false;
  /** Fresh input of the last finished turn; the "before" figure when the app
   *  server reports no usage of its own before the first compact. */
  private lastTurnInputTokens: number | null = null;
  private dead = false;
  private currentChild: ChildProcess | null = null;
  /** Set by shutdown() before SIGTERM so the in-flight send()'s close handler
   *  knows not to emit a stray result/turnEnd — shutdown will emit its own
   *  'closed' once the child has actually exited. */
  private intentionalKill = false;
  private eventLog: SeqEvent[] = [];
  private mirrorEvents = true;
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  /** Self-expiring idle timer. Mirrors ClaudeSession.idleTimer. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** Codex doesn't need a warmup turn — ready immediately. */
  readonly ready: Promise<boolean> = Promise.resolve(true);

  constructor(cwd: string, chatId: string, threadId: string | null) {
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = keyOf(cwd, chatId);
    this.threadId = threadId;
    try {
      const restored = loadEventLogSync(this.key);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
        console.log(
          `[codex] restored ${restored.events.length} event(s) for ${this.key} (nextSeq=${this.nextSeq})`,
        );
      }
    } catch (err) {
      console.warn(`[codex] event-log restore failed for ${this.key}:`, (err as Error).message);
    }
    void compactEventLog(this.key);
  }

  subscribe(fn: Listener, sinceSeq = -1, countSubscriber = true): () => void {
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

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  isAlive(): boolean {
    return !this.dead;
  }

  isBusy(): boolean {
    return this.busy;
  }

  sessionId(): string | null {
    return this.threadId;
  }

  listenerCount(): number {
    return this.subscriberCount;
  }

  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  /** Async so steering can await the child's full exit (SIGKILL fallback at
   *  3s) before the next `codex exec resume` spawns. Without the await, the
   *  dying child's final writes to the rollout JSONL race the resume read. */
  async shutdown(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.disarmIdleTimer();
    // A compact in flight must not emit into a dead session (its error/result
    // would land in the event log after `closed`), and its app-server must be
    // gone before the next exec resume touches the same rollout.
    this.silent = true;
    this.compactionAbort?.abort();
    if (this.compactionRun) {
      await this.compactionRun.catch(() => {});
    }
    this.silent = false;
    const child = this.currentChild;
    if (child && child.exitCode === null) {
      this.intentionalKill = true;
      await waitForTreeExit(child);
    }
    // Notify subscribers so the WS layer drops its sessionPromise and rebinds
    // on the next user send. Mirrors ClaudeSession's child-exit-driven closed
    // event; codex has no persistent child to hook, so we emit it explicitly.
    // Emit BEFORE discardListeners so the WS layer still receives it.
    this.emit({ type: 'closed', code: null, signal: 'SIGTERM' });
    this.discardListeners();
  }

  detachEventLog(): void {
    this.mirrorEvents = false;
  }

  /** Discard all listeners. Mirrors ClaudeSession.discardListeners — used
   *  to prevent late event leaks when this session is being torn down and a
   *  new one will replace it for the same key. */
  discardListeners(): void {
    this.listeners.clear();
  }

  /** Manual compact, Codex's own (the same one its TUI runs): a short-lived
   *  app-server compacts this thread in place, then the next exec resume reads
   *  the compacted history. Resolves when the turn is fully reported. */
  async compact(): Promise<void> {
    if (this.busy) {
      this.emit({ type: 'error', message: 'codex is still answering — wait for it to finish' });
      // The caller already sent turnStart (a send from another tab can race
      // the busy check above), so this turn must end too or the client stays
      // streaming until someone else's turn finishes.
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }
    if (!this.threadId) {
      this.emit({ type: 'error', message: 'this chat has no history to compact yet' });
      this.emit({ type: 'turnEnd', sessionId: undefined });
      return;
    }
    const run = this.runCompaction();
    this.compactionRun = run;
    try {
      await run;
    } finally {
      if (this.compactionRun === run) this.compactionRun = null;
    }
  }

  private async runCompaction(): Promise<void> {
    this.busy = true;
    const abort = new AbortController();
    this.compactionAbort = abort;
    this.emitClaudeEvent({ type: '_compact', ts: Date.now() });
    try {
      const { preTokens, postTokens } = await compactCodexThread(this.threadId as string, this.cwd, abort.signal);
      this.emitClaudeEvent({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: this.threadId,
        compact_metadata: {
          trigger: 'manual',
          ...(typeof (preTokens ?? this.lastTurnInputTokens) === 'number'
            ? { pre_tokens: preTokens ?? this.lastTurnInputTokens! }
            : {}),
          ...(typeof postTokens === 'number' ? { post_tokens: postTokens } : {}),
        },
      });
      this.emitClaudeEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: this.threadId,
        usage: typeof postTokens === 'number'
          ? {
              input_tokens: postTokens,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 0,
            }
          : undefined,
      });
    } catch (e) {
      this.emit({
        type: 'error',
        message: `couldn't compact this chat: ${(e as Error).message}`,
      });
      this.emitClaudeEvent({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: this.threadId,
      });
    } finally {
      this.busy = false;
      if (this.compactionAbort === abort) this.compactionAbort = null;
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
    }
  }

  async send(text: string, opts: CodexSendOptions = {}): Promise<void> {
    const images = opts.images;
    if (this.busy) {
      this.emit({
        type: 'error',
        message: 'codex is still answering — wait for the current turn to finish',
      });
      return;
    }
    const { model: codexModel, effort: codexEffort } = resolveCodexSelection(
      opts.model,
      opts.effort,
    );
    this.model = codexModel;
    this.effort = codexEffort;
    this.busy = true;
    // Echo for reconnect replay (codex's events don't re-emit the user prompt).
    this.emit({
      type: 'event',
      event: { type: '_user_echo', text, imageCount: images?.length ?? 0, ts: Date.now() },
    });

    let imageTempDir: string | null = null;
    const cleanupImages = () => {
      if (imageTempDir) void rm(imageTempDir, { recursive: true, force: true });
    };

    const imageArgs: string[] = [];
    try {
      if (images?.length) {
        imageTempDir = await mkdtemp(join(tmpdir(), 'samwise-codex-images-'));
        for (const [index, image] of images.entries()) {
          if (!image.mediaType.startsWith('image/')) {
            throw new Error(`unsupported image media type: ${image.mediaType}`);
          }
          const path = join(imageTempDir, `image-${index + 1}.${imageExtension(image.mediaType)}`);
          await writeFile(path, Buffer.from(image.base64, 'base64'));
          imageArgs.push('--image', path);
        }
      }
    } catch (e) {
      cleanupImages();
      this.busy = false;
      this.emit({ type: 'error', message: `image preparation failed: ${(e as Error).message}` });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }

    // Plan mode: read at send time so a toggle takes effect on the next turn
    // without needing to recycle the (otherwise per-turn-spawned) CodexSession.
    // Read-only sandbox + auto-deny approvals naturally constrains codex to
    // produce a plan instead of editing or running destructive commands.
    const planMode = await getPlanMode('codex', this.cwd, this.chatId);
    const sandboxArgs: string[] = planMode
      ? ['--sandbox=read-only', '--ask-for-approval=never']
      : ['--dangerously-bypass-approvals-and-sandbox'];

    const prompt = `${CODEX_TURN_PREAMBLE}\n\n${text}`;
    const codexReasoningConfig = `model_reasoning_effort="${codexEffort}"`;
    const args: string[] = this.threadId
      ? [
          'exec',
          'resume',
          '--json',
          '-m', codexModel,
          '-c', codexReasoningConfig,
          ...sandboxArgs,
          ...imageArgs,
          this.threadId,
          prompt,
        ]
      : [
          'exec',
          '--json',
          '-m', codexModel,
          '-c', codexReasoningConfig,
          ...sandboxArgs,
          ...imageArgs,
          prompt,
        ];

    const child = spawn('codex', args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Start a new process group so a steer can kill -<pgid> and take down
      // codex's tool subprocesses (sh, gh, etc.) along with it. Without this,
      // those children outlive `child.kill()` and keep writing to the rollout.
      detached: true,
    });
    this.currentChild = child;

    // Synthesize a claude-shaped message_start so the reducer's turn handling
    // stays consistent across CLIs.
    const turnState: CodexTurnState = {
      messageId: synth('msg'),
      nextBlockIndex: 0,
      toolUseBlocks: new Map(),
      usage: null,
    };
    const stderrChunks: string[] = [];

    let buf = '';
    const handleStdoutLine = (line: string) => {
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        this.handleCodexEvent(ev, turnState);
      } catch {
        // Non-JSON line, ignore.
      }
    };
    const flushStdoutBuffer = () => {
      const line = buf.trim();
      buf = '';
      handleStdoutLine(line);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        handleStdoutLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Codex emits two kinds of stderr: real errors (spawn/panic) and its own
      // structured tracing logs (`<ts>Z LEVEL module::path: ...`). The tracing
      // lines are internal debug output — most notably a `write_stdin failed`
      // ERROR every time codex's first exec_command lacks tty=true (which it
      // immediately retries on its own). Filter all tracing-format lines and
      // a couple of known benign warnings; surface only true unstructured
      // errors.
      for (const raw of chunk.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (isIgnorableCodexStderr(line)) continue;
        stderrChunks.push(line);
        this.emit({ type: 'error', message: line });
      }
    });

    let settled = false;
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      flushStdoutBuffer();
      this.busy = false;
      this.currentChild = null;
      cleanupImages();
      // Intentional kill (shutdown driven by steer/stop): skip result + turnEnd
      // emits. shutdown() will emit 'closed' once it's done awaiting us, and
      // the WS layer's steer/stop handler is already driving the next state.
      // Emitting turnEnd here would race with the new session's turnStart.
      if (this.intentionalKill) return;
      this.closeDanglingToolBlocks(turnState, code, stderrChunks.join('\n').trim());
      // Emit a result event so the front-end flips status back to 'ready'.
      // Forward normalized Codex usage so the context meter has sane numbers.
      this.emitClaudeEvent({
        type: 'result',
        subtype: code === 0 ? 'success' : 'error_during_execution',
        is_error: code !== 0,
        session_id: this.threadId ?? undefined,
        usage: turnState.usage ?? undefined,
      });
      if (this.threadId) {
        await setSessionId('codex', this.cwd, this.threadId, this.chatId);
      }
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      flushStdoutBuffer();
      this.busy = false;
      this.currentChild = null;
      cleanupImages();
      this.closeDanglingToolBlocks(turnState, null, err.message);
      this.emit({ type: 'error', message: `codex spawn failed: ${err.message}` });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
    });
  }

  // ── private ────────────────────────────────────────────────

  private emit(msg: SessionEvent): void {
    if (this.silent) return;
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.nextSeq++, ev: msg, ts: Date.now() };
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    }
    if (this.mirrorEvents) appendEventLog(this.key, se);
    this.disarmIdleTimer();
    if (this.subscriberCount === 0 && !this.dead) this.armIdleTimer();
    for (const fn of this.listeners) fn(se);
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.dead) return;
    if (this.subscriberCount > 0 || this.busy) return;
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
    if (this.dead) return;
    if (this.subscriberCount > 0) return;
    if (this.busy) return;
    if (Date.now() - this.lastActivityAtMs < IDLE_TTL_MS) {
      this.armIdleTimer();
      return;
    }
    removeFromCodexMap(this.key, this);
    // Idle self-expiry: no listeners, no in-flight turn, so the SIGTERM
    // doesn't need to be awaited. Don't block the timer callback on the
    // child exit.
    void this.shutdown();
  }

  /** Forward an event already in claude stream-json shape. */
  private emitClaudeEvent(event: any): void {
    this.emit({ type: 'event', event });
  }

  private handleCodexEvent(
    ev: any,
    state: CodexTurnState,
  ): void {
    if (!ev || typeof ev !== 'object') return;

    // Capture the thread id for resume on later turns.
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      this.threadId = ev.thread_id;
      this.emitClaudeEvent({
        type: 'system',
        subtype: 'init',
        session_id: ev.thread_id,
      });
      return;
    }

    if (ev.type === 'turn.started') {
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: state.messageId, role: 'assistant' },
        },
      });
      return;
    }

    if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
      const idx = state.nextBlockIndex++;
      const toolUseId = synth('tool');
      state.toolUseBlocks.set(ev.item.id, {
        index: idx,
        toolUseId,
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: toolUseId, name: 'Bash' },
        },
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: idx,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ command: ev.item.command ?? '' }),
          },
        },
      });
      return;
    }

    if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
      const block = state.toolUseBlocks.get(ev.item.id);
      if (!block) return;
      this.emitClaudeEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: block.index },
      });
      // Emit a synthetic user message carrying the tool_result, the way
      // claude does, so the reducer attaches the output to the right block.
      const output: string = ev.item.aggregated_output ?? '';
      this.emitClaudeEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.toolUseId,
              content: [{ type: 'text', text: output }],
            },
          ],
        },
      });
      state.toolUseBlocks.delete(ev.item.id);
      return;
    }

    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
      const idx = state.nextBlockIndex++;
      const text: string = typeof ev.item.text === 'string' ? ev.item.text : '';
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '' },
        },
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text },
        },
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: idx },
      });
      return;
    }

    // Capture per-turn token usage from `turn.completed` so the front-end
    // context meter has real numbers instead of leftover Claude figures.
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = ev.usage as Record<string, number | undefined>;
      const input = Number(u.input_tokens ?? 0);
      const cached = Number(u.cached_input_tokens ?? 0);
      const output = Number(u.output_tokens ?? 0);
      const effectiveInput = cached > 0 && cached < input ? input - cached : input;
      // The fallback "before" figure is the context the model actually saw,
      // not the fresh (uncached) part: fresh input can be smaller than the
      // compacted result and produce an impossible 2k -> 30k chip.
      this.lastTurnInputTokens = Math.max(0, input);
      state.usage = {
        // Codex reports huge cumulative cache-read counts. For the context
        // meter, show the effective fresh input instead of reconstructing the
        // full cache history and producing impossible multi-million totals.
        input_tokens: Math.max(0, effectiveInput),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: output,
      };
      return;
    }

    // Other event types — ignore.
  }

  private closeDanglingToolBlocks(
    state: CodexTurnState,
    code: number | null,
    detail: string,
  ): void {
    if (state.toolUseBlocks.size === 0) return;

    const fallback = code === 0
      ? 'Codex finished before reporting command output.'
      : `Codex exited before this command returned${typeof code === 'number' ? ` (code ${code})` : ''}.`;
    const text = detail || fallback;

    for (const block of state.toolUseBlocks.values()) {
      this.emitClaudeEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: block.index },
      });
      this.emitClaudeEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.toolUseId,
              content: [{ type: 'text', text }],
            },
          ],
        },
      });
    }
    state.toolUseBlocks.clear();
  }
}

/** Manager keyed by cwd — same semantics as the claude session map. */
const codexSessions = new Map<string, CodexSession>();

function keyOf(cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `codex|${cwd}` : `codex|${cwd}|${normalized}`;
}

/** Used by CodexSession.idleExpire to evict itself. No-op if a different
 *  session has since taken the key. */
function removeFromCodexMap(key: string, expected: CodexSession): void {
  if (codexSessions.get(key) === expected) codexSessions.delete(key);
}

export function activeCodexSessions(): {
  cli: CliKind;
  cwd: string;
  chatId: string;
  busy: boolean;
  sessionId: string | null;
  lastActivityAt: number;
}[] {
  return Array.from(codexSessions.values()).map((s) => ({
    cli: 'codex',
    cwd: s.cwd,
    chatId: s.chatId,
    busy: s.isBusy(),
    sessionId: s.sessionId(),
    lastActivityAt: s.lastActivityAt(),
  }));
}

export function pruneIdleCodexSessions(ttlMs: number, now = Date.now()): number {
  let pruned = 0;
  for (const [key, session] of codexSessions) {
    if (session.isBusy()) continue;
    if (session.listenerCount() > 0) continue;
    if (now - session.lastActivityAt() < ttlMs) continue;
    // Idle reaper: no listeners, not busy, so we can fire-and-forget the
    // SIGTERM. No racing resume to await for here.
    void session.shutdown();
    codexSessions.delete(key);
    pruned += 1;
  }
  return pruned;
}

export async function getOrCreateCodexSession(opts: {
  repoPath: string;
  chatId?: string;
}): Promise<CodexSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const key = keyOf(cwd, chatId);
  const existing = codexSessions.get(key);
  if (existing && existing.isAlive()) return existing;

  const threadId = (await getSessionId('codex', cwd, chatId)) ?? null;
  const session = new CodexSession(cwd, chatId, threadId);
  codexSessions.set(key, session);
  return session;
}

export function shutdownAllCodexSessions(): void {
  // Process-exit path: fire-and-forget the SIGTERM. Node will reap children
  // as the event loop drains.
  for (const s of codexSessions.values()) void s.shutdown();
  codexSessions.clear();
}

/** Kill the in-flight codex child and wait for it to fully exit before
 *  returning. Caller (steer/stop) needs the await so the next `codex exec
 *  resume` doesn't race the dying child's writes to the rollout JSONL. */
export async function interruptCodex(opts: { repoPath: string; chatId?: string }): Promise<void> {
  const cwd = opts.repoPath;
  const key = keyOf(cwd, opts.chatId);
  const s = codexSessions.get(key);
  if (s) {
    codexSessions.delete(key);
    await s.shutdown();
  }
}

/** Drop the warm codex child but keep the saved thread id so the next click
 *  resumes the conversation. Used by the user's manual "dismiss" button. */
export async function dropCodexSession(opts: { repoPath: string; chatId?: string }): Promise<void> {
  const cwd = opts.repoPath;
  const key = keyOf(cwd, opts.chatId);
  const s = codexSessions.get(key);
  if (s) {
    codexSessions.delete(key);
    await s.shutdown();
  }
}

/** Persist the plan-mode flag for codex. Codex is spawn-per-turn, so the next
 *  send picks up the new sandbox args automatically — there's no warm child
 *  to recycle. */
export async function setCodexPlanMode(opts: {
  repoPath: string;
  chatId?: string;
  enabled: boolean;
}): Promise<void> {
  await setPlanMode('codex', opts.repoPath, opts.enabled, opts.chatId || 'main');
}

/** Drop the stored thread id so the next codex spawn starts a fresh thread. */
export async function freshStartCodex(opts: {
  repoPath: string;
  chatId?: string;
}): Promise<CodexSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const key = keyOf(cwd, chatId);
  const existing = codexSessions.get(key);
  if (existing) {
    existing.detachEventLog();
    codexSessions.delete(key);
    await existing.shutdown();
  }
  await clearEventLog(key);
  await setSessionId('codex', cwd, '', chatId);
  const session = new CodexSession(cwd, chatId, null);
  codexSessions.set(key, session);
  return session;
}
