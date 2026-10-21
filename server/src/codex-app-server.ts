import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  /** Context size before compaction, in tokens, when the server reports it. */
  preTokens?: number;
  /** Context size after compaction, in tokens, when the server reports it. */
  postTokens?: number;
};

export class CodexAppServerError extends Error {}

const COMPACT_START_TIMEOUT_MS = 30_000;
const COMPACT_FINISH_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 3_000;
const KILL_WAIT_MS = 5_000;

/**
 * Compact one Codex thread in place. Resolves once Codex reports the
 * compaction item completed; the thread keeps its id and its memory of the
 * conversation (as a summary). `signal` aborts the whole thing (chat stopped,
 * server shutting down) and always cleans up the child.
 */
export async function compactCodexThread(
  threadId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodexCompactResult> {
  if (signal?.aborted) throw new CodexAppServerError('compact cancelled');

  const child: ChildProcessWithoutNullStreams = spawn('codex', ['app-server'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group: codex spawns tool grandchildren, and killing only the
    // direct child would leave them writing to the thread's rollout.
    detached: true,
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  let nextId = 1;
  const pending = new Map<number, (msg: JsonRpcMessage) => void>();
  let preTokens: number | undefined;
  let postTokens: number | undefined;
  let compactRequested = false;
  let compactAcked = false;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let failure: Error | null = null;
  let finishResolve: (() => void) | null = null;
  const finishedPromise = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });

  const exitHandlers = new Set<() => void>();
  const failAll = (err: Error) => {
    if (failure) return;
    failure = err;
    for (const fn of pending.values()) fn({ error: { message: err.message } });
    pending.clear();
    finishResolve?.();
    for (const fn of exitHandlers) fn();
  };

  const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
    exited = true;
    exitCode = code;
    exitSignal = sig;
    for (const fn of exitHandlers) fn();
    const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
    failAll(new CodexAppServerError(
      `codex app-server exited (${sig ?? code ?? 'unknown'})${tail ? `: ${tail}` : ''}`,
    ));
  };
  child.on('exit', onExit);
  child.on('close', (code, sig) => { if (!exited) onExit(code, sig); });
  // A spawn failure (codex missing) or a broken pipe must never crash the
  // server: fail this compact and let the chat report it.
  child.on('error', (err) => failAll(new CodexAppServerError(`codex app-server failed: ${err.message}`)));
  child.stdin.on('error', (err) => failAll(new CodexAppServerError(`codex app-server pipe failed: ${err.message}`)));

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    // A response never carries a method; anything with one is a server
    // notification or a server-initiated request, whatever its id.
    if (msg.method === undefined && msg.id !== undefined && pending.has(Number(msg.id))) {
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
      finishResolve?.();
    } else if (msg.method === 'thread/tokenUsage/updated') {
      const last = params?.tokenUsage?.last?.totalTokens;
      if (typeof last === 'number' && last > 0) {
        // Usage before compact/start is sent is the "before" size; usage after
        // the server acknowledges it is the "after" size. A line in between is
        // ignored rather than guessed at.
        if (!compactRequested) preTokens = last;
        else if (compactAcked) postTokens = last;
      }
    } else if (msg.method === 'turn/completed' && compactAcked) {
      // Covers an app-server build that finishes without the item event.
      finishResolve?.();
    }
  });

  const send = (obj: Record<string, unknown>) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) return;
    try {
      child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      failAll(new CodexAppServerError(`codex app-server pipe failed: ${(err as Error).message}`));
    }
  };

  const request = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
    new Promise<JsonRpcMessage>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
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

  const waitForExit = () => new Promise<void>((resolve) => {
    if (exited || exitCode !== null || exitSignal !== null) return resolve();
    const done = () => { clearTimeout(cap); resolve(); };
    const cap = setTimeout(done, KILL_WAIT_MS);
    cap.unref?.();
    exitHandlers.add(function onExitWait() {
      exitHandlers.delete(onExitWait);
      done();
    });
  });

  const onAbort = () => failAll(new CodexAppServerError('compact cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });

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

    compactRequested = true;
    const start = await request(
      'thread/compact/start',
      { threadId },
      COMPACT_START_TIMEOUT_MS,
    );
    if (start.error) throw new CodexAppServerError(start.error.message ?? 'compact failed');
    compactAcked = true;

    const timedOut = await Promise.race([
      finishedPromise.then(() => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), COMPACT_FINISH_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (failure) throw failure;
    if (timedOut) throw new CodexAppServerError('codex did not finish compacting');
    return { preTokens, postTokens };
  } catch (err) {
    const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
    const message = err instanceof Error ? err.message : String(err);
    throw new CodexAppServerError(tail ? `${message} (${tail})` : message);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    rl.close();
    if (!exited && exitCode === null && exitSignal === null) {
      const signalTree = (sig: NodeJS.Signals) => {
        try { child.kill(sig); } catch {}
        if (child.pid) {
          try { process.kill(-child.pid, sig); } catch {}
        }
      };
      signalTree('SIGTERM');
      const grace = setTimeout(() => {
        if (!exited && exitCode === null && exitSignal === null) signalTree('SIGKILL');
      }, KILL_GRACE_MS);
      grace.unref?.();
      await waitForExit();
      clearTimeout(grace);
    }
  }
}
