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
  type AnySession,
  type CliKind,
} from './runner.ts';
import {
  shutdownAllCodexSessions,
  activeCodexSessions,
  pruneIdleCodexSessions,
} from './codex-runner.ts';
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
  const sessions = [...activeClaudeSessions(), ...activeCodexSessions()];
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
};
type ClientToolResponse = {
  type: 'toolResponse';
  cli: CliKind;
  repo: string;
  chatId?: string;
  toolUseId: string;
  content: string;
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

    const dispatch = (se: { seq: number; ev: any }) => {
      // Defensive: if a newer binding has taken over since this listener was
      // attached but unsubscribe hasn't run yet, drop the event.
      if (activeBindGen !== myGen) return;
      const sev = se.ev;
      const sessionId = session.sessionId();
      if (sev.type === 'event') {
        safeSend({ type: 'stream', event: sev.event, seq: se.seq, sessionKey, sessionId, chatId });
      } else if (sev.type === 'turnEnd') {
        busy = false;
        safeSend({
          type: 'turnEnd',
          sessionId: sev.sessionId ?? sessionId,
          seq: se.seq,
          sessionKey,
          chatId,
        });
      } else if (sev.type === 'error') {
        if (busy) {
          safeSend({ type: 'error', message: sev.message, seq: se.seq, sessionKey, sessionId, chatId });
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
        if (busy) {
          safeSend({ type: 'sessionClosed', code: sev.code, seq: se.seq, sessionKey, sessionId, chatId });
        } else {
          console.log(`[ws#${wsId}] swallowed idle session close (code=${sev.code})`);
        }
        sessionPromise = null;
        busy = false;
        activeSessionKey = null;
        activeSession = null;
        unsubscribe?.();
        unsubscribe = null;
      }
    };

    unsubscribe = session.subscribe(dispatch, sinceSeq);
    return session;
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
    if (!cliKind || !repoPath || cliKind === 'codex') return false;
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
      if ('send' in retrySession) (retrySession as any).send(text, images);
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
      try {
        turnGeneration += 1;
        chatId = normalizeChatId(msg.chatId ?? chatId);
        await interruptSession({ cli: msg.cli, repoPath: msg.repo, chatId });
        cliKind = msg.cli;
        repoPath = msg.repo;
        // Spin up a fresh session immediately and fire the new prompt at it.
        const session = await bindSession(
          getOrCreateSession({ cli: msg.cli, repoPath: msg.repo, chatId }),
        );
        if (!session) return;  // superseded; newer bind drives the next turn
        busy = true;
        safeSend({ type: 'turnStart', sessionKey: session.key, sessionId: session.sessionId(), chatId });
        if ('send' in session) {
          if (msg.cli === 'codex') await (session as any).send(msg.text, msg.images);
          else {
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
      // Codex is spawn-per-turn, so block mid-turn sends (would orphan the
      // running process). Claude/assistant are persistent stdin and accept
      // steer messages, so we let them through even while a turn is in flight.
      if (busy && cliKind === 'codex') {
        console.warn(`[ws#${wsId}] send rejected: codex busy`);
        safeSend({ type: 'error', message: 'codex is on a turn, wait for the result' });
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
        const session = await sessionPromise;
        if ('send' in session) {
          // Claude reads images from stdin; Codex gets temp files passed with --image.
          if (cliKind === 'codex') {
            await (session as any).send(msg.text, msg.images);
          } else {
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
    + pruneIdleCodexSessions(IDLE_SESSION_TTL_MS, now);
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', tearDown);
process.on('SIGTERM', tearDown);
