import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.PORT) || 8090;

// Where to scan for repos. Each entry is a parent directory; first-level
// children that contain a .git folder are treated as repos.
export const REPO_SCAN_PATHS: string[] = [
  join(homedir(), 'code'),
  join(homedir(), 'samwise', 'Personal-Apps'),
  join(homedir(), 'Documents', 'PERSONAL-PROJECTS'),
];

// The Assistant Hub — fixed path, surfaced as the "Assistant" companion's repo.
export const ASSISTANT_HUB_PATH = join(
  homedir(),
  'Library',
  'CloudStorage',
  'OneDrive-Personal',
  'Documents',
  'ASSISTANT-HUB',
);

// Where Claude Code persists its session JSONL files.
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Where samwise-2 persists its (repo,cli) -> claude session_id map.
export const STATE_DIR = join(homedir(), '.samwise-2');
export const SESSIONS_FILE = join(STATE_DIR, 'sessions.json');
