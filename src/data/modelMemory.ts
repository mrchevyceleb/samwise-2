// Per-chat memory for the model/effort picker.
//
// The global keys remember the last pick anywhere. That is the right default
// for a chat you have never opened, but it is the wrong thing to show when you
// reopen a chat: the thread itself is running at a particular model, and a pick
// made here (even one you never sent) is what you expect to see again. So each
// chat keeps its own pair, and opening it restores that pair.

export type ChatPick = { model: string; effort: string };

function storageKey(cli: string, repoPath: string | undefined, chatId: string): string {
  return `samwise-2:pick:${cli}:${repoPath ?? ''}:${chatId}`;
}

export function readChatPick(
  cli: string,
  repoPath: string | undefined,
  chatId: string,
): ChatPick | null {
  if (typeof window === 'undefined' || !repoPath) return null;
  try {
    const raw = localStorage.getItem(storageKey(cli, repoPath, chatId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatPick>;
    if (typeof parsed.model !== 'string' || typeof parsed.effort !== 'string') return null;
    return { model: parsed.model, effort: parsed.effort };
  } catch {
    return null;
  }
}

export function writeChatPick(
  cli: string,
  repoPath: string | undefined,
  chatId: string,
  model: string,
  effort: string,
): void {
  if (typeof window === 'undefined' || !repoPath) return;
  try {
    localStorage.setItem(storageKey(cli, repoPath, chatId), JSON.stringify({ model, effort }));
  } catch {
    // A full localStorage must never break picking a model.
  }
}
