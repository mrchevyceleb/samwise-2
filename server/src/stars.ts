import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STARS_FILE } from './config.ts';

// Starred repo paths. Sorted to the top of the Threshold so Matt doesn't have
// to hunt for the handful of repos he actually works in. Stored as a flat
// JSON list of absolute paths.

type Stored = { paths: string[] };

let cache: Set<string> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await readFile(STARS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Stored;
    cache = new Set(Array.isArray(parsed.paths) ? parsed.paths : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

async function flush(): Promise<void> {
  if (!cache) return;
  await mkdir(dirname(STARS_FILE), { recursive: true });
  const stored: Stored = { paths: Array.from(cache).sort() };
  await writeFile(STARS_FILE, JSON.stringify(stored, null, 2));
}

export async function readStars(): Promise<Set<string>> {
  return await load();
}

export async function toggleStar(path: string): Promise<boolean> {
  const set = await load();
  const next = !set.has(path);
  if (next) set.add(path);
  else set.delete(path);
  writeQueue = writeQueue.then(flush, flush);
  await writeQueue;
  return next;
}
