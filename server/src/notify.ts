import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CliKind } from './runner.ts';

// Light Telegram pings so Sam can ring you when a turn finishes — the whole
// "fire and forget, get pinged when done" employee model. Reads creds from
// ~/.samwise-2/telegram.json (gitignored by living outside the repo) or env
// vars as a fallback; if neither is present, notifyTurnEnd is a no-op so
// the rest of the app keeps working.

function loadCreds(): { token: string; chatId: string } | null {
  // 1. Env vars (handy for dev / tests).
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat = process.env.TELEGRAM_CHAT_ID;
  if (envToken && envChat) return { token: envToken, chatId: envChat };

  // 2. ~/.samwise-2/telegram.json — the production path. Never in git.
  try {
    const raw = readFileSync(join(homedir(), '.samwise-2', 'telegram.json'), 'utf8');
    const j = JSON.parse(raw);
    if (typeof j.bot_token === 'string' && typeof j.chat_id !== 'undefined') {
      return { token: j.bot_token, chatId: String(j.chat_id) };
    }
  } catch { /* file missing or unreadable — fall through */ }
  return null;
}

const CREDS = loadCreds();
const ENABLED = !!CREDS;

const COMPANION_LABEL: Record<CliKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  assistant: 'Assistant',
};

// Suppress consecutive pings for the same (cli, repo) within a short window.
// Long agentic loops can complete several "turns" in quick succession; only
// the last one's worth pinging.
const lastPingAt = new Map<string, number>();
const COALESCE_MS = 8_000;

export async function notifyTurnEnd(opts: {
  cli: CliKind;
  repoPath: string;
  preview?: string;
  durationMs?: number;
}): Promise<void> {
  if (!ENABLED) return;
  const key = `${opts.cli}|${opts.repoPath}`;
  const now = Date.now();
  const last = lastPingAt.get(key) ?? 0;
  if (now - last < COALESCE_MS) return;
  lastPingAt.set(key, now);

  const repoName = opts.repoPath.split('/').pop() || opts.repoPath;
  const seconds = opts.durationMs ? Math.round(opts.durationMs / 1000) : null;
  const lines = [
    `Sam · ${COMPANION_LABEL[opts.cli]} · ${repoName}${seconds ? ` (${seconds}s)` : ''}`,
  ];
  if (opts.preview) {
    const trimmed = opts.preview.trim();
    if (trimmed) {
      const oneLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? '';
      lines.push(oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine);
    }
  }

  if (!CREDS) return;
  try {
    await fetch(`https://api.telegram.org/bot${CREDS.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: CREDS.chatId,
        text: lines.join('\n\n'),
        disable_notification: false,
      }),
    });
  } catch (e) {
    // Notifications are best-effort; never let a failure here interrupt the
    // turn flow.
    // eslint-disable-next-line no-console
    console.warn('[notify] telegram ping failed:', (e as Error).message);
  }
}
