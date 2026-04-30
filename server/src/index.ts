import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PORT } from './config.ts';
import { discoverRepos } from './repos.ts';
import { readChronicle } from './chronicle.ts';
import { readCommands } from './commands.ts';
import { ensureStateDir } from './sessions.ts';
import {
  getOrCreateSession,
  freshStart,
  interruptSession,
  shutdownAllSessions,
  activeClaudeSessions,
  pruneIdleClaudeSessions,
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
const IDLE_REAPER_INTERVAL_MS = 60 * 1000;
const RESUME_STARTUP_WATCH_MS = 8000;

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

app.get('/api/live', (_req, res) => {
  const sessions = [...activeClaudeSessions(), ...activeCodexSessions()];
  res.json({
    sessions: sessions.map((s) => ({
      cli: s.cli,
      cwd: s.cwd,
      repoName: basename(s.cwd),
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

type ClientHello = { type: 'hello'; cli: CliKind; repo: string; sinceSeq?: number };
type ClientSend = {
  type: 'send';
  text: string;
  images?: Array<{ mediaType: string; base64: string }>;
};
type ClientFresh = { type: 'freshStart'; cli: CliKind; repo: string };
type ClientStop = { type: 'stop'; cli: CliKind; repo: string };
type ClientSteer = {
  type: 'steer';
  cli: CliKind;
  repo: string;
  text: string;
  images?: Array<{ mediaType: string; base64: string }>;
};
type ClientMsg = ClientHello | ClientSend | ClientFresh | ClientStop | ClientSteer;

type ResumeWatchableSession = AnySession & {
  startedWithResume?: () => boolean;
  waitForInitOrExit?: (timeoutMs: number) => Promise<'initialized' | 'closed' | 'timeout'>;
};

let wsCounter = 0;

wss.on('connection', (ws, req) => {
  const wsId = ++wsCounter;
  const peer = (req.headers['x-forwarded-for'] as string | undefined) ?? req.socket.remoteAddress ?? '?';
  console.log(`[ws#${wsId}] open from ${peer}`);

  // Stored as a promise so sends arriving while the spawn is still in flight
  // can `await` it instead of failing with "no session — send hello first".
  let sessionPromise: Promise<AnySession> | null = null;
  let unsubscribe: (() => void) | null = null;
  let busy = false;
  let cliKind: CliKind | null = null;
  let repoPath: string | null = null;
  let turnGeneration = 0;

  const safeSend = (msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const dispatch = (se: { seq: number; ev: any }) => {
    const sev = se.ev;
    if (sev.type === 'event') {
      safeSend({ type: 'stream', event: sev.event, seq: se.seq });
    } else if (sev.type === 'turnEnd') {
      busy = false;
      safeSend({ type: 'turnEnd', sessionId: sev.sessionId, seq: se.seq });
    } else if (sev.type === 'error') {
      safeSend({ type: 'error', message: sev.message, seq: se.seq });
    } else if (sev.type === 'closed') {
      safeSend({ type: 'sessionClosed', code: sev.code, seq: se.seq });
      // The CLI process is dead. Drop the stale promise + subscription so the
      // next `send` hits the recovery branch and rebinds via getOrCreateSession
      // (which spawns a fresh process resuming from the saved session_id).
      // Without this the client is stuck emitting "session has exited" until
      // they hit Clear.
      sessionPromise = null;
      busy = false;
      unsubscribe?.();
      unsubscribe = null;
    }
  };

  // Bind to a session and subscribe this WebSocket to its event stream.
  const bindSession = async (
    promise: Promise<AnySession>,
    sinceSeq: number = -1,
  ): Promise<AnySession> => {
    sessionPromise = promise;
    const session = await promise;
    unsubscribe?.();
    unsubscribe = session.subscribe(dispatch, sinceSeq);
    return session;
  };

  const retryOnceAfterStaleResume = async (
    session: AnySession,
    text: string,
    generation: number,
    images?: Array<{ mediaType: string; base64: string }>,
  ): Promise<boolean> => {
    if (!cliKind || !repoPath || cliKind === 'codex') return false;
    const watchable = session as ResumeWatchableSession;
    if (watchable.startedWithResume?.() !== true || !watchable.waitForInitOrExit) return false;

    const state = await watchable.waitForInitOrExit(RESUME_STARTUP_WATCH_MS);
    if (state !== 'closed') return false;
    if (generation !== turnGeneration) return false;

    console.log(`[ws#${wsId}] stale resume closed before init, retrying fresh`);
    try {
      const retrySession = await bindSession(getOrCreateSession({ cli: cliKind, repoPath }));
      busy = true;
      safeSend({ type: 'sessionRebound' });
      safeSend({ type: 'turnStart' });
      if ('send' in retrySession) (retrySession as any).send(text, images);
      return true;
    } catch (e) {
      console.warn(`[ws#${wsId}] stale resume retry failed:`, (e as Error).message);
      busy = false;
      safeSend({ type: 'error', message: String((e as Error).message) });
      safeSend({ type: 'turnEnd' });
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
      const sinceSeq = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : -1;
      console.log(`[ws#${wsId}] hello cli=${msg.cli} repo=${msg.repo} sinceSeq=${sinceSeq}`);
      try {
        const session = await bindSession(
          getOrCreateSession({ cli: msg.cli, repoPath: msg.repo }),
          sinceSeq,
        );
        // If we're attaching to a session that's mid-turn, tell the client so
        // its status flips to 'streaming' instead of stale 'ready'. Otherwise
        // a phone unlock during a long Sam turn looks like nothing's happening.
        const sessionBusy = (session as any).isBusy?.() === true;
        if (sessionBusy) busy = true;
        console.log(`[ws#${wsId}] session ready key=${session.key} latestSeq=${session.latestSeq()} busy=${sessionBusy}`);
        safeSend({
          type: 'ready',
          cli: msg.cli,
          repo: msg.repo,
          latestSeq: session.latestSeq(),
          busy: sessionBusy,
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
        await interruptSession({ cli: msg.cli, repoPath: msg.repo });
        cliKind = msg.cli;
        repoPath = msg.repo;
        // Spin up a fresh session immediately and fire the new prompt at it.
        const session = await bindSession(
          getOrCreateSession({ cli: msg.cli, repoPath: msg.repo }),
        );
        busy = true;
        safeSend({ type: 'turnStart' });
        if ('send' in session) {
          if (msg.cli === 'codex') await (session as any).send(msg.text, msg.images);
          else {
            (session as any).send(msg.text, msg.images);
            void retryOnceAfterStaleResume(session, msg.text, turnGeneration, msg.images);
          }
        }
      } catch (e) {
        console.error(`[ws#${wsId}] steer failed:`, (e as Error).message);
        busy = false;
        safeSend({ type: 'error', message: String((e as Error).message) });
        safeSend({ type: 'turnEnd' });
      }
      return;
    }

    if (msg.type === 'stop') {
      console.log(`[ws#${wsId}] stop cli=${msg.cli} repo=${msg.repo}`);
      try {
        turnGeneration += 1;
        await interruptSession({ cli: msg.cli, repoPath: msg.repo });
        busy = false;
        safeSend({ type: 'turnEnd' });
        cliKind = msg.cli;
        repoPath = msg.repo;
        sessionPromise = null;
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
        const session = await bindSession(
          freshStart({ cli: msg.cli, repoPath: msg.repo }),
        );
        cliKind = msg.cli;
        repoPath = msg.repo;
        busy = false;
        safeSend({ type: 'freshStarted', cli: msg.cli, repo: msg.repo, latestSeq: session.latestSeq() });
      } catch (e) {
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'send') {
      const imageCount = msg.images?.length ?? 0;
      console.log(`[ws#${wsId}] send cli=${cliKind} bytes=${msg.text.length} images=${imageCount}`);
      // If the session promise was nulled (e.g., right after a stop where
      // bindSession failed, or after an early error), try to recover from
      // the last hello's cli + repo instead of leaving the user stuck.
      if (!sessionPromise && cliKind && repoPath) {
        console.log(`[ws#${wsId}] send: rebinding session for recovery`);
        try {
          await bindSession(getOrCreateSession({ cli: cliKind, repoPath }));
        } catch (e) {
          console.warn(`[ws#${wsId}] send rebind failed:`, (e as Error).message);
        }
      }
      if (!sessionPromise) {
        console.warn(`[ws#${wsId}] send rejected: no session`);
        safeSend({ type: 'error', message: 'no session — send hello first' });
        return;
      }
      // Codex is spawn-per-turn, so block mid-turn sends (would orphan the
      // running process). Claude/assistant are persistent stdin and accept
      // steer messages, so we let them through even while a turn is in flight.
      if (busy && cliKind === 'codex') {
        console.warn(`[ws#${wsId}] send rejected: codex busy`);
        safeSend({ type: 'error', message: 'codex is on a turn — wait for the result' });
        return;
      }
      if (!busy) {
        turnGeneration += 1;
        busy = true;
        safeSend({ type: 'turnStart' });
      }
      try {
        const session = await sessionPromise;
        if ('send' in session) {
          // Claude reads images from stdin; Codex gets temp files passed with --image.
          if (cliKind === 'codex') {
            await (session as any).send(msg.text, msg.images);
          } else {
            (session as any).send(msg.text, msg.images);
            void retryOnceAfterStaleResume(session, msg.text, turnGeneration, msg.images);
          }
        }
      } catch (e) {
        console.error(`[ws#${wsId}] send failed:`, (e as Error).message);
        busy = false;
        safeSend({ type: 'error', message: String((e as Error).message) });
        safeSend({ type: 'turnEnd' });
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
idleReaper.unref();

const tearDown = () => {
  clearInterval(idleReaper);
  shutdownAllSessions();
  shutdownAllCodexSessions();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', tearDown);
process.on('SIGTERM', tearDown);
