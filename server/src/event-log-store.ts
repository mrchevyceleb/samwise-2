import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import type { SessionEvent } from './runner.ts';

// Disk mirror for the in-memory per-session event tail. The live process
// buffer is still primary, but this prevents a server restart or browser
// wake-up with a stale sinceSeq from losing the agent's already-streamed
// output.

export type PersistedEvent = { seq: number; ev: SessionEvent };

export const EVENT_LOG_DIR = join(STATE_DIR, 'event-logs');
export const MAX_EVENTS_PER_LOG = 2000;

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function logPath(key: string): string {
  return join(EVENT_LOG_DIR, `${sanitizeKey(key)}.jsonl`);
}

export function loadEventLogSync(key: string): { events: PersistedEvent[]; nextSeq: number } {
  const path = logPath(key);
  if (!existsSync(path)) return { events: [], nextSeq: 1 };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { events: [], nextSeq: 1 };
  }
  const events: PersistedEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.seq === 'number' && parsed?.ev) {
        events.push({ seq: parsed.seq, ev: parsed.ev as SessionEvent });
      }
    } catch {
      // skip malformed/incomplete append lines
    }
  }
  const trimmed = events.length > MAX_EVENTS_PER_LOG
    ? events.slice(events.length - MAX_EVENTS_PER_LOG)
    : events;
  const nextSeq = trimmed.length > 0 ? trimmed[trimmed.length - 1].seq + 1 : 1;
  return { events: trimmed, nextSeq };
}

const writeChains = new Map<string, Promise<void>>();

export function appendEventLog(key: string, persisted: PersistedEvent): void {
  const path = logPath(key);
  const line = JSON.stringify(persisted) + '\n';
  const prior = writeChains.get(key) ?? Promise.resolve();
  const next = prior
    .then(async () => {
      try {
        await mkdir(EVENT_LOG_DIR, { recursive: true });
        await appendFile(path, line, 'utf8');
      } catch (err) {
        console.warn('[event-log-store] append failed', key, (err as Error).message);
      }
    })
    .catch(() => {});
  writeChains.set(key, next);
}

export async function compactEventLog(key: string): Promise<void> {
  const path = logPath(key);
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= MAX_EVENTS_PER_LOG) return;
  const kept = lines.slice(lines.length - MAX_EVENTS_PER_LOG).join('\n') + '\n';
  const tmp = `${path}.compact-${process.pid}`;
  try {
    await writeFile(tmp, kept, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    console.warn('[event-log-store] compact failed', key, (err as Error).message);
  }
}

export async function clearEventLog(key: string): Promise<void> {
  const prior = writeChains.get(key) ?? Promise.resolve();
  const next = prior
    .then(async () => {
      try {
        await rm(logPath(key), { force: true });
      } catch (err) {
        console.warn('[event-log-store] clear failed', key, (err as Error).message);
      }
    })
    .catch(() => {});
  writeChains.set(key, next);
  await next;
}
