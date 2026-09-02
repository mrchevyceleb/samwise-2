import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ARCHIVED_FILE } from './config.ts';

// Archived repo paths. Hidden from the default Threshold repo list so old,
// inactive repos stop piling up, but restorable from the archived view.
// Mirrors stars.ts — a flat JSON list of absolute paths under ~/.samwise-2.

type Stored = { paths: string[] };

export type ArchiveStore = {
  read: () => Promise<Set<string>>;
  /** Flips the archived state. Returns the new state (true = archived). */
  toggle: (path: string) => Promise<boolean>;
};

// Factory so tests can bind a store to a temp file instead of ~/.samwise-2.
export function createArchiveStore(file: string): ArchiveStore {
  let cache: Set<string> | null = null;
  // Serializes the ENTIRE load/mutate/write transaction. Without this, two
  // first-use toggles can each load their own Set, overwrite the cache, and
  // flush whichever copy won the race, silently losing an archived path.
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Set<string>> {
    if (cache) return cache;
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      // Only a missing file means "empty". Permission and transient I/O
      // errors surface to the caller instead of masquerading as an empty
      // archive that a later toggle would flush over the real data.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = new Set();
        return cache;
      }
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as Stored;
      // Validate the full shape: parseable-but-wrong data (paths not a string
      // array) must not be silently treated as an empty archive that a later
      // flush would bake to disk.
      if (!parsed || !Array.isArray(parsed.paths) || !parsed.paths.every((p) => typeof p === 'string')) {
        throw new Error('invalid archived.json shape');
      }
      cache = new Set(parsed.paths);
    } catch {
      // Corrupt JSON: move it aside for forensics instead of letting a later
      // flush overwrite the only copy of the archived list, then start empty.
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      cache = new Set();
    }
    return cache;
  }

  async function flush(): Promise<void> {
    if (!cache) return;
    await mkdir(dirname(file), { recursive: true });
    const stored: Stored = { paths: Array.from(cache).sort() };
    await writeFile(file, JSON.stringify(stored, null, 2));
  }

  // EVERY operation goes through enqueue so reads and toggles are fully
  // serialized. Without this, a read on an uncached store can run load()
  // concurrently with a toggle and overwrite the cache the toggle just
  // mutated, so the toggle's flush persists a stale set and silently drops
  // the archived path.
  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op);
    queue = run.catch(() => {});
    return run;
  }

  return {
    read: () => enqueue(load),
    toggle(path: string): Promise<boolean> {
      return enqueue(async () => {
        const set = await load();
        const before = new Set(set);
        const next = !set.has(path);
        if (next) set.add(path);
        else set.delete(path);
        try {
          await flush();
        } catch (e) {
          // Write failed but the endpoint reports an error: roll the cache
          // back so in-memory state matches disk and a retry toggles from
          // the correct state.
          cache = before;
          throw e;
        }
        return next;
      });
    },
  };
}

const defaultStore = createArchiveStore(ARCHIVED_FILE);

export async function readArchived(): Promise<Set<string>> {
  return defaultStore.read();
}

export async function toggleArchived(path: string): Promise<boolean> {
  return defaultStore.toggle(path);
}
