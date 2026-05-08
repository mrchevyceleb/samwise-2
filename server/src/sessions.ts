import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SESSIONS_FILE, STATE_DIR } from './config.ts';

// One mapping per (repo, cli, chatId) -> claude session_id (+ plan-mode flag).
// Persists across server restarts so re-opening a chat resumes the right thread
// and remembers whether plan mode is on.

type Cli = 'claude' | 'codex' | 'assistant';
type Key = string; // `${cli}|${repoPath}` or `${cli}|${repoPath}|${chatId}`

type Entry = { sessionId: string; planMode?: boolean; updatedAt: number };
type Stored = Record<Key, Entry>;

let cache: Stored | null = null;
let writeQueue: Promise<void> = Promise.resolve();

const key = (cli: Cli, repoPath: string, chatId = 'main'): Key => {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${repoPath}` : `${cli}|${repoPath}|${normalized}`;
};

async function load(): Promise<Stored> {
  if (cache) return cache;
  try {
    const raw = await readFile(SESSIONS_FILE, 'utf8');
    cache = JSON.parse(raw) as Stored;
  } catch {
    cache = {};
  }
  return cache;
}

async function flush() {
  if (!cache) return;
  await mkdir(dirname(SESSIONS_FILE), { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(cache, null, 2));
}

export async function getSessionId(
  cli: Cli,
  repoPath: string,
  chatId = 'main',
): Promise<string | undefined> {
  const all = await load();
  return all[key(cli, repoPath, chatId)]?.sessionId;
}

export async function setSessionId(
  cli: Cli,
  repoPath: string,
  sessionId: string,
  chatId = 'main',
): Promise<void> {
  const all = await load();
  const storageKey = key(cli, repoPath, chatId);
  const existing = all[storageKey];
  if (sessionId) {
    all[storageKey] = {
      sessionId,
      planMode: existing?.planMode,
      updatedAt: Date.now(),
    };
  } else if (existing?.planMode) {
    // Drop the session id but keep the plan-mode preference around so the next
    // spawn for this (cli, repo, chatId) still starts in plan mode.
    all[storageKey] = { sessionId: '', planMode: existing.planMode, updatedAt: Date.now() };
  } else {
    delete all[storageKey];
  }
  // Coalesce concurrent writes.
  writeQueue = writeQueue.then(flush, flush);
  await writeQueue;
}

export async function getPlanMode(
  cli: Cli,
  repoPath: string,
  chatId = 'main',
): Promise<boolean> {
  const all = await load();
  return all[key(cli, repoPath, chatId)]?.planMode === true;
}

export async function setPlanMode(
  cli: Cli,
  repoPath: string,
  enabled: boolean,
  chatId = 'main',
): Promise<void> {
  const all = await load();
  const storageKey = key(cli, repoPath, chatId);
  const existing = all[storageKey];
  if (!enabled && !existing?.sessionId) {
    delete all[storageKey];
  } else {
    all[storageKey] = {
      sessionId: existing?.sessionId ?? '',
      planMode: enabled || undefined,
      updatedAt: Date.now(),
    };
  }
  writeQueue = writeQueue.then(flush, flush);
  await writeQueue;
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}
