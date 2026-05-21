import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import type { CliKind, SessionEvent, SeqEvent } from './runner.ts';
import { IDLE_TTL_MS } from './runner.ts';
import { getPlanMode, getSessionId, setPlanMode, setSessionId } from './sessions.ts';
import {
  appendEventLog,
  clearEventLog,
  compactEventLog,
  loadEventLogSync,
} from './event-log-store.ts';

const EVENT_BUFFER_SIZE = 2000;

// ── Banana runner v2 ─────────────────────────────────────────────────────
//
// v1 spawned `banana run --format json` once per turn: each turn paid a
// 25-40s cold start and the answer arrived in one blob at the end (no token
// streaming). v2 runs ONE persistent `banana serve` process for the whole app
// and talks to it through the opencode v2 SDK.
//
// Architecture:
//  - BananaServer (module-level singleton) owns the `banana serve` child, one
//    shared SDK client, and ONE global SSE event subscription. It fans every
//    event out to the owning BananaSession by sessionID.
//  - BananaSession keeps the exact external contract v1 had (constructor,
//    subscribe, send, shutdown, the manager map and its helpers) so runner.ts
//    and the WS layer are unchanged. Each turn it creates/reuses an opencode
//    session, fires `session.prompt`, and normalizes the streaming v2 events
//    into the same claude-shaped stream-json vocabulary the front-end reducer
//    already understands — but now incremental, with real text deltas.

export type Listener = (e: SeqEvent) => void;

let nextSyntheticId = 1;
const synth = (prefix: string) => `${prefix}_${nextSyntheticId++}`;
type ChatImage = { mediaType: string; base64: string };
type BananaUsage = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
};
type SendOpts = {
  images?: ChatImage[];
  /** Chosen model id, e.g. `monkey/silverback` or `openrouter/anthropic/...`. */
  model?: string;
};

// Banana ships as a global homebrew binary. A launchd-spawned server may not
// have /opt/homebrew/bin on PATH, so resolve an absolute path. Honor BANANA_BIN
// first, then the known homebrew location, then the bare command name.
function resolveBananaBin(): string {
  const override = process.env.BANANA_BIN?.trim();
  if (override) return override;
  const brewPath = '/opt/homebrew/bin/banana';
  if (existsSync(brewPath)) return brewPath;
  return 'banana';
}

// The persistent serve process has no internal turn timeout. If its backend
// stalls mid-turn, no events arrive and the UI freezes on the thinking dots.
// The per-turn watchdog aborts the turn (NOT the server) after this much
// total silence. Banana cold-start latency can be 25-40s before the first
// event, so 120s of silence is a safe floor.
function resolveStallTimeoutMs(): number {
  const raw = Number(process.env.BANANA_STALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

// ── OpenRouter via monkey-models ─────────────────────────────────────────
//
// Banana's built-in `openrouter` provider only autoloads when it has an API
// key. With no key it registers ZERO models, so any OpenRouter pick fails
// with "model not found". The fix: override the `openrouter` provider's
// baseURL + apiKey to point at the monkey-models proxy, which forwards any
// model id straight to OpenRouter (no bundled model list) and supplies the
// real OpenRouter key. We hand `banana serve` the override inline via the
// BANANA_CONFIG_CONTENT env var.
//
// The monkey base URL + default token are copied verbatim from banana-cli-2
// packages/opencode/src/provider/provider.ts (MONKEY_BASE_URL /
// MONKEY_DEFAULT_TOKEN), so the proxy key here matches the one Banana's
// own `monkey` provider uses.
const MONKEY_BASE_URL = 'https://monkey-models-production.up.railway.app/v1';
const MONKEY_DEFAULT_TOKEN =
  '086399eca157e4ad2fc0fecfb254da1118d226ac53371757267388b23bd10fa6';

/** Resolve the monkey-models auth token the SAME way Banana's own provider
 *  does (packages/opencode/src/provider/provider.ts):
 *  BANANA_MONKEY_TOKEN, then MONKEY_MODELS_TOKEN, then the bundled default.
 *  Missing the MONKEY_MODELS_TOKEN fallback would send a stale token (403)
 *  whenever a deploy rotates the proxy key via that var. */
function resolveMonkeyToken(): string {
  return (
    process.env.BANANA_MONKEY_TOKEN?.trim() ||
    process.env.MONKEY_MODELS_TOKEN?.trim() ||
    MONKEY_DEFAULT_TOKEN
  );
}

/** True unless explicitly disabled. A deploy can set
 *  SAMWISE_BANANA_OPENROUTER_VIA_MONKEY to a falsy value to turn the
 *  override off without a code change. Accepts the common boolean-off
 *  spellings (false/0/no/off, any case) so `FALSE` or `0` also work. */
function openrouterViaMonkeyEnabled(): boolean {
  const raw = process.env.SAMWISE_BANANA_OPENROUTER_VIA_MONKEY?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

/** Inline JSON config that overrides Banana's `openrouter` provider to route
 *  through the monkey-models proxy. Passed to `banana serve` as
 *  BANANA_CONFIG_CONTENT.
 *
 *  If the parent environment already carries an inline Banana config
 *  (BANANA_CONFIG_CONTENT or its OPENCODE_CONFIG_CONTENT alias), the
 *  OpenRouter override is MERGED into it rather than replacing it wholesale,
 *  so operator-supplied providers/agents/permissions survive. A non-JSON or
 *  unparseable existing value is ignored (logged) and only the override is
 *  used — better than crashing the spawn. */
function bananaConfigContent(): string {
  const override = {
    $schema: 'https://banana-code.dev/config.json',
    provider: {
      openrouter: {
        options: {
          baseURL: MONKEY_BASE_URL,
          apiKey: resolveMonkeyToken(),
        },
      },
    },
  };

  const existingRaw = (
    process.env.BANANA_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT
  )?.trim();
  if (!existingRaw) return JSON.stringify(override);

  let existing: any;
  try {
    existing = JSON.parse(existingRaw);
  } catch {
    console.warn(
      '[banana-runner] existing BANANA_CONFIG_CONTENT is not valid JSON — ignoring it, using OpenRouter override only',
    );
    return JSON.stringify(override);
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return JSON.stringify(override);
  }

  // Merge so the existing config's other providers, and even openrouter's
  // own `models`/extra `options`, are kept — only baseURL + apiKey are
  // forced to the proxy values.
  const existingProvider =
    existing.provider && typeof existing.provider === 'object' ? existing.provider : {};
  const existingOpenrouter =
    existingProvider.openrouter && typeof existingProvider.openrouter === 'object'
      ? existingProvider.openrouter
      : {};
  const existingOptions =
    existingOpenrouter.options && typeof existingOpenrouter.options === 'object'
      ? existingOpenrouter.options
      : {};

  const merged: any = { ...existing, ...override };
  merged.provider = {
    ...existingProvider,
    openrouter: {
      ...existingOpenrouter,
      options: {
        ...existingOptions,
        ...override.provider.openrouter.options,
      },
    },
  };
  return JSON.stringify(merged);
}

const imageExtension = (mediaType: string): string => {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  const subtype = mediaType.split('/')[1]?.split('+')[0] ?? 'img';
  return subtype.replace(/[^a-z0-9]/gi, '') || 'img';
};

/** Split a model id on the FIRST '/': everything before is the providerID,
 *  the rest (joined back with '/') is the modelID. So `monkey/silverback`
 *  yields {monkey, silverback} and `openrouter/anthropic/claude-3.7-sonnet`
 *  yields {openrouter, anthropic/claude-3.7-sonnet}. Returns undefined when
 *  no model was supplied, so the prompt omits `model` and banana uses its
 *  own default. */
function parseModel(modelId?: string): { providerID: string; modelID: string } | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

// Plan ruleset, mirroring banana-cli-2 run.ts:359-375. Sent on session create
// so plan mode constrains the session to producing a plan (questions and
// plan enter/exit denied). Non-plan turns auto-approve permission requests.
const PLAN_RULESET = [
  { permission: 'question', action: 'deny' as const, pattern: '*' },
  { permission: 'plan_enter', action: 'deny' as const, pattern: '*' },
  { permission: 'plan_exit', action: 'deny' as const, pattern: '*' },
];

// ── BananaServer ─────────────────────────────────────────────────────────
//
// One per app process. Owns the persistent `banana serve` child, the shared
// SDK client, and the single global event subscription. All BananaSessions
// share it.

class BananaServer {
  private static instance: BananaServer | null = null;

  static get(): BananaServer {
    if (!BananaServer.instance) BananaServer.instance = new BananaServer();
    return BananaServer.instance;
  }

  private child: ChildProcess | null = null;
  private client: OpencodeClient | null = null;
  private port = 0;
  private password = '';
  /** Resolves once the serve process is reachable (stdout banner or config probe). */
  private readyPromise: Promise<void> | null = null;
  private dead = false;
  /** Restart backoff: each failed start pushes this out a little. */
  private restartAt = 0;
  /** bananaSessionID -> owning BananaSession, for SSE event fan-out. */
  private readonly routes = new Map<string, BananaSession>();
  /** directory -> live per-cwd SSE subscription (the v2 /event stream is
   *  directory-scoped, so one global subscription only sees one directory's
   *  events). `running` flips the loop off; `abort` cancels the in-flight
   *  SSE fetch so a loop parked in `reader.read()` on a quiet stream stops
   *  immediately instead of leaking until the next event. */
  private readonly subscriptions = new Map<
    string,
    { running: boolean; abort: AbortController }
  >();
  /** Bumped on every serve (re)start. Subscription loops capture it and exit
   *  cleanly when it changes, so a stale loop from a prior serve cannot keep
   *  routing events into a new serve's sessions. */
  private serveGeneration = 0;

  /** Lazy start. Resolves when the SDK client is usable. Restarts a dead
   *  server with a small backoff. On a failed start it clears the cached
   *  rejected promise (and kills any half-alive child) so the very next
   *  ensure() retries cleanly instead of returning the dead promise. */
  async ensure(): Promise<OpencodeClient> {
    if (this.client && !this.dead) {
      await this.readyPromise;
      return this.client;
    }
    if (this.dead) {
      const wait = this.restartAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.dead = false;
      this.child = null;
      this.client = null;
      this.readyPromise = null;
    }
    if (!this.readyPromise) this.readyPromise = this.start();
    try {
      await this.readyPromise;
    } catch (err) {
      // Start failed. Clear ALL cached state so the next ensure() restarts
      // through the backoff path instead of returning this same rejection
      // forever. markDead() handles the post-child-spawn failures, but a
      // synchronous throw before the child handlers are wired (pickFreePort,
      // spawn itself, createOpencodeClient) never reaches markDead, so do
      // the cleanup unconditionally here.
      if (!this.dead) {
        this.dead = true;
        this.restartAt = Date.now() + 2_000;
      }
      try { this.child?.kill('SIGTERM'); } catch {}
      const stuckChild = this.child;
      if (stuckChild) {
        setTimeout(() => { try { stuckChild.kill('SIGKILL'); } catch {} }, 2_000).unref?.();
      }
      this.child = null;
      this.client = null;
      this.readyPromise = null;
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!this.client) throw new Error('banana serve failed to start');
    return this.client;
  }

  /** Register a session so SSE events for its opencode sessionID reach it.
   *  Also ensures a per-directory SSE subscription exists for the session's
   *  cwd, since the v2 /event stream is directory-scoped. */
  register(bananaSessionID: string, session: BananaSession): void {
    this.routes.set(bananaSessionID, session);
    this.ensureSubscriptionFor(session.cwd);
  }

  /** Drop a route. No-op if a different session owns the id. Also stops the
   *  per-directory SSE subscription once no remaining route uses that cwd, so
   *  a dismissed / idled-out / fresh-started repo doesn't leak a live
   *  reconnecting event loop. */
  unregister(bananaSessionID: string, expected: BananaSession): void {
    if (this.routes.get(bananaSessionID) !== expected) return;
    const cwd = expected.cwd;
    this.routes.delete(bananaSessionID);
    // Any other session still on this cwd? If so, keep its subscription.
    for (const s of this.routes.values()) {
      if (s.cwd === cwd) return;
    }
    this.stopSubscription(cwd);
  }

  /** Stop one per-directory SSE subscription: flip its flag off, abort its
   *  in-flight fetch so a parked reader.read() unblocks immediately, and drop
   *  the map entry. */
  private stopSubscription(dir: string): void {
    const sub = this.subscriptions.get(dir);
    if (!sub) return;
    sub.running = false;
    try { sub.abort.abort(); } catch {}
    this.subscriptions.delete(dir);
  }

  /** Stop every per-directory SSE subscription. */
  private stopAllSubscriptions(): void {
    for (const dir of Array.from(this.subscriptions.keys())) {
      this.stopSubscription(dir);
    }
  }

  /** Build a directory-scoped client for a BananaSession's cwd. Shares the
   *  same baseUrl + auth header as the global client; only `directory`
   *  differs, so it can be cheaply created per session. */
  clientFor(cwd: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: `http://127.0.0.1:${this.port}`,
      directory: cwd,
      headers: { Authorization: this.authHeader() },
    });
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`banana:${this.password}`).toString('base64');
  }

  private async start(): Promise<void> {
    // New serve incarnation: bump the generation so any subscription loops
    // left over from a prior serve see the change and exit cleanly.
    this.serveGeneration += 1;
    // Pick ONE fixed free port for the whole server lifetime. We do NOT use
    // port 0 per spawn — the SDK clients need a stable baseUrl.
    this.port = await pickFreePort();
    this.password = randomBytes(24).toString('hex');
    const bin = resolveBananaBin();

    // Build the spawn env: always a random BANANA_SERVER_PASSWORD, and
    // (unless disabled) the BANANA_CONFIG_CONTENT override that routes the
    // `openrouter` provider through the monkey-models proxy.
    const serveEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BANANA_SERVER_PASSWORD: this.password,
    };
    if (openrouterViaMonkeyEnabled()) {
      serveEnv.BANANA_CONFIG_CONTENT = bananaConfigContent();
    }

    const child = spawn(
      bin,
      ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'],
      {
        // Never run unsecured: inject a random BANANA_SERVER_PASSWORD.
        env: serveEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.unref?.();

    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${this.port}`,
      headers: { Authorization: this.authHeader() },
    });
    this.client = client;

    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    let settled = false;
    const markReady = () => {
      if (settled) return;
      settled = true;
      resolveReady();
    };
    const markFailed = (e: Error) => {
      if (settled) {
        // Already up — a later death is handled by markDead/supervision.
        return;
      }
      settled = true;
      rejectReady(e);
    };

    // Readiness path 1: the serve banner on stdout.
    const banner = `Banana Code server listening on http://127.0.0.1:${this.port}`;
    let stdoutBuf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      if (stdoutBuf.includes(banner) || /server listening on http/i.test(stdoutBuf)) {
        markReady();
      }
      if (stdoutBuf.length > 16_000) stdoutBuf = stdoutBuf.slice(-4_000);
    });
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000);
    });

    child.on('error', (err) => {
      markFailed(new Error(`banana serve spawn failed: ${err.message}`));
      this.markDead();
    });
    child.on('close', (code, signal) => {
      const detail = stderrTail.trim();
      markFailed(
        new Error(
          `banana serve exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})` +
            (detail ? `: ${detail.slice(0, 300)}` : ''),
        ),
      );
      this.markDead();
    });

    // Readiness path 2: poll the config endpoint. Resolves the race where the
    // banner format changes or is buffered; whichever fires first wins.
    void (async () => {
      const deadline = Date.now() + 30_000;
      while (!settled && Date.now() < deadline) {
        try {
          const res = await client.config.get();
          if (res && !('error' in res && res.error)) {
            markReady();
            return;
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!settled) {
        markFailed(new Error('banana serve did not become reachable within 30s'));
        this.markDead();
      }
    })();

    await ready;
    // Server is up. Re-arm a per-directory event subscription for every cwd
    // that already has a routed session (e.g. resumed sessions registered
    // before the first send, or sessions that survived a serve restart).
    const dirs = new Set<string>();
    for (const s of this.routes.values()) dirs.add(s.cwd);
    for (const dir of dirs) this.ensureSubscriptionFor(dir);
  }

  /** Mark the server dead, schedule a backoff, and reject in-flight turns on
   *  every routed session with a synthetic error + turnEnd. */
  private markDead(): void {
    if (this.dead) return;
    this.dead = true;
    // Stop and abort every per-directory subscription loop.
    this.stopAllSubscriptions();
    this.restartAt = Date.now() + 2_000;
    try { this.child?.kill('SIGTERM'); } catch {}
    const stuckChild = this.child;
    if (stuckChild) {
      setTimeout(() => { try { stuckChild.kill('SIGKILL'); } catch {} }, 2_000).unref?.();
    }
    this.child = null;
    this.client = null;
    this.readyPromise = null;
    const orphans = Array.from(this.routes.values());
    this.routes.clear();
    for (const s of orphans) {
      s.failTurn('banana serve process died, restart will happen on the next message');
    }
  }

  /** Ensure a per-directory SSE subscription loop is running for `dir`. The
   *  v2 /event stream is directory-scoped: a subscription opened for one cwd
   *  only delivers events for sessions in that cwd, so each distinct session
   *  directory needs its own loop. Idempotent. */
  private ensureSubscriptionFor(dir: string): void {
    if (this.dead || !this.client) return;
    const existing = this.subscriptions.get(dir);
    if (existing && existing.running) return;
    const state = { running: true, abort: new AbortController() };
    this.subscriptions.set(dir, state);
    // Capture the generation so this loop exits if the serve process is
    // replaced underneath it.
    const generation = this.serveGeneration;
    void (async () => {
      while (
        state.running &&
        this.client &&
        !this.dead &&
        this.serveGeneration === generation
      ) {
        const client = this.client;
        try {
          // Pass the abort signal so a parked `reader.read()` on a quiet
          // stream is cancelled the instant the subscription is stopped.
          const events = await client.event.subscribe(
            { directory: dir },
            { signal: state.abort.signal },
          );
          for await (const event of events.stream as AsyncIterable<any>) {
            if (
              !state.running ||
              this.dead ||
              this.serveGeneration !== generation
            ) {
              break;
            }
            this.routeEvent(event);
          }
        } catch (err) {
          if (!state.running || this.serveGeneration !== generation) break;
          console.warn(`[banana] event stream error (${dir}):`, (err as Error).message);
        }
        // Stream ended (or errored). If the server is still meant to be alive
        // and this loop is still current, reconnect after a short pause.
        if (
          state.running &&
          !this.dead &&
          this.serveGeneration === generation
        ) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      // Loop is done. Drop ourselves from the map only if we're still the
      // registered entry (a fresh ensureSubscriptionFor may have replaced it).
      if (this.subscriptions.get(dir) === state) this.subscriptions.delete(dir);
    })();
  }

  /** Demux one SSE event to the owning BananaSession by sessionID. Strict:
   *  if we can't find a sessionID, or no session owns it, the event is
   *  dropped (it belongs to no chat we're driving). */
  private routeEvent(event: any): void {
    if (!event || typeof event !== 'object') return;
    const sid = extractSessionID(event);
    if (!sid) return;
    const session = this.routes.get(sid);
    if (!session) return;
    session.onServerEvent(event);
  }

  /** SIGTERM the serve child. Called on process exit / shutdownAllBananaSessions. */
  stop(): void {
    this.stopAllSubscriptions();
    this.dead = true;
    this.routes.clear();
    try { this.child?.kill('SIGTERM'); } catch {}
    const stuckChild = this.child;
    if (stuckChild) {
      setTimeout(() => { try { stuckChild.kill('SIGKILL'); } catch {} }, 2_000).unref?.();
    }
    this.child = null;
    this.client = null;
    this.readyPromise = null;
  }
}

/** Pull the opencode sessionID out of any v2 event shape. */
function extractSessionID(event: any): string | null {
  const p = event?.properties;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.sessionID === 'string') return p.sessionID;
  if (typeof p.part?.sessionID === 'string') return p.part.sessionID;
  if (typeof p.info?.sessionID === 'string') return p.info.sessionID;
  if (typeof p.info?.id === 'string' && event.type === 'session.created') return p.info.id;
  return null;
}

/** Bind a throwaway TCP server to port 0, read the assigned port, close it.
 *  Small TOCTOU window, but for a single fixed-port pick at startup it's
 *  acceptable and far simpler than scanning. */
async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error('could not allocate a free port'));
      });
    });
  });
}

// ── per-turn state ───────────────────────────────────────────────────────

type BlockKind = 'text' | 'reasoning';
type PartRecord = {
  index: number;
  kind: BlockKind;
  opened: boolean;
  closed: boolean;
  /** True once at least one streaming delta has been emitted for this block. */
  streamed: boolean;
};
type ToolRecord = {
  index: number;
  toolUseId: string;
  started: boolean;
  closed: boolean;
  /** JSON of the last tool input we emitted, so a later, more complete input
   *  snapshot can be re-emitted instead of silently dropped. */
  lastInputJson: string;
};

type BananaTurnState = {
  /** True once sdk.session.prompt has been accepted for THIS turn. A
   *  `session.status idle` event is only honored as turn completion after
   *  this flips, so a late/duplicate idle from the previous turn that lands
   *  in the create-prompt window cannot fake-complete the new turn. */
  promptAccepted: boolean;
  /** Synthetic id used in the claude-shaped `message_start` we emit. */
  messageId: string;
  /** The server-side assistant messageID this turn is anchored to. Set the
   *  first time we see an assistant message for the turn. Every later
   *  message.part.updated / message.part.delta whose messageID does not match
   *  is dropped: that is a stale event from a previous turn, or a second
   *  assistant message we are not normalizing. Null until the anchor lands. */
  anchorMessageId: string | null;
  nextBlockIndex: number;
  messageStarted: boolean;
  usage: BananaUsage | null;
  /** partID -> block bookkeeping. Built from message.part.updated events. */
  parts: Map<string, PartRecord>;
  /** partID -> tool block bookkeeping. */
  tools: Map<string, ToolRecord>;
  /** Deltas that arrived before their part-created event, keyed by partID. */
  bufferedDeltas: Map<string, string[]>;
  /** partID -> messageID, learned from message.part.updated. Lets us anchor
   *  a message.part.delta (which carries only partID) to its message. */
  partMessageIds: Map<string, string>;
};

// ── BananaSession ────────────────────────────────────────────────────────

export class BananaSession {
  readonly key: string;
  readonly cli: CliKind = 'banana';
  readonly cwd: string;
  readonly chatId: string;
  private listeners = new Set<Listener>();
  private subscriberCount = 0;
  private threadId: string | null = null;
  private busy = false;
  private dead = false;
  private eventLog: SeqEvent[] = [];
  private mirrorEvents = true;
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Banana doesn't need a warmup turn, ready immediately. */
  readonly ready: Promise<boolean> = Promise.resolve(true);

  /** Per-turn state, non-null only while a turn is in flight. */
  private turn: BananaTurnState | null = null;
  /** Every server-side assistant messageID this session has ever anchored a
   *  turn to. A new turn must NOT anchor to one of these: it would mean a
   *  stale event from a previous turn beat the new turn's real assistant
   *  message into the stream and would contaminate this turn's normalization.
   *  Bounded so a very long session can't grow it without limit. */
  private readonly seenMessageIds = new Set<string>();
  /** Stall watchdog for the current turn. */
  private watchdog: NodeJS.Timeout | null = null;
  /** Cleanup for the current turn's image temp dir. */
  private turnCleanup: (() => void) | null = null;
  /** Resolves when the in-flight turn settles, so send() can await it. */
  private turnDone: (() => void) | null = null;

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
          `[banana] restored ${restored.events.length} event(s) for ${this.key} (nextSeq=${this.nextSeq})`,
        );
      }
    } catch (err) {
      console.warn(`[banana] event-log restore failed for ${this.key}:`, (err as Error).message);
    }
    void compactEventLog(this.key);
    // If we already have a threadId from storage, register it now so events
    // for a resumed session route correctly even before the first send.
    if (this.threadId) BananaServer.get().register(this.threadId, this);
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

  shutdown(): void {
    if (this.dead) return;
    this.dead = true;
    this.disarmIdleTimer();
    this.clearWatchdog();
    this.turnCleanup?.();
    this.turnCleanup = null;
    // If a turn is in flight (stop / steer / tab-close while busy), abort it
    // on the server so the prompt actually stops, not just local state.
    if (this.busy && this.threadId) this.abortServerTurn();
    if (this.threadId) BananaServer.get().unregister(this.threadId, this);
    // Resolve any awaiting send() promise. Without this the WS handler that
    // did `await send()` leaks forever when the session is shut down mid-turn.
    this.busy = false;
    const done = this.turnDone;
    this.turnDone = null;
    this.turn = null;
    done?.();
    // Notify subscribers so the WS layer drops its sessionPromise and rebinds
    // on the next user send. Must emit BEFORE discardListeners so the WS layer
    // still receives the notification.
    this.emit({ type: 'closed', code: null, signal: 'SIGTERM' });
    this.discardListeners();
  }

  /** Best-effort abort of the in-flight server-side prompt. Fire-and-forget:
   *  the caller has already settled local turn state. */
  private abortServerTurn(): void {
    const sessionID = this.threadId;
    if (!sessionID) return;
    void (async () => {
      try {
        const sdk = BananaServer.get().clientFor(this.cwd);
        await sdk.session.abort({ sessionID });
      } catch {
        // serve may already be down, or the turn already finished, ignore.
      }
    })();
  }

  detachEventLog(): void {
    this.mirrorEvents = false;
  }

  discardListeners(): void {
    this.listeners.clear();
  }

  /** Called by BananaServer when the serve process dies mid-turn. Rejects the
   *  in-flight turn with a synthetic error + result + turnEnd. */
  failTurn(message: string): void {
    if (!this.busy || !this.turn) return;
    this.clearWatchdog();
    this.emit({ type: 'error', message });
    this.emitClaudeEvent({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: this.threadId ?? undefined,
      usage: this.turn.usage ?? undefined,
    });
    this.endTurn();
  }

  async send(text: string, opts?: SendOpts | ChatImage[]): Promise<void> {
    // Back-compat: v1 callers pass images as the second positional arg. The
    // WS layer is updated to pass a SendOpts object, but accept both.
    const sendOpts: SendOpts = Array.isArray(opts) ? { images: opts } : (opts ?? {});
    const images = sendOpts.images;

    if (this.busy) {
      this.emit({
        type: 'error',
        message: 'banana is still answering, wait for the current turn to finish',
      });
      return;
    }
    this.busy = true;
    // Echo for reconnect replay (banana's events don't re-emit the user prompt).
    this.emit({
      type: 'event',
      event: { type: '_user_echo', text, imageCount: images?.length ?? 0, ts: Date.now() },
    });

    let imageTempDir: string | null = null;
    const cleanupImages = () => {
      if (imageTempDir) void rm(imageTempDir, { recursive: true, force: true });
      imageTempDir = null;
    };
    this.turnCleanup = cleanupImages;

    // Write image attachments to temp files; banana's prompt parts reference
    // them by file:// URL (same way run.ts builds file parts).
    const fileParts: Array<{ type: 'file'; url: string; filename: string; mime: string }> = [];
    try {
      if (images?.length) {
        imageTempDir = await mkdtemp(join(tmpdir(), 'samwise-banana-images-'));
        for (const [index, image] of images.entries()) {
          if (!image.mediaType.startsWith('image/')) {
            throw new Error(`unsupported image media type: ${image.mediaType}`);
          }
          const path = join(imageTempDir, `image-${index + 1}.${imageExtension(image.mediaType)}`);
          await writeFile(path, Buffer.from(image.base64, 'base64'));
          fileParts.push({
            type: 'file',
            url: pathToFileURL(path).href,
            filename: `image-${index + 1}.${imageExtension(image.mediaType)}`,
            mime: image.mediaType,
          });
        }
      }
    } catch (e) {
      cleanupImages();
      this.turnCleanup = null;
      this.busy = false;
      this.emit({ type: 'error', message: `image preparation failed: ${(e as Error).message}` });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }

    // Plan mode: read at send time so a toggle takes effect on the next turn.
    const planMode = await getPlanMode('banana', this.cwd, this.chatId);

    // Initialize fresh per-turn state.
    this.turn = {
      promptAccepted: false,
      messageId: synth('msg'),
      anchorMessageId: null,
      nextBlockIndex: 0,
      messageStarted: false,
      usage: null,
      parts: new Map(),
      tools: new Map(),
      bufferedDeltas: new Map(),
      partMessageIds: new Map(),
    };

    try {
      const server = BananaServer.get();
      await server.ensure();
      const sdk = server.clientFor(this.cwd);

      // The permission ruleset for THIS turn. In plan mode, deny questions and
      // plan enter/exit so the session can only produce a plan. Out of plan
      // mode, no extra rules (permission requests are auto-approved live by
      // replyPermission). The ruleset is applied per turn so a plan-mode
      // toggle takes effect on the next message without recycling the session.
      const turnRuleset = planMode ? PLAN_RULESET : [];

      // Session: reuse the stored thread id, else create a new opencode
      // session.
      if (!this.threadId) {
        const created = await sdk.session.create({
          title: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
          permission: turnRuleset,
        });
        const newId = (created as any)?.data?.id;
        if (!newId || typeof newId !== 'string') {
          throw new Error('banana session.create returned no id');
        }
        this.threadId = newId;
        await setSessionId('banana', this.cwd, newId, this.chatId);
        this.emitClaudeEvent({ type: 'system', subtype: 'init', session_id: newId });
      } else {
        // Reused session: push the current ruleset so a plan-mode toggle
        // since the last turn actually takes effect.
        try {
          await sdk.session.update({ sessionID: this.threadId, permission: turnRuleset });
        } catch (e) {
          console.warn('[banana] session.update (plan ruleset) failed:', (e as Error).message);
        }
      }
      // Register the route so the SSE stream fans events back to us.
      server.register(this.threadId, this);

      // Arm the stall watchdog before firing the prompt.
      this.armWatchdog();

      // Fire the prompt. The streaming reply arrives via onServerEvent over the
      // shared SSE subscription. This call resolves when the request is
      // accepted, NOT when the turn finishes. We await it only to surface
      // request-level errors; turn completion is driven by session.status idle.
      const model = parseModel(sendOpts.model);
      const promptParams: Record<string, unknown> = {
        sessionID: this.threadId,
        parts: [...fileParts, { type: 'text', text }],
      };
      if (model) promptParams.model = model;

      const thisTurn = this.turn;
      const settle = new Promise<void>((resolve) => { this.turnDone = resolve; });
      await sdk.session.prompt(promptParams as any);
      // The prompt was accepted by the server. Mark THIS turn so a
      // session.status idle is now honored as completion (guarded against the
      // turn having already settled and been replaced). Until this flips, a
      // late/duplicate idle from the previous turn cannot fake-complete it.
      if (this.turn === thisTurn && thisTurn) thisTurn.promptAccepted = true;
      // Wait for the turn to settle (session.status idle / error / stall /
      // server death) so the WS layer's `await send()` stays correct.
      await settle;
    } catch (e) {
      this.clearWatchdog();
      this.emit({ type: 'error', message: `banana prompt failed: ${(e as Error).message}` });
      this.emitClaudeEvent({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: this.threadId ?? undefined,
        usage: this.turn?.usage ?? undefined,
      });
      this.endTurn();
    }
  }

  // ── SSE event handling ─────────────────────────────────────────────────

  /** Entry point for events fanned out by BananaServer. Already filtered to
   *  this session's sessionID. */
  onServerEvent(event: any): void {
    if (this.dead) return;
    // Any event for this session re-arms the stall watchdog.
    if (this.busy) this.bumpWatchdog();
    const state = this.turn;
    if (!state) return; // event arrived outside a turn, ignore

    const type: string = event?.type;
    const props = event?.properties ?? {};

    if (type === 'message.updated') {
      // We only normalize assistant messages. The FIRST assistant message of
      // the turn anchors it: its id becomes the turn's anchorMessageId, and
      // every later part event is matched against it. A second assistant
      // message with a different id (a continuation, a stale message from a
      // previous turn) is ignored so it can't contaminate this turn.
      const info = props.info;
      if (info?.role !== 'assistant') return;
      const messageID: unknown = info.id;
      if (typeof messageID !== 'string' || !messageID) return;
      if (state.anchorMessageId === null) {
        this.tryAnchor(state, messageID);
      } else if (messageID !== state.anchorMessageId) {
        // A second assistant message with a different id (a continuation, or
        // a stale message). Ignore it for this turn AND record it so a later
        // turn can never anchor to it via a delayed part event.
        this.rememberSeenMessageId(messageID);
      }
      return;
    }

    if (type === 'message.part.updated') {
      const part = props.part;
      const partMessageId: unknown = part?.messageID;
      // Every v2 Part carries a messageID. A part event without one cannot be
      // proven to belong to this turn, so drop it rather than risk replaying a
      // stale message's content.
      if (typeof partMessageId !== 'string' || !partMessageId) return;
      // Anchor lazily if the part event beat the message.updated event.
      if (state.anchorMessageId === null) {
        this.tryAnchor(state, partMessageId);
      }
      // Drop if still unanchored (the candidate was a stale messageID) or if
      // this part belongs to a different message.
      if (state.anchorMessageId === null) return;
      if (partMessageId !== state.anchorMessageId) {
        // Part for a different message. Remember its id so no future turn can
        // anchor to it via a delayed event.
        this.rememberSeenMessageId(partMessageId);
        return;
      }
      if (typeof part?.id === 'string' && part.id) {
        state.partMessageIds.set(part.id, partMessageId);
      }
      this.handlePartUpdated(state, part);
      return;
    }

    if (type === 'message.part.delta') {
      // Every v2 message.part.delta carries a messageID. One without it is
      // malformed and is dropped rather than risk replaying a stale message.
      const deltaMessageId: unknown = props.messageID;
      if (typeof deltaMessageId !== 'string' || !deltaMessageId) return;
      // A delta carries no message role, so it can only be trusted once the
      // turn is anchored to its real assistant message. Until then, drop
      // every delta. We deliberately do NOT record its messageID as seen:
      // a delta never drives anchoring (only message.updated / part.updated
      // do), and this delta's id MIGHT be the message this turn anchors to
      // moments later (the delta-before-anchor race). Recording it would
      // poison that legitimate anchor.
      if (state.anchorMessageId === null) return;
      if (deltaMessageId !== state.anchorMessageId) {
        // Delta for a different message. Remember the id so no future turn
        // can anchor to it, then drop the delta.
        this.rememberSeenMessageId(deltaMessageId);
        return;
      }
      this.handlePartDelta(state, props.partID, props.field, props.delta);
      return;
    }

    if (type === 'session.error') {
      const err = props.error;
      let message = 'banana reported an error';
      if (err) {
        if (typeof err === 'string') message = err;
        else if (err.data && typeof err.data.message === 'string') message = err.data.message;
        else if (typeof err.name === 'string') message = err.name;
      }
      // A session error ends the turn. Without this, busy/turn/turnDone stay
      // alive until the 120s stall watchdog fires and the UI hangs.
      this.clearWatchdog();
      this.flushOpenBlocks(state);
      this.emit({ type: 'error', message });
      this.emitClaudeEvent({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: this.threadId ?? undefined,
        usage: state.usage ?? undefined,
      });
      this.endTurn();
      return;
    }

    if (type === 'session.status' && props.status?.type === 'idle') {
      // Only honor idle as completion once this turn's prompt was accepted OR
      // the turn has anchored to a real assistant message. A late/duplicate
      // idle from the PREVIOUS turn can land after `this.turn` is created but
      // before the new prompt is accepted; treating it as completion would
      // fake-finish the turn and drop the real answer. Drop such an idle.
      if (!state.promptAccepted && state.anchorMessageId === null) return;
      // Turn end. Synthesize the claude `result` event with usage + turnEnd.
      // Do NOT touch the server or SSE, they stay alive for the next turn.
      this.clearWatchdog();
      this.flushOpenBlocks(state);
      this.emitClaudeEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: this.threadId ?? undefined,
        usage: state.usage ?? undefined,
      });
      this.endTurn();
      return;
    }

    if (type === 'permission.asked') {
      void this.replyPermission(props.id);
      return;
    }
  }

  /** Record a server-side messageID as "seen" so no future turn can anchor to
   *  it. Bounds the set so a long-lived session can't leak memory. */
  private rememberSeenMessageId(messageID: string): void {
    if (this.seenMessageIds.has(messageID)) return;
    this.seenMessageIds.add(messageID);
    // Keep only the most recent ids (Set preserves insertion order).
    if (this.seenMessageIds.size > 256) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
  }

  /** Try to anchor the current turn to `messageID`. Refuses to anchor to a
   *  messageID this session has already used in (or seen during) a prior
   *  turn: that is a stale event that beat the new turn's real assistant
   *  message into the SSE stream, and anchoring to it would replay an old
   *  message into this turn. On success it records the id and emits the
   *  synthetic message_start. */
  private tryAnchor(state: BananaTurnState, messageID: string): void {
    if (state.anchorMessageId !== null) return;
    if (this.seenMessageIds.has(messageID)) return; // stale message from a past turn
    state.anchorMessageId = messageID;
    this.rememberSeenMessageId(messageID);
    this.ensureMessageStarted(state);
  }

  /** Auto-reply to a permission request: `reject` in plan mode, `once` otherwise. */
  private async replyPermission(requestID: string): Promise<void> {
    if (!requestID) return;
    try {
      const planMode = await getPlanMode('banana', this.cwd, this.chatId);
      const sdk = BananaServer.get().clientFor(this.cwd);
      await sdk.permission.reply({
        requestID,
        reply: planMode ? 'reject' : 'once',
      });
    } catch (e) {
      this.emit({ type: 'error', message: `permission reply failed: ${(e as Error).message}` });
    }
  }

  /** Handle a message.part.updated event: open text/reasoning blocks, close
   *  them on time.end, and emit tool blocks. */
  private handlePartUpdated(state: BananaTurnState, part: any): void {
    if (!part || typeof part !== 'object') return;
    const partType: string = part.type;
    const partID: string = part.id;
    if (!partID) return;

    if (partType === 'text' || partType === 'reasoning') {
      this.ensureMessageStarted(state);
      let rec = state.parts.get(partID);
      if (!rec) {
        // New part -> open a content block at a fresh index.
        const idx = state.nextBlockIndex++;
        rec = {
          index: idx,
          kind: partType === 'reasoning' ? 'reasoning' : 'text',
          opened: false,
          closed: false,
          streamed: false,
        };
        state.parts.set(partID, rec);
      }
      if (!rec.opened) {
        rec.opened = true;
        // Both text and reasoning render as `text` content blocks: the
        // front-end reducer only understands `text` and `tool_use` blocks
        // (no dedicated thinking block), and v1 banana dropped reasoning
        // entirely. Streaming it as text is strictly better.
        this.emitClaudeEvent({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: rec.index,
            content_block: { type: 'text', text: '' },
          },
        });
        // Drain any deltas that arrived before this part-created event.
        const buffered = state.bufferedDeltas.get(partID);
        if (buffered && buffered.length) {
          for (const d of buffered) this.emitTextLikeDelta(rec, d);
          state.bufferedDeltas.delete(partID);
        }
      }
      // The part finished. If no delta ever streamed for it (the model
      // emitted the whole text in one part.updated snapshot), fall back to
      // the snapshot so the block isn't left empty. The reducer is
      // delta-additive, so we only do this when the block saw zero deltas.
      if (part.time?.end && !rec.closed) {
        if (!rec.streamed && typeof part.text === 'string' && part.text) {
          this.emitClaudeEvent({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: rec.index,
              delta: { type: 'text_delta', text: part.text },
            },
          });
        }
        rec.closed = true;
        this.emitClaudeEvent({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: rec.index },
        });
      }
      return;
    }

    if (partType === 'tool') {
      this.ensureMessageStarted(state);
      const status: string = part.state?.status;
      const toolName: string = typeof part.tool === 'string' ? part.tool : 'tool';
      let rec = state.tools.get(partID);
      if (status === 'running' || status === 'pending') {
        if (!rec) {
          const idx = state.nextBlockIndex++;
          rec = {
            index: idx,
            toolUseId: synth('tool'),
            started: false,
            closed: false,
            lastInputJson: '',
          };
          state.tools.set(partID, rec);
        }
        if (!rec.started) {
          rec.started = true;
          this.emitClaudeEvent({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: rec.index,
              content_block: { type: 'tool_use', id: rec.toolUseId, name: toolName },
            },
          });
        }
        // Emit the tool input as a single complete snapshot once it is
        // populated. opencode reports `pending` with an empty input first,
        // then `running` with the real input; the front-end reducer APPENDS
        // input_json_delta, so we can only emit it once and must wait until
        // it is non-empty. emitToolInput is idempotent and no-ops empties.
        this.emitToolInput(rec, part.state?.input);
        return;
      }
      if (status === 'completed' || status === 'error') {
        if (!rec) {
          // Tool finished without us ever seeing `running` — open it now.
          const idx = state.nextBlockIndex++;
          rec = {
            index: idx,
            toolUseId: synth('tool'),
            started: false,
            closed: false,
            lastInputJson: '',
          };
          state.tools.set(partID, rec);
          this.emitClaudeEvent({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: rec.index,
              content_block: { type: 'tool_use', id: rec.toolUseId, name: toolName },
            },
          });
          rec.started = true;
        }
        // Final input snapshot (covers the case where running never carried
        // a populated input, or never fired at all).
        this.emitToolInput(rec, part.state?.input);
        if (rec.closed) return;
        // Guarantee valid JSON input before the block closes.
        this.flushToolInput(rec);
        rec.closed = true;
        this.emitClaudeEvent({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: rec.index },
        });
        const isError = status === 'error';
        const output: string = isError
          ? typeof part.state?.error === 'string'
            ? part.state.error
            : 'tool failed'
          : typeof part.state?.output === 'string'
            ? part.state.output
            : part.state?.output != null
              ? JSON.stringify(part.state.output)
              : '';
        this.emitClaudeEvent({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: rec.toolUseId,
                is_error: isError || undefined,
                content: [{ type: 'text', text: output }],
              },
            ],
          },
        });
        return;
      }
      return;
    }

    if (partType === 'step-finish') {
      // Capture token usage. Same numbers v1 read off step_finish.
      const tokens = part.tokens;
      if (tokens && typeof tokens === 'object') {
        const t = tokens as Record<string, any>;
        const input = Number(t.input ?? 0);
        const output = Number(t.output ?? 0);
        const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
        state.usage = {
          input_tokens: Math.max(0, input),
          cache_read_input_tokens: Math.max(0, Number(cache.read ?? 0)),
          cache_creation_input_tokens: Math.max(0, Number(cache.write ?? 0)),
          output_tokens: Math.max(0, output),
        };
      }
      return;
    }
    // step-start, snapshot, patch, etc. — ignore.
  }

  /** Handle a message.part.delta: the token streaming v1 lacked. The event
   *  carries only partID + field + delta — no block index, no type. We look
   *  up the partID in the records the part.updated events built. If the delta
   *  arrives first (delta-before-part race), buffer it. */
  private handlePartDelta(
    state: BananaTurnState,
    partID: string | undefined,
    field: string | undefined,
    delta: string | undefined,
  ): void {
    if (!partID || typeof delta !== 'string') return;
    // Both text and reasoning deltas arrive with field === 'text'. Disambiguate
    // via the recorded part kind. Non-'text' fields (tool input etc.) ignored.
    if (field !== 'text') return;
    const rec = state.parts.get(partID);
    if (!rec || !rec.opened) {
      // Part-created event hasn't landed yet, buffer until it does.
      const buf = state.bufferedDeltas.get(partID) ?? [];
      buf.push(delta);
      state.bufferedDeltas.set(partID, buf);
      return;
    }
    this.emitTextLikeDelta(rec, delta);
  }

  /** Emit the tool input as one complete input_json_delta. The front-end
   *  reducer APPENDS partial_json, so this must run at most once with the
   *  final input. opencode emits `pending` with an empty `{}` input before
   *  `running` carries the real arguments, so we skip empty snapshots and
   *  only emit once a populated input lands (or, at completion, whatever the
   *  final input was). Idempotent: once emitted, never re-emitted. */
  private emitToolInput(rec: ToolRecord, input: unknown): void {
    if (rec.lastInputJson) return; // already emitted
    let json: string;
    try {
      json = JSON.stringify(input ?? {});
    } catch {
      json = '{}';
    }
    // Skip the empty placeholder so a later populated snapshot still wins.
    // (We DO emit '{}' at completion via flushToolInput so a genuinely
    //  argument-less tool still produces valid JSON.)
    if (json === '{}' || json === 'null') return;
    rec.lastInputJson = json;
    this.emitClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: rec.index,
        delta: { type: 'input_json_delta', partial_json: json },
      },
    });
  }

  /** Ensure a tool block has a valid JSON input emitted before it closes.
   *  If no populated input ever arrived, emit '{}' so the reducer's appended
   *  args parse cleanly. */
  private flushToolInput(rec: ToolRecord): void {
    if (rec.lastInputJson) return;
    rec.lastInputJson = '{}';
    this.emitClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: rec.index,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    });
  }

  /** Emit one streaming delta for a text or reasoning block. Reasoning is
   *  streamed as a text_delta too (see content_block_start note above). */
  private emitTextLikeDelta(rec: PartRecord, delta: string): void {
    if (rec.closed) return;
    rec.streamed = true;
    this.emitClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: rec.index,
        delta: { type: 'text_delta', text: delta },
      },
    });
  }

  /** Close any text/reasoning/tool blocks still open at turn end. Defensive:
   *  banana normally closes them via time.end, but a stall or abrupt idle can
   *  leave one dangling. */
  private flushOpenBlocks(state: BananaTurnState): void {
    for (const rec of state.parts.values()) {
      if (rec.opened && !rec.closed) {
        rec.closed = true;
        this.emitClaudeEvent({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: rec.index },
        });
      }
    }
    for (const rec of state.tools.values()) {
      if (rec.started && !rec.closed) {
        // Guarantee valid JSON input before the dangling block closes.
        this.flushToolInput(rec);
        rec.closed = true;
        this.emitClaudeEvent({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: rec.index },
        });
        this.emitClaudeEvent({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: rec.toolUseId,
                content: [{ type: 'text', text: 'tool did not report a result before the turn ended' }],
              },
            ],
          },
        });
      }
    }
  }

  // ── stall watchdog ──────────────────────────────────────────────────────

  private armWatchdog(): void {
    this.bumpWatchdog();
  }

  /** Re-arm the watchdog. Called on every event for the current turn. */
  private bumpWatchdog(): void {
    this.clearWatchdog();
    const ms = resolveStallTimeoutMs();
    this.watchdog = setTimeout(() => this.onStall(ms), ms);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Stall fired: abort the TURN only (error + result + turnEnd). The server
   *  and SSE stream stay alive. The server-side prompt is aborted too, so a
   *  stuck backend prompt does not keep running after we give up on it. */
  private onStall(ms: number): void {
    if (!this.busy || !this.turn) return;
    this.clearWatchdog();
    this.abortServerTurn();
    this.flushOpenBlocks(this.turn);
    this.emit({
      type: 'error',
      message: `banana stalled, no events for ${Math.round(ms / 1000)}s, aborted the turn`,
    });
    this.emitClaudeEvent({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: this.threadId ?? undefined,
      usage: this.turn.usage ?? undefined,
    });
    this.endTurn();
  }

  /** Settle the current turn: clear per-turn state, emit turnEnd, resolve the
   *  send() promise. Idempotent. */
  private endTurn(): void {
    this.clearWatchdog();
    this.turnCleanup?.();
    this.turnCleanup = null;
    this.turn = null;
    if (this.busy) {
      this.busy = false;
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
    }
    const done = this.turnDone;
    this.turnDone = null;
    done?.();
  }

  // ── event log plumbing ──────────────────────────────────────────────────

  private emit(msg: SessionEvent): void {
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.nextSeq++, ev: msg };
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
    removeFromBananaMap(this.key, this);
    this.shutdown();
  }

  /** Forward an event already in claude stream-json shape. */
  private emitClaudeEvent(event: any): void {
    this.emit({ type: 'event', event });
  }

  /** Lazily emit the synthetic claude `message_start` once per turn. */
  private ensureMessageStarted(state: BananaTurnState): void {
    if (state.messageStarted) return;
    state.messageStarted = true;
    this.emitClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: state.messageId, role: 'assistant' },
      },
    });
  }
}

// ── Session manager ──────────────────────────────────────────────────────

const bananaSessions = new Map<string, BananaSession>();

function keyOf(cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `banana|${cwd}` : `banana|${cwd}|${normalized}`;
}

/** Used by BananaSession.idleExpire to evict itself. No-op if a different
 *  session has since taken the key. */
function removeFromBananaMap(key: string, expected: BananaSession): void {
  if (bananaSessions.get(key) === expected) bananaSessions.delete(key);
}

export function activeBananaSessions(): {
  cli: CliKind;
  cwd: string;
  chatId: string;
  busy: boolean;
  sessionId: string | null;
  lastActivityAt: number;
}[] {
  return Array.from(bananaSessions.values()).map((s) => ({
    cli: 'banana',
    cwd: s.cwd,
    chatId: s.chatId,
    busy: s.isBusy(),
    sessionId: s.sessionId(),
    lastActivityAt: s.lastActivityAt(),
  }));
}

export function pruneIdleBananaSessions(ttlMs: number, now = Date.now()): number {
  let pruned = 0;
  for (const [key, session] of bananaSessions) {
    if (session.isBusy()) continue;
    if (session.listenerCount() > 0) continue;
    if (now - session.lastActivityAt() < ttlMs) continue;
    session.shutdown();
    bananaSessions.delete(key);
    pruned += 1;
  }
  return pruned;
}

export async function getOrCreateBananaSession(opts: {
  repoPath: string;
  chatId?: string;
}): Promise<BananaSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const key = keyOf(cwd, chatId);
  const existing = bananaSessions.get(key);
  if (existing && existing.isAlive()) return existing;

  const threadId = (await getSessionId('banana', cwd, chatId)) ?? null;
  const session = new BananaSession(cwd, chatId, threadId);
  bananaSessions.set(key, session);
  return session;
}

export function shutdownAllBananaSessions(): void {
  for (const s of bananaSessions.values()) s.shutdown();
  bananaSessions.clear();
  // SIGTERM the shared serve child too — no sessions left to use it.
  BananaServer.get().stop();
}

/** Kill the in-flight banana turn but keep the session id saved for resume. */
export function interruptBanana(opts: { repoPath: string; chatId?: string }): void {
  const cwd = opts.repoPath;
  const key = keyOf(cwd, opts.chatId);
  const s = bananaSessions.get(key);
  if (s) {
    s.shutdown();
    bananaSessions.delete(key);
  }
}

/** Drop the warm banana session but keep the saved session id so the next
 *  click resumes the conversation. Used by the user's manual "dismiss" button. */
export function dropBananaSession(opts: { repoPath: string; chatId?: string }): void {
  const cwd = opts.repoPath;
  const key = keyOf(cwd, opts.chatId);
  const s = bananaSessions.get(key);
  if (s) {
    s.shutdown();
    bananaSessions.delete(key);
  }
}

/** Persist the plan-mode flag for banana. Read fresh at send time, so the next
 *  turn picks it up without recycling the session. */
export async function setBananaPlanMode(opts: {
  repoPath: string;
  chatId?: string;
  enabled: boolean;
}): Promise<void> {
  await setPlanMode('banana', opts.repoPath, opts.enabled, opts.chatId || 'main');
}

/** Drop the stored session id so the next banana turn starts a fresh thread. */
export async function freshStartBanana(opts: {
  repoPath: string;
  chatId?: string;
}): Promise<BananaSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const key = keyOf(cwd, chatId);
  const existing = bananaSessions.get(key);
  if (existing) {
    existing.detachEventLog();
    existing.shutdown();
    bananaSessions.delete(key);
  }
  await clearEventLog(key);
  await setSessionId('banana', cwd, '', chatId);
  const session = new BananaSession(cwd, chatId, null);
  bananaSessions.set(key, session);
  return session;
}
