import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ASSISTANT_HUB_PATH, PORT } from './config.ts';
import { discoverRepos, gitBranch } from './repos.ts';
import { readChronicle } from './chronicle.ts';
import { readCommands } from './commands.ts';
import { ensureStateDir, getPlanMode, setSessionId } from './sessions.ts';
import { readStars, toggleStar } from './stars.ts';
import {
  getOrCreateSession,
  freshStart,
  interruptSession,
  dropSession,
  shutdownAllSessions,
  activeClaudeSessions,
  pruneIdleClaudeSessions,
  respondToToolForSession,
  setPlanModeForSession,
  refreshClaudeCredentials,
  type AnySession,
  type ClaudeSession,
  type CliKind,
} from './runner.ts';
import { resolveClaudeSelection } from './claude-models.ts';
import {
  shutdownAllCodexSessions,
  activeCodexSessions,
  pruneIdleCodexSessions,
  type CodexSession,
} from './codex-runner.ts';
import {
  shutdownAllBananaSessions,
  activeBananaSessions,
  listBananaOpenRouterModels,
  pruneIdleBananaSessions,
} from './banana-runner.ts';
import { basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, '..', '..', 'dist');
const IDLE_SESSION_TTL_MS = 30 * 60 * 1000;
// Backstop reaper. Per-session self-expiry timers (runner.ts/codex-runner.ts)
// are the primary cleanup mechanism; this catches any session that somehow
// slips its timer (process state corruption, etc.).
const IDLE_REAPER_INTERVAL_MS = 30 * 1000;
const RESUME_STARTUP_WATCH_MS = 8000;
const DEFAULT_CHAT_ID = 'main';

function normalizeChatId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CHAT_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_CHAT_ID;
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return safe || DEFAULT_CHAT_ID;
}

await ensureStateDir();

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/repos', async (_req, res) => {
  try {
    const repos = await discoverRepos();
    res.json({ repos });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.get('/api/stars', async (_req, res) => {
  try {
    const set = await readStars();
    res.json({ paths: Array.from(set).sort() });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.post('/api/stars/toggle', async (req, res) => {
  const path = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!path) {
    res.status(400).json({ error: 'path required' });
    return;
  }
  try {
    const starred = await toggleStar(path);
    res.json({ path, starred });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.get('/api/branch', async (req, res) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path) {
    res.status(400).json({ error: 'path required' });
    return;
  }
  try {
    const branch = await gitBranch(path);
    res.json({ branch: branch ?? null });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.get('/api/live', (_req, res) => {
  const sessions = [
    ...activeClaudeSessions(),
    ...activeCodexSessions(),
    ...activeBananaSessions(),
  ];
  res.json({
    sessions: sessions.map((s) => ({
      cli: s.cli,
      cwd: s.cwd,
      repoName: basename(s.cwd),
      chatId: s.chatId,
      busy: s.busy,
      sessionId: s.sessionId,
      lastActivityAt: s.lastActivityAt,
    })),
  });
});

app.get('/api/banana/models', async (_req, res) => {
  try {
    res.json({ data: await listBananaOpenRouterModels() });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.get('/api/chronicle', async (_req, res) => {
  try {
    const events = await readChronicle();
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.post('/api/session/activate', async (req, res) => {
  const cli = req.body?.cli as CliKind | undefined;
  const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd : '';
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  const chatId = normalizeChatId(req.body?.chatId);
  if (!cli || !cwd || !sessionId) {
    res.status(400).json({ error: 'cli, cwd, and sessionId required' });
    return;
  }
  if (cli !== 'claude' && cli !== 'assistant') {
    res.status(400).json({ error: 'only claude-backed sessions can be activated' });
    return;
  }
  try {
    // Match warm sessions by (cli, cwd, sessionId) regardless of chatId. If
    // the user clicks a chronicle row for a session that's already warm under
    // a different chatId (most commonly the same repo's `main` live chat), we
    // need to kill that warm process — otherwise the next ws bind spawns a
    // second `claude --resume <sessionId>` and we end up with two agents
    // running tools against the same conversation/worktree.
    const matches = activeClaudeSessions().filter(
      (s) => s.cli === cli && s.cwd === cwd && s.sessionId === sessionId,
    );
    const exactMatch = matches.find(
      (s) => (s.chatId || DEFAULT_CHAT_ID) === chatId,
    );
    if (!exactMatch) {
      for (const stale of matches) {
        await dropSession(cli, cwd, stale.chatId || DEFAULT_CHAT_ID);
      }
      await dropSession(cli, cwd, chatId);
    }
    await setSessionId(cli, cwd, sessionId, chatId);
    res.json({ ok: true, chatId });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// Manual "dismiss" — kills the warm process for a (cli, cwd) pair so it stops
// showing on the awake-now strip. The saved session_id is preserved so the
// next rejoin from chronicle picks the conversation back up.
app.post('/api/session/dismiss', async (req, res) => {
  const cli = req.body?.cli as CliKind | undefined;
  const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd : '';
  const chatId = normalizeChatId(req.body?.chatId);
  if (!cli || !cwd) {
    res.status(400).json({ error: 'cli and cwd required' });
    return;
  }
  try {
    await dropSession(cli, cwd, chatId);
    res.json({ ok: true, chatId });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

app.get('/api/commands', async (_req, res) => {
  try {
    const commands = await readCommands();
    res.json(commands);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// Production: serve the built frontend from samwise-2/dist if it exists.
// In dev, Vite serves on :5173 and proxies /api here, so this branch is unused.
if (existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/sam.png')) return next();
    res.sendFile(resolve(STATIC_DIR, 'index.html'));
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/api/ws' });

type ClientHello = {
  type: 'hello';
  cli: CliKind;
  repo: string;
  chatId?: string;
  sinceSeq?: number;
};
type ClientSend = {
  type: 'send';
  chatId?: string;
  text: string;
  images?: Array<{ mediaType: string; base64: string }>;
  /** Chosen model id. Banana/Codex apply it per turn; Claude/assistant spawn
   *  with it (a change recycles the warm process). */
  model?: string;
  /** Reasoning effort. Codex applies it per turn; Claude/assistant spawn with it. */
  effort?: string;
};
type ClientFresh = { type: 'freshStart'; cli: CliKind; repo: string; chatId?: string };
type ClientStop = { type: 'stop'; cli: CliKind; repo: string; chatId?: string };
type ClientSteer = {
  type: 'steer';
  cli: CliKind;
  repo: string;
  chatId?: string;
  text: string;
  images?: Array<{ mediaType: string; base64: string }>;
  /** Chosen model id. Banana/Codex apply it per turn; Claude/assistant spawn
   *  with it (a change recycles the warm process). */
  model?: string;
  /** Reasoning effort. Codex applies it per turn; Claude/assistant spawn with it. */
  effort?: string;
};
type ClientToolResponse = {
  type: 'toolResponse';
  cli: CliKind;
  repo: string;
  chatId?: string;
  toolUseId: string;
  content: string;
};
type ClientCompact = {
  type: 'compact';
  cli?: CliKind;
  repo?: string;
  chatId?: string;
  /** Current picker choice, so a compact can recycle the warm process to the
   *  model the user is looking at (same rule as send). */
  model?: string;
  effort?: string;
  /** Optional focus for the summary, e.g. "/compact keep the API notes". */
  instructions?: string;
};
type ClientSetPlanMode = {
  type: 'setPlanMode';
  cli: CliKind;
  repo: string;
  chatId?: string;
  enabled: boolean;
};
type ClientMsg =
  | ClientHello
  | ClientSend
  | ClientFresh
  | ClientStop
  | ClientSteer
  | ClientToolResponse
  | ClientCompact
  | ClientSetPlanMode;

type ResumeWatchableSession = AnySession & {
  startedWithResume?: () => boolean;
  waitForInitOrExit?: (timeoutMs: number) => Promise<'initialized' | 'closed' | 'timeout'>;
};

let wsCounter = 0;

wss.on('connection', (ws, req) => {
  const wsId = ++wsCounter;
  const peer = (req.headers['x-forwarded-for'] as string | undefined) ?? req.socket.remoteAddress ?? '?';
  console.log(`[ws#${wsId}] open from ${peer}`);

  // Heartbeat liveness flag. The interval below pings every client every
  // ~25s; the browser auto-replies with pong, which flips this back to true.
  // If two ping cycles pass without a pong, the underlying TCP is dead
  // (NAT/Tailscale/sleep) and we terminate the socket so the client's
  // onclose handler can fire and trigger a fresh reconnect. Without this,
  // a silently dead WS leaves the chat stuck with "thinking" dots while
  // the server has long since emitted turnEnd.
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });

  // Stored as a promise so sends arriving while the spawn is still in flight
  // can `await` it instead of failing with "no session — send hello first".
  let sessionPromise: Promise<AnySession> | null = null;
  let unsubscribe: (() => void) | null = null;
  let busy = false;
  /** A compact was accepted on this socket but its turnStart has not landed
   *  yet. Without this, a message sent in that gap reaches the session after
   *  /compact and the two turns interleave. */
  let compacting = false;
  let cliKind: CliKind | null = null;
  let repoPath: string | null = null;
  let chatId = DEFAULT_CHAT_ID;
  let turnGeneration = 0;
  // Monotonic generation for bindSession. The latest call always wins
  // regardless of resolve order — fixes a race where two overlapping binds
  // could land subscriptions out of order, leaving the WS subscribed to
  // session A while sessionPromise pointed at session B (cross-repo bleed).
  let bindGen = 0;
  let activeBindGen = 0;
  let activeSessionKey: string | null = null;
  let activeSession: AnySession | null = null;

  // ── OAuth auto-recovery ──────────────────────────────────────────────────
  // The warm claude child holds an OAuth token from spawn time. When another
  // concurrent claude process rotates the shared refresh token, this child's
  // next refresh fails ("OAuth session expired…"). The disk credentials are
  // almost always still fresh, so on a fatal auth error we respawn from disk
  // and replay the in-flight turn ONCE — the user never sees the failure.
  // Bounded per-turn so genuinely-dead disk creds surface a real error instead
  // of looping. Only the persistent claude/assistant runners use this (codex
  // and banana are spawn-per-turn with separate auth).
  let inflightTurn: {
    text: string;
    images?: Array<{ mediaType: string; base64: string }>;
    model?: string;
    effort?: string;
  } | null = null;
  let authReplayArmed = false; // a fatal auth error was seen this turn; replay pending on close
  let authReplayDone = false;  // already replayed once this turn; don't loop

  const safeSend = (msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  /** The canonical session_id for whatever session is currently bound to
   *  this WS, or null if none. Read fresh on every send so we pick up the
   *  id once init arrives mid-turn. */
  const currentSessionId = (): string | null => activeSession?.sessionId() ?? null;

  // Bind to a session and subscribe this WebSocket to its event stream.
  // Returns null when a newer bindSession call has superseded this one
  // during the await — callers MUST bail in that case so they don't send
  // stale `ready`/`turnStart`/`freshStarted` events or mutate `busy` for
  // the wrong session.
  const bindSession = async (
    promise: Promise<AnySession>,
    sinceSeq: number = -1,
  ): Promise<AnySession | null> => {
    const myGen = ++bindGen;
    sessionPromise = promise;
    const session = await promise;
    if (myGen !== bindGen) {
      // A newer bindSession superseded us during the await. The newer call
      // owns the subscription AND the response to the client.
      return null;
    }
    unsubscribe?.();
    activeBindGen = myGen;
    const sessionKey = session.key;
    activeSessionKey = sessionKey;
    activeSession = session;

    const dispatch = (se: { seq: number; ev: any; ts?: number }) => {
      // Defensive: if a newer binding has taken over since this listener was
      // attached but unsubscribe hasn't run yet, drop the event.
      if (activeBindGen !== myGen) return;
      const sev = se.ev;
      const sessionId = session.sessionId();
      if (sev.type === 'event') {
        safeSend({
          type: 'stream',
          event: sev.event,
          seq: se.seq,
          sessionKey,
          sessionId,
          chatId,
          // Block timestamps: replayed events keep the moment they were
          // emitted so a reload doesn't restamp history. Older log lines
          // predate this field and go out unstamped (the client shows no
          // time) rather than claiming they happened at page load.
          ...(typeof se.ts === 'number' ? { ts: se.ts } : {}),
        });
      } else if (sev.type === 'turnEnd') {
        busy = false;
        // Turn completed (including after a successful auth-recovery replay) —
        // clear the in-flight turn so it can't be replayed again.
        inflightTurn = null;
        authReplayArmed = false;
        authReplayDone = false;
        safeSend({
          type: 'turnEnd',
          sessionId: sev.sessionId ?? sessionId,
          seq: se.seq,
          sessionKey,
          chatId,
        });
      } else if (sev.type === 'error') {
        const authFatal = sev.fatal === true && (sev.code === 'oauth' || sev.code === '401');
        // Seamless OAuth recovery: arm a one-shot respawn+replay and SUPPRESS
        // the raw error so the user never sees it. The replay fires from the
        // `closed` branch below, once the stale child has been reaped (so two
        // `claude --resume` processes never race the same session id). Only for
        // the persistent claude/assistant runners with a turn to replay, and
        // only once per turn (authReplayDone) so dead disk creds can't loop.
        if (
          authFatal && !authReplayDone && inflightTurn &&
          (cliKind === 'claude' || cliKind === 'assistant')
        ) {
          authReplayArmed = true;
          console.log(`[ws#${wsId}] armed OAuth auto-recovery (code=${sev.code})`);
          return;
        }
        // Recovery already spent this turn and it STILL can't authenticate — the
        // source login is genuinely dead (keepalive couldn't heal it). Surface
        // an actionable message and end the turn ourselves: the runner suppresses
        // turnEnd on fatal-auth results, so without this the spinner would hang.
        if (authFatal && authReplayDone) {
          busy = false;
          inflightTurn = null;
          authReplayArmed = false;
          safeSend({
            type: 'error',
            message: 'Claude could not authenticate even after reconnecting. Its login has expired on the server — open a terminal on the host and run `claude`, then `/login`.',
            seq: se.seq, sessionKey, sessionId, chatId,
          });
          safeSend({ type: 'turnEnd', sessionKey, sessionId, chatId });
          return;
        }
        // Fatal errors must ALWAYS reach the client — even when no turn is in
        // flight — otherwise the chat dies silently. Only harmless idle stderr
        // chatter is swallowed.
        if (busy || sev.fatal) {
          safeSend({ type: 'error', message: sev.message, seq: se.seq, sessionKey, sessionId, chatId });
          // NB: do NOT clear `busy` here. failAuth()'s deferred shutdown fires a
          // `closed` event next; the closed branch only emits `sessionClosed`
          // (which clears the client spinner in ~250ms) while `busy` is true.
          // Zeroing busy would swallow it and strand the spinner until the 45s
          // silence watchdog.
        } else {
          console.log(`[ws#${wsId}] swallowed idle stderr: ${String(sev.message).slice(0, 200)}`);
        }
      } else if (sev.type === 'closed') {
        // Suppress the closed event entirely if a newer bindSession is in
        // flight (or already won). The new bind's freshStarted/ready owns the
        // user's view, and clearing sessionPromise here would null out the
        // *new* promise that line 214 just installed. Pre-existing latent
        // race for claude (child exits asynchronously after SIGTERM); now
        // also exercised by codex since CodexSession.shutdown emits closed.
        if (bindGen !== myGen) return;
        // OAuth auto-recovery: the stale child is now reaped, so it's safe to
        // respawn from fresh disk creds and replay the in-flight turn. Skip the
        // sessionClosed notice — the replay's rebound/turnStart drives the UI,
        // so the user sees a brief pause then their answer, no error.
        if (authReplayArmed && !authReplayDone) {
          sessionPromise = null;
          activeSessionKey = null;
          activeSession = null;
          unsubscribe?.();
          unsubscribe = null;
          void replayAfterAuthRecovery();
          return;
        }
        if (busy) {
          safeSend({ type: 'sessionClosed', code: sev.code, seq: se.seq, sessionKey, sessionId, chatId });
        } else {
          console.log(`[ws#${wsId}] swallowed idle session close (code=${sev.code})`);
        }
        sessionPromise = null;
        busy = false;
        compacting = false;
        activeSessionKey = null;
        activeSession = null;
        unsubscribe?.();
        unsubscribe = null;
      }
    };

    unsubscribe = session.subscribe(dispatch, sinceSeq);
    return session;
  };

  // Respawn a fresh claude child (re-reads credentials from disk) and replay
  // the in-flight turn after an OAuth auth failure. Called from the session's
  // `closed` handler once the stale child is reaped, so two `claude --resume`
  // processes never race the same session id. Bounded by authReplayDone so a
  // genuinely-dead disk credential surfaces a real error instead of looping.
  const replayAfterAuthRecovery = async (): Promise<void> => {
    if (authReplayDone || !authReplayArmed) return;
    if (!inflightTurn || !cliKind || !repoPath) return;
    if (cliKind === 'codex' || cliKind === 'banana') return;
    authReplayArmed = false;
    authReplayDone = true;
    const turn = inflightTurn;
    const gen = turnGeneration;
    console.log(`[ws#${wsId}] OAuth auto-recovery: re-syncing creds, respawning + replaying turn`);
    // Re-sync fresh tokens into CLAUDE_CONFIG_DIR before respawning. Without
    // this the fresh child re-reads the same blanked creds and fails again —
    // this is the step that actually clears the recurring outage.
    await refreshClaudeCredentials();
    if (gen !== turnGeneration) return;     // user moved on during the refresh
    try {
      // Respawn with the turn's model/effort so recovery keeps the picker choice.
      const session = await bindSession(getOrCreateSession({
        cli: cliKind, repoPath, chatId, model: turn.model, effort: turn.effort,
      }));
      if (!session) return;                 // superseded by a newer bind
      if (gen !== turnGeneration) return;   // user moved on (stop / steer / switch)
      busy = true;
      const sid = session.sessionId();
      safeSend({ type: 'sessionRebound', sessionKey: session.key, sessionId: sid, chatId });
      safeSend({ type: 'turnStart', sessionKey: session.key, sessionId: sid, chatId });
      if ('send' in session) (session as any).send(turn.text, turn.images);
      // If this fresh child ALSO fails auth, its fatal error lands with
      // authReplayDone === true, so the error branch surfaces the actionable
      // "run /login" message instead of looping.
    } catch (e) {
      busy = false;
      console.warn(`[ws#${wsId}] auth recovery failed:`, (e as Error).message);
      safeSend({ type: 'error', message: `Could not re-authenticate Claude: ${(e as Error).message}` });
      if (activeSessionKey) {
        safeSend({ type: 'turnEnd', sessionKey: activeSessionKey, sessionId: currentSessionId(), chatId });
      }
    }
  };

  // Watchdog for the first message of a session: if the freshly-spawned claude
  // never initializes after we write to stdin — either by exiting OR by
  // sitting silent past the watch window — drop it and respawn fresh so the
  // message can land. Root cause: runner.ts's quiet-ready timer resolves
  // session.ready optimistically at 2s, but on a slow cold start (OS wake,
  // busy disk, large codebase) claude may not be reading stdin yet, and the
  // write is buffered into the void. Without this retry the user sees their
  // bubble with no response, forever. Once init has been seen this is a
  // no-op — waitForInitOrExit resolves 'initialized' immediately for warm
  // sessions, so we only pay the await on first sends.
  const retryOnceIfFirstSendStuck = async (
    session: AnySession,
    text: string,
    generation: number,
    images?: Array<{ mediaType: string; base64: string }>,
  ): Promise<boolean> => {
    if (!cliKind || !repoPath || cliKind === 'codex' || cliKind === 'banana') return false;
    const watchable = session as ResumeWatchableSession;
    if (!watchable.waitForInitOrExit) return false;

    const state = await watchable.waitForInitOrExit(RESUME_STARTUP_WATCH_MS);
    if (state === 'initialized') return false;
    if (generation !== turnGeneration) return false;

    console.log(`[ws#${wsId}] first send ${state} after ${RESUME_STARTUP_WATCH_MS}ms, retrying with fresh process`);

    // For a hung process (timeout), spawnSession's internal retry can't help
    // because session.ready already resolved true via the quiet-ready timer.
    // Drop the zombie manually and clear any stored session_id — if a resume
    // hangs once it's likely to hang again, better to lose continuity than
    // stay stuck. The 'closed' branch falls through to getOrCreateSession,
    // which goes through spawnSession's own stale-id retry path.
    if (state === 'timeout') {
      try { await dropSession(cliKind, repoPath, chatId); } catch {}
      const cwd = cliKind === 'assistant' ? ASSISTANT_HUB_PATH : repoPath;
      try { await setSessionId(cliKind, cwd, '', chatId); } catch {}
    }

    try {
      const retrySession = await bindSession(getOrCreateSession({ cli: cliKind, repoPath, chatId }));
      if (!retrySession) return false;  // superseded by a newer bind
      busy = true;
      const retrySid = retrySession.sessionId();
      safeSend({ type: 'sessionRebound', sessionKey: retrySession.key, sessionId: retrySid, chatId });
      safeSend({ type: 'turnStart', sessionKey: retrySession.key, sessionId: retrySid, chatId });
      if (retrySession && 'send' in retrySession) (retrySession as any).send(text, images);
      return true;
    } catch (e) {
      console.warn(`[ws#${wsId}] first-send retry failed:`, (e as Error).message);
      busy = false;
      safeSend({ type: 'error', message: String((e as Error).message) });
      // turnEnd needs a sessionKey to pass the frontend bleed guard. If we
      // have no active session here, there's no chat-affecting turnEnd to
      // emit — the client will see the error and recover.
      if (activeSessionKey) {
        safeSend({ type: 'turnEnd', sessionKey: activeSessionKey, sessionId: currentSessionId(), chatId });
      }
      return false;
    }
  };

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      safeSend({ type: 'error', message: 'invalid JSON' });
      return;
    }

    if (msg.type === 'hello') {
      cliKind = msg.cli;
      repoPath = msg.repo;
      chatId = normalizeChatId(msg.chatId);
      const sinceSeq = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : -1;
      console.log(`[ws#${wsId}] hello cli=${msg.cli} repo=${msg.repo} chatId=${chatId} sinceSeq=${sinceSeq}`);
      try {
        const session = await bindSession(
          getOrCreateSession({ cli: msg.cli, repoPath: msg.repo, chatId }),
          sinceSeq,
        );
        compacting = false;
        if (!session) {
          // Superseded by a newer bind; that newer call will send `ready`.
          return;
        }
        // If we're attaching to a session that's mid-turn, tell the client so
        // its status flips to 'streaming' instead of stale 'ready'. Otherwise
        // a phone unlock during a long Sam turn looks like nothing's happening.
        const sessionBusy = (session as any).isBusy?.() === true;
        if (sessionBusy) busy = true;
        const cwdForPlan = msg.cli === 'assistant' ? ASSISTANT_HUB_PATH : msg.repo;
        const planMode = await getPlanMode(msg.cli, cwdForPlan, chatId);
        console.log(`[ws#${wsId}] session ready key=${session.key} latestSeq=${session.latestSeq()} busy=${sessionBusy} plan=${planMode}`);
        // Claude/assistant sessions are spawned at a fixed model + effort;
        // Codex reports the model its last turn actually ran. Report either so
        // a browser that has never seen this chat (Matt's phone) shows the
        // truth instead of its own stored default. Banana has no effort
        // ladder and reports nothing.
        const spawnedModel = (session as any).model;
        const spawnedEffort = (session as any).effort;
        safeSend({
          type: 'ready',
          cli: msg.cli,
          repo: msg.repo,
          chatId,
          latestSeq: session.latestSeq(),
          busy: sessionBusy,
          sessionKey: session.key,
          sessionId: session.sessionId(),
          planMode,
          ...(typeof spawnedModel === 'string' ? { model: spawnedModel } : {}),
          ...(typeof spawnedEffort === 'string' ? { effort: spawnedEffort } : {}),
        });
      } catch (e) {
        console.error(`[ws#${wsId}] hello failed:`, (e as Error).message);
        sessionPromise = null;
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'steer') {
      console.log(`[ws#${wsId}] steer cli=${msg.cli} bytes=${msg.text.length}`);
      if (compacting) {
        safeSend({ type: 'error', message: 'Sam is compacting. One moment, then send.' });
        return;
      }
      try {
        turnGeneration += 1;
        chatId = normalizeChatId(msg.chatId ?? chatId);
        await interruptSession({ cli: msg.cli, repoPath: msg.repo, chatId });
        cliKind = msg.cli;
        repoPath = msg.repo;
        // Spin up a fresh session immediately and fire the new prompt at it.
        // model/effort spawn Claude at the chosen tier (ignored by codex/banana).
        const session = await bindSession(
          getOrCreateSession({
            cli: msg.cli, repoPath: msg.repo, chatId, model: msg.model, effort: msg.effort,
          }),
        );
        if (!session) return;  // superseded; newer bind drives the next turn
        busy = true;
        safeSend({ type: 'turnStart', sessionKey: session.key, sessionId: session.sessionId(), chatId });
        if ('send' in session) {
          if (msg.cli === 'banana') {
            await (session as any).send(msg.text, { images: msg.images, model: msg.model });
          } else if (msg.cli === 'codex') {
            await (session as any).send(msg.text, {
              images: msg.images,
              model: msg.model,
              effort: msg.effort,
            });
          } else {
            // Claude/assistant only: record the turn (with its model/effort) so
            // OAuth auto-recovery can replay it, and reset the per-turn one-shot
            // recovery guards. The session was just spawned at this model above.
            inflightTurn = { text: msg.text, images: msg.images, model: msg.model, effort: msg.effort };
            authReplayArmed = false;
            authReplayDone = false;
            (session as any).send(msg.text, msg.images);
            void retryOnceIfFirstSendStuck(session, msg.text, turnGeneration, msg.images);
          }
        }
      } catch (e) {
        console.error(`[ws#${wsId}] steer failed:`, (e as Error).message);
        busy = false;
        safeSend({ type: 'error', message: String((e as Error).message) });
        if (activeSessionKey) {
          safeSend({ type: 'turnEnd', sessionKey: activeSessionKey, sessionId: currentSessionId(), chatId });
        }
      }
      return;
    }

    if (msg.type === 'stop') {
      console.log(`[ws#${wsId}] stop cli=${msg.cli} repo=${msg.repo}`);
      try {
        turnGeneration += 1;
        chatId = normalizeChatId(msg.chatId ?? chatId);
        // Snapshot the active key/sessionId BEFORE we tear down so the
        // turnEnd we emit carries them and the frontend's bleed guard lets it
        // through.
        const stopKey = activeSessionKey;
        const stopSid = currentSessionId();
        await interruptSession({ cli: msg.cli, repoPath: msg.repo, chatId });
        busy = false;
        // Stopped turn: never auto-replay it.
        inflightTurn = null;
        authReplayArmed = false;
        authReplayDone = false;
        if (stopKey) {
          safeSend({ type: 'turnEnd', sessionKey: stopKey, sessionId: stopSid, chatId });
        }
        cliKind = msg.cli;
        repoPath = msg.repo;
        sessionPromise = null;
        activeSessionKey = null;
        activeSession = null;
        unsubscribe?.();
        unsubscribe = null;
      } catch (e) {
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'compact') {
      console.log(`[ws#${wsId}] compact cli=${cliKind} busy=${busy} session=${activeSessionKey ?? 'none'}`);
      // Manual compact. Claude runs its own in-session /compact; Codex runs the
      // TUI's compaction through its app server. Banana has no equivalent.
      if (cliKind !== 'claude' && cliKind !== 'assistant' && cliKind !== 'codex') {
        safeSend({ type: 'error', message: 'this companion cannot compact a chat' });
        return;
      }
      if (busy || compacting) {
        console.log(`[ws#${wsId}] compact rejected: socket busy`);
        safeSend({ type: 'error', message: 'Sam is mid-turn. Let him finish, then compact.' });
        return;
      }
      // Claim the gap before the awaits. Released the moment turnStart makes
      // `busy` true, or on any failure below.
      compacting = true;
      if (!sessionPromise && cliKind && repoPath) {
        try {
          const bound = await bindSession(getOrCreateSession({ cli: cliKind, repoPath, chatId }));
          if (!bound) {
            // Superseded by a newer bind; it owns the socket now.
            compacting = false;
            return;
          }
        } catch (e) {
          // Nothing will ever make this turn start, so the latch must not stay
          // closed: every later send on this socket would be refused.
          compacting = false;
          safeSend({ type: 'error', message: String((e as Error).message) });
          return;
        }
      }
      if (!sessionPromise) {
        compacting = false;
        safeSend({ type: 'error', message: 'no session, send hello first' });
        return;
      }
      try {
        let session: AnySession | null = await sessionPromise;
        if (!session && cliKind && repoPath) {
          session = await bindSession(getOrCreateSession({ cli: cliKind, repoPath, chatId }));
        }
        if (!session) throw new Error('session unavailable, please retry');
        if (!('compact' in session)) {
          throw new Error('this engine has no manual compact');
        }
        // Another tab or device can be mid-turn on this warm session, which
        // this socket's `busy` flag would never know. Writing /compact into
        // the shared stdin then would land inside their turn.
        if ((session as { isBusy?: () => boolean }).isBusy?.() === true) {
          console.log(`[ws#${wsId}] compact rejected: session busy`);
          compacting = false;
          safeSend({ type: 'error', message: 'Sam is mid-turn. Let him finish, then compact.' });
          return;
        }
        // Same recycling rule as send: if the picker shows a different model
        // than the warm child spawned with, recycle onto it first so the
        // summary is written by the model the user chose. `busy` is set only
        // AFTER the bind: a superseded bind returns early, and setting it
        // before would leave this socket permanently "mid-turn".
        if (
          (cliKind === 'claude' || cliKind === 'assistant') &&
          typeof msg.model === 'string' &&
          repoPath
        ) {
          const desired = resolveClaudeSelection(msg.model, msg.effort);
          const warm = session as ClaudeSession;
          if (warm.model !== desired.model || warm.effort !== desired.effort) {
            const rebound = await bindSession(getOrCreateSession({
              cli: cliKind, repoPath, chatId, model: msg.model, effort: msg.effort,
            }));
            if (!rebound) {
              // A newer bind superseded us and owns the socket now. Say so:
              // a silent return leaves the client's compact latch closed.
              compacting = false;
              safeSend({ type: 'error', message: 'the conversation changed hands. Compact again.' });
              return;
            }
            session = rebound;
          }
        }
        turnGeneration += 1;
        busy = true;
        compacting = false;
        safeSend({
          type: 'turnStart',
          sessionKey: session.key,
          sessionId: session.sessionId(),
          chatId,
        });
        if (cliKind === 'codex') {
          void (session as CodexSession).compact();
        } else {
          (session as ClaudeSession).compact(msg.instructions);
        }
      } catch (e) {
        busy = false;
        compacting = false;
        safeSend({ type: 'error', message: String((e as Error).message) });
        if (activeSessionKey) {
          safeSend({ type: 'turnEnd', sessionKey: activeSessionKey, sessionId: currentSessionId(), chatId });
        }
      }
      return;
    }

    if (msg.type === 'freshStart') {
      try {
        turnGeneration += 1;
        chatId = normalizeChatId(msg.chatId ?? chatId);
        const session = await bindSession(
          freshStart({ cli: msg.cli, repoPath: msg.repo, chatId }),
        );
        if (!session) return;  // superseded; newer bind sends its own ready/freshStarted
        cliKind = msg.cli;
        repoPath = msg.repo;
        busy = false;
        // Fresh conversation: drop any pending auto-replay from the old thread.
        inflightTurn = null;
        authReplayArmed = false;
        authReplayDone = false;
        safeSend({
          type: 'freshStarted',
          cli: msg.cli,
          repo: msg.repo,
          chatId,
          latestSeq: session.latestSeq(),
          sessionKey: session.key,
          sessionId: session.sessionId(),
        });
      } catch (e) {
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'toolResponse') {
      console.log(`[ws#${wsId}] toolResponse cli=${msg.cli} toolUseId=${msg.toolUseId.slice(0, 8)}…`);
      try {
        chatId = normalizeChatId(msg.chatId ?? chatId);
        await respondToToolForSession({
          cli: msg.cli,
          repoPath: msg.repo,
          chatId,
          toolUseId: msg.toolUseId,
          content: msg.content,
        });
      } catch (e) {
        console.warn(`[ws#${wsId}] toolResponse failed:`, (e as Error).message);
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'setPlanMode') {
      console.log(`[ws#${wsId}] setPlanMode cli=${msg.cli} repo=${msg.repo} enabled=${msg.enabled}`);
      // Don't allow toggling mid-turn — plan mode is a spawn-time arg, so a
      // recycle would orphan the in-flight turn. Frontend disables the toggle
      // while streaming; this is the server-side belt.
      if (busy) {
        safeSend({ type: 'error', message: 'finish or stop the current turn before changing plan mode' });
        return;
      }
      try {
        chatId = normalizeChatId(msg.chatId ?? chatId);
        await setPlanModeForSession({
          cli: msg.cli,
          repoPath: msg.repo,
          chatId,
          enabled: msg.enabled,
        });
        // The recycle path inside setPlanModeForSession may have shut down our
        // warm session. Drop the cached promise so the next send rebinds with
        // the new flag. (The session's `closed` event will also clear it via
        // the dispatch handler — this is the belt to that suspenders.)
        sessionPromise = null;
        activeSessionKey = null;
        activeSession = null;
        unsubscribe?.();
        unsubscribe = null;
        const cwdForPlan = msg.cli === 'assistant' ? ASSISTANT_HUB_PATH : msg.repo;
        const planMode = await getPlanMode(msg.cli, cwdForPlan, chatId);
        safeSend({ type: 'planModeChanged', cli: msg.cli, repo: msg.repo, chatId, planMode });
      } catch (e) {
        console.warn(`[ws#${wsId}] setPlanMode failed:`, (e as Error).message);
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'send') {
      const imageCount = msg.images?.length ?? 0;
      console.log(`[ws#${wsId}] send cli=${cliKind} bytes=${msg.text.length} images=${imageCount}`);
      if (compacting) {
        safeSend({ type: 'error', message: 'Sam is compacting. One moment, then send.' });
        return;
      }
      const requestedChatId = normalizeChatId(msg.chatId ?? chatId);
      if (requestedChatId !== chatId) {
        safeSend({ type: 'error', message: 'chat changed, reconnect before sending' });
        return;
      }
      // If the session promise was nulled (e.g., right after a stop where
      // bindSession failed, or after an early error), try to recover from
      // the last hello's cli + repo instead of leaving the user stuck.
      if (!sessionPromise && cliKind && repoPath) {
        console.log(`[ws#${wsId}] send: rebinding session for recovery`);
        try {
          await bindSession(getOrCreateSession({ cli: cliKind, repoPath, chatId }));
        } catch (e) {
          console.warn(`[ws#${wsId}] send rebind failed:`, (e as Error).message);
        }
      }
      if (!sessionPromise) {
        console.warn(`[ws#${wsId}] send rejected: no session`);
        safeSend({ type: 'error', message: 'no session, send hello first' });
        return;
      }
      // Codex and Banana are spawn-per-turn, so block mid-turn sends (would
      // orphan the running process). Claude/assistant are persistent stdin and
      // accept steer messages, so we let them through even while a turn is in
      // flight.
      if (busy && (cliKind === 'codex' || cliKind === 'banana')) {
        console.warn(`[ws#${wsId}] send rejected: ${cliKind} busy`);
        safeSend({ type: 'error', message: `${cliKind} is on a turn, wait for the result` });
        return;
      }
      if (!busy) {
        turnGeneration += 1;
        busy = true;
        // Resolve the session NOW (it may still be spawning) so we can tag
        // turnStart with its real key + sessionId. Without these, the
        // frontend's bleed guard correctly drops the message.
        try {
          const sessionForStart = await sessionPromise;
          activeSession = sessionForStart;
          activeSessionKey = sessionForStart.key;
          safeSend({
            type: 'turnStart',
            sessionKey: sessionForStart.key,
            sessionId: sessionForStart.sessionId(),
            chatId,
          });
        } catch (e) {
          console.error(`[ws#${wsId}] turnStart failed:`, (e as Error).message);
          busy = false;
          safeSend({ type: 'error', message: String((e as Error).message) });
          return;
        }
      }
      try {
        let session: AnySession | null = await sessionPromise;
        if (!session && cliKind && repoPath) {
          // sessionPromise was nulled mid-handler (e.g. a `closed` event from
          // the prior, idle-expired session landed during the awaits above).
          // Rebind a fresh session instead of crashing on `'send' in null`.
          console.log(`[ws#${wsId}] send: session went null mid-flight, rebinding`);
          session = await bindSession(getOrCreateSession({ cli: cliKind, repoPath, chatId }));
        }
        if (!session) throw new Error('session unavailable, please retry');
        if ('send' in session) {
          // Banana takes a SendOpts object (carries the chosen model). Codex
          // takes a validated model/effort options object and its async send must be awaited.
          // Claude reads images from stdin.
          if (cliKind === 'banana') {
            await (session as any).send(msg.text, { images: msg.images, model: msg.model });
          } else if (cliKind === 'codex') {
            await (session as any).send(msg.text, {
              images: msg.images,
              model: msg.model,
              effort: msg.effort,
            });
          } else {
            // Claude/assistant: --model / --effort are spawn-time args on the
            // warm process. If the client sent an explicit picker choice that
            // differs from what the warm child spawned with, recycle to it first
            // (the resumed session_id keeps the conversation; the session key is
            // model-independent, so the already-emitted turnStart stays valid).
            // Only act on an EXPLICIT model: a model-less send (assistant, or a
            // legacy client) must not resolve to the bare default and recycle
            // over the persisted selection. cliKind/repoPath are set here (a
            // bound session exists) but TS widens them to |null.
            const warm = session as ClaudeSession;
            if (typeof msg.model === 'string' && cliKind && repoPath) {
              const desired = resolveClaudeSelection(msg.model, msg.effort);
              if (warm.model !== desired.model || warm.effort !== desired.effort) {
                const rebound = await bindSession(getOrCreateSession({
                  cli: cliKind, repoPath, chatId, model: msg.model, effort: msg.effort,
                }));
                if (!rebound) return;  // superseded by a newer bind
                session = rebound;
              }
            }
            // Record the turn (with its model/effort) so OAuth auto-recovery can
            // replay it, and reset the per-turn one-shot recovery guards.
            inflightTurn = { text: msg.text, images: msg.images, model: msg.model, effort: msg.effort };
            authReplayArmed = false;
            authReplayDone = false;
            (session as any).send(msg.text, msg.images);
            void retryOnceIfFirstSendStuck(session, msg.text, turnGeneration, msg.images);
          }
        }
      } catch (e) {
        console.error(`[ws#${wsId}] send failed:`, (e as Error).message);
        busy = false;
        safeSend({ type: 'error', message: String((e as Error).message) });
        if (activeSessionKey) {
          safeSend({ type: 'turnEnd', sessionKey: activeSessionKey, sessionId: currentSessionId(), chatId });
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    console.log(`[ws#${wsId}] close`);
    unsubscribe?.();
    unsubscribe = null;
    // Note: we deliberately do NOT shut down the session on ws close. The
    // claude process stays warm for the next reconnect — across browsers,
    // tabs, devices, or transient network blips.
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`samwise-2 server listening on :${PORT}`);
});

const idleReaper = setInterval(() => {
  const now = Date.now();
  const pruned = pruneIdleClaudeSessions(IDLE_SESSION_TTL_MS, now)
    + pruneIdleCodexSessions(IDLE_SESSION_TTL_MS, now)
    + pruneIdleBananaSessions(IDLE_SESSION_TTL_MS, now);
  if (pruned > 0) console.log(`[idle-reaper] pruned ${pruned} idle session(s)`);
}, IDLE_REAPER_INTERVAL_MS);
// Note: deliberately NOT calling idleReaper.unref() — we want this timer to
// drive cleanup reliably. The SIGINT/SIGTERM tearDown handler clears the
// interval explicitly so the process can still exit on signal.

// WS heartbeat. Pings every client every ~25s; clients that don't pong
// within the next cycle get terminated so their onclose handler fires
// and the client reconnects. Without this, a stale TCP connection (NAT
// drop, Tailscale blip, OS sleep) leaves the chat stuck with thinking
// dots while the server has long since emitted turnEnd.
const HEARTBEAT_INTERVAL_MS = 25_000;
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as any).isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    (ws as any).isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

const tearDown = () => {
  clearInterval(idleReaper);
  clearInterval(wsHeartbeat);
  shutdownAllSessions();
  shutdownAllCodexSessions();
  shutdownAllBananaSessions();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', tearDown);
process.on('SIGTERM', tearDown);
