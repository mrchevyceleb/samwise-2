import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Codex has no `/compact` in `exec` mode, but its app server does expose the
// same compaction the TUI runs (`thread/compact/start`). We drive a short-lived
// app-server over JSON-RPC, wait for the compaction item to complete, and let
// the normal `codex exec resume` turns keep reading the same thread afterwards.
// The summary and the token savings are Codex's own, not something we fake.

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string; code?: number };
  params?: unknown;
};

export type CodexCompactResult = {
  /** Context size after compaction, in tokens, when the server reports it. */
  postTokens?: number;
};

export class CodexAppServerError extends Error {}

const COMPACT_START_TIMEOUT_MS = 30_000;
const COMPACT_FINISH_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 3_000;

/**
 * Compact one Codex thread in place. Resolves once Codex reports the
 * compaction item completed; the thread keeps its id and its memory of the
 * conversation (as a summary).
 */
export async function compactCodexThread(
  threadId: string,
  cwd: string,
): Promise<CodexCompactResult> {
  const child = spawn('codex', ['app-server'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  let nextId = 1;
  const pending = new Map<number, (msg: JsonRpcMessage) => void>();
  let postTokens: number | undefined;
  let finished = false;
  let finishResolve: (() => void) | null = null;
  const finishedPromise = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });
  const markFinished = () => {
    if (finished) return;
    finished = true;
    finishResolve?.();
  };

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(Number(msg.id))) {
      pending.get(Number(msg.id))!(msg);
      pending.delete(Number(msg.id));
      return;
    }
    const params = msg.params as
      | {
          item?: { type?: string };
          tokenUsage?: { last?: { totalTokens?: number } };
        }
      | undefined;
    if (msg.method === 'item/completed' && params?.item?.type === 'contextCompaction') {
      markFinished();
    } else if (msg.method === 'thread/tokenUsage/updated') {
      const last = params?.tokenUsage?.last?.totalTokens;
      if (typeof last === 'number' && last > 0) postTokens = last;
    } else if (msg.method === 'turn/completed') {
      // Covers an app-server build that finishes without the item event.
      markFinished();
    }
  });

  const send = (obj: Record<string, unknown>) => {
    if (child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify(obj) + '\n');
  };

  const request = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
    new Promise<JsonRpcMessage>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodexAppServerError(`codex app-server did not answer ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const kill = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const grace = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    grace.unref?.();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
  };

  try {
    const init = await request(
      'initialize',
      { clientInfo: { name: 'samwise-2', version: '1.0.0' } },
      COMPACT_START_TIMEOUT_MS,
    );
    if (init.error) throw new CodexAppServerError(init.error.message ?? 'initialize failed');
    send({ jsonrpc: '2.0', method: 'initialized' });

    const resume = await request('thread/resume', { threadId }, COMPACT_START_TIMEOUT_MS);
    if (resume.error) throw new CodexAppServerError(resume.error.message ?? 'resume failed');

    const start = await request(
      'thread/compact/start',
      { threadId },
      COMPACT_START_TIMEOUT_MS,
    );
    if (start.error) throw new CodexAppServerError(start.error.message ?? 'compact failed');

    const timedOut = await Promise.race([
      finishedPromise.then(() => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), COMPACT_FINISH_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (timedOut) {
      throw new CodexAppServerError('codex did not finish compacting');
    }
    return { postTokens };
  } catch (err) {
    const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
    const message = err instanceof Error ? err.message : String(err);
    throw new CodexAppServerError(tail ? `${message} (${tail})` : message);
  } finally {
    rl.close();
    await kill();
  }
}
