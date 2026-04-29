import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ASSISTANT_HUB_PATH, REPO_SCAN_PATHS } from './config.ts';

const exec = promisify(execFile);

export type DiscoveredRepo = {
  path: string;
  name: string;
  branch?: string;
  hub: string; // "Work", "Side projects", "The Hub", etc.
  pinned?: boolean;
  isAssistantHub?: boolean;
};

async function gitBranch(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['-C', path, 'symbolic-ref', '--short', 'HEAD']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function scanParent(parent: string, hub: string): Promise<DiscoveredRepo[]> {
  if (!existsSync(parent)) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  const out: DiscoveredRepo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(parent, e.name);
    const gitDir = join(path, '.git');
    if (!existsSync(gitDir)) continue;
    const branch = await gitBranch(path);
    out.push({ path, name: e.name, branch, hub });
  }
  return out;
}

export async function discoverRepos(): Promise<DiscoveredRepo[]> {
  const all: DiscoveredRepo[] = [];

  // Always include the Assistant Hub first (special, pinned).
  if (existsSync(ASSISTANT_HUB_PATH)) {
    const branch = await gitBranch(ASSISTANT_HUB_PATH);
    all.push({
      path: ASSISTANT_HUB_PATH,
      name: 'ASSISTANT-HUB',
      branch,
      hub: 'The Hub',
      pinned: true,
      isAssistantHub: true,
    });
  }

  for (const parent of REPO_SCAN_PATHS) {
    const hubName = basename(parent);
    const repos = await scanParent(parent, hubName);
    all.push(...repos);
  }

  // Stat for mtime to roughly sort by recent activity.
  const withMtime = await Promise.all(
    all.map(async (r) => {
      try {
        const s = await stat(r.path);
        return { r, mtime: s.mtimeMs };
      } catch {
        return { r, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);

  return withMtime.map((x) => x.r);
}
