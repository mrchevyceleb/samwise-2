import type { CommandEntry } from '../data/types';

export type CommandSuggestion = {
  command: CommandEntry;
  fullText: string;
  tail: string;
};

export function getCommandSuggestion(
  value: string,
  prefix: string,
  commands: CommandEntry[],
): CommandSuggestion | null {
  if (!prefix || !value.startsWith(prefix)) return null;
  if (/\s/.test(value)) return null;

  const query = value.slice(prefix.length).toLowerCase();
  const match = commands.find((cmd) => {
    const name = cmd.name.toLowerCase();
    return name.startsWith(query) && name !== query;
  });
  if (!match) return null;

  const fullText = `${prefix}${match.name}`;
  return {
    command: match,
    fullText,
    tail: fullText.slice(value.length),
  };
}

export function commandText(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

/**
 * Every command worth showing while the input is a bare slash command.
 * `/compact` is a CLI built-in rather than a file in ~/.claude/commands, so it
 * is added here whenever the lane has a compact, including Codex (whose own
 * commands use `$` but whose compact is still typed `/compact`).
 */
export function getCommandHints(
  value: string,
  prefix: string,
  commands: CommandEntry[],
  includeCompact: boolean,
): CommandEntry[] {
  const slash = value.startsWith('/');
  const ownPrefix = !!prefix && value.startsWith(prefix);
  if (!slash && !ownPrefix) return [];
  if (/\s/.test(value)) return [];
  const q = value.slice(slash ? 1 : prefix.length).toLowerCase();
  const out: CommandEntry[] = ownPrefix
    ? commands.filter((cmd) => cmd.name.toLowerCase().startsWith(q))
    : [];
  if (includeCompact && 'compact'.startsWith(q) && !out.some((c) => c.name === 'compact')) {
    out.unshift({
      name: 'compact',
      title: 'Compact',
      description: 'summarize this chat and make room',
    });
  }
  return out.slice(0, 6);
}
