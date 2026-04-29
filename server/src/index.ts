import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PORT } from './config.ts';
import { discoverRepos } from './repos.ts';
import { readChronicle } from './chronicle.ts';
import { ensureStateDir } from './sessions.ts';
import {
  getOrCreateSession,
  shutdownAllSessions,
  type AnySession,
  type CliKind,
} from './runner.ts';
import { shutdownAllCodexSessions } from './codex-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(HERE, '..', '..', 'dist');

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

app.get('/api/chronicle', async (_req, res) => {
  try {
    const events = await readChronicle();
    res.json({ events });
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

type ClientHello = { type: 'hello'; cli: CliKind; repo: string };
type ClientSend = { type: 'send'; text: string };
type ClientMsg = ClientHello | ClientSend;

wss.on('connection', (ws) => {
  // Stored as a promise so sends arriving while the spawn is still in flight
  // can `await` it instead of failing with "no session — send hello first".
  let sessionPromise: Promise<AnySession> | null = null;
  let unsubscribe: (() => void) | null = null;
  let busy = false;

  const safeSend = (msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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
      sessionPromise = getOrCreateSession({ cli: msg.cli, repoPath: msg.repo });
      try {
        const session = await sessionPromise;
        unsubscribe?.();
        unsubscribe = session.subscribe((sev) => {
          if (sev.type === 'event') {
            safeSend({ type: 'stream', event: sev.event });
          } else if (sev.type === 'turnEnd') {
            busy = false;
            safeSend({ type: 'turnEnd', sessionId: sev.sessionId });
          } else if (sev.type === 'error') {
            safeSend({ type: 'error', message: sev.message });
          } else if (sev.type === 'closed') {
            safeSend({ type: 'sessionClosed', code: sev.code });
          }
        });
        safeSend({ type: 'ready', cli: msg.cli, repo: msg.repo });
      } catch (e) {
        sessionPromise = null;
        safeSend({ type: 'error', message: String((e as Error).message) });
      }
      return;
    }

    if (msg.type === 'send') {
      if (!sessionPromise) {
        safeSend({ type: 'error', message: 'no session — send hello first' });
        return;
      }
      if (busy) {
        safeSend({ type: 'error', message: 'sam is still answering — wait or interrupt' });
        return;
      }
      busy = true;
      safeSend({ type: 'turnStart' });
      try {
        const session = await sessionPromise;
        session.send(msg.text);
      } catch (e) {
        busy = false;
        safeSend({ type: 'error', message: String((e as Error).message) });
        safeSend({ type: 'turnEnd' });
      }
      return;
    }
  });

  ws.on('close', () => {
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

const tearDown = () => {
  shutdownAllSessions();
  shutdownAllCodexSessions();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', tearDown);
process.on('SIGTERM', tearDown);
