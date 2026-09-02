import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiveStore } from './archive.ts';

async function withTempStore(
  fn: (store: ReturnType<typeof createArchiveStore>, file: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'samwise-archive-'));
  const file = join(dir, 'archived.json');
  try {
    await fn(createArchiveStore(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('toggle archives then restores a repo path', async () => {
  await withTempStore(async (store) => {
    assert.equal(await store.toggle('/repos/operly'), true);
    assert.equal((await store.read()).has('/repos/operly'), true);
    assert.equal(await store.toggle('/repos/operly'), false);
    assert.equal((await store.read()).has('/repos/operly'), false);
  });
});

test('archived paths persist to disk in sorted order', async () => {
  await withTempStore(async (store, file) => {
    await store.toggle('/repos/zeta');
    await store.toggle('/repos/alpha');
    const raw = JSON.parse(await readFile(file, 'utf8')) as { paths: string[] };
    assert.deepEqual(raw.paths, ['/repos/alpha', '/repos/zeta']);
  });
});

test('a fresh store reloads paths written by a previous store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samwise-archive-'));
  const file = join(dir, 'archived.json');
  try {
    const first = createArchiveStore(file);
    await first.toggle('/repos/rallypoint');
    const second = createArchiveStore(file);
    assert.deepEqual(Array.from(await second.read()), ['/repos/rallypoint']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing file reads as an empty set instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samwise-archive-'));
  try {
    const store = createArchiveStore(join(dir, 'nope.json'));
    assert.equal((await store.read()).size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt file reads as an empty set but is preserved, not overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samwise-archive-'));
  const file = join(dir, 'archived.json');
  try {
    const { readdir, writeFile } = await import('node:fs/promises');
    await writeFile(file, '{not json');
    const store = createArchiveStore(file);
    assert.equal((await store.read()).size, 0);
    // Toggling must not destroy the corrupt original.
    await store.toggle('/repos/operly');
    const names = await readdir(dir);
    assert.ok(names.some((n) => n.startsWith('archived.json.corrupt-')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent first-use toggles do not lose entries', async () => {
  await withTempStore(async (store, file) => {
    await Promise.all([
      store.toggle('/repos/a'),
      store.toggle('/repos/b'),
      store.toggle('/repos/c'),
    ]);
    const raw = JSON.parse(await readFile(file, 'utf8')) as { paths: string[] };
    assert.deepEqual(raw.paths, ['/repos/a', '/repos/b', '/repos/c']);
  });
});

test('parseable but wrong-shaped data is preserved like corrupt JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samwise-archive-'));
  const file = join(dir, 'archived.json');
  try {
    const { readdir, writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ paths: 'bad' }));
    const store = createArchiveStore(file);
    assert.equal((await store.read()).size, 0);
    await store.toggle('/repos/operly');
    const names = await readdir(dir);
    assert.ok(names.some((n) => n.startsWith('archived.json.corrupt-')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a non-ENOENT read error surfaces instead of reading as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samwise-archive-'));
  try {
    // Point the store at a path whose parent is a regular file: readFile
    // fails with ENOTDIR, which must propagate.
    const blocker = join(dir, 'blocker');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(blocker, 'x');
    const store = createArchiveStore(join(blocker, 'archived.json'));
    await assert.rejects(() => store.read());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
