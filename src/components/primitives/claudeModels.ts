export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ClaudeModelSpec = {
  id: string;
  label: string;
  defaultEffort: ClaudeEffort;
  efforts: ClaudeEffort[];
};

// Claude Code's `--effort` ladder (low|medium|high|xhigh|max). "max" is top.
// These are the reasoning models that accept the flag; Haiku is intentionally
// left out (it has no effort ladder and rejects the flag).
const CLAUDE_EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const CLAUDE_MODEL_STORAGE_KEY = 'samwise-2:claude-model';
export const CLAUDE_EFFORT_STORAGE_KEY = 'samwise-2:claude-effort';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

// Model ids are the exact strings the `claude` CLI's --model flag accepts.
export const CLAUDE_MODELS: ClaudeModelSpec[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    defaultEffort: 'max',
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    defaultEffort: 'max',
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    defaultEffort: 'high',
    efforts: CLAUDE_EFFORTS,
  },
];

export function claudeModelSpec(model: string): ClaudeModelSpec {
  return CLAUDE_MODELS.find((entry) => entry.id === model) ?? CLAUDE_MODELS[0];
}

export function normalizeClaudeModel(model: string | null | undefined): string {
  return CLAUDE_MODELS.some((entry) => entry.id === model) ? model! : DEFAULT_CLAUDE_MODEL;
}

export function normalizeClaudeEffort(model: string, effort: string | null | undefined): ClaudeEffort {
  const spec = claudeModelSpec(normalizeClaudeModel(model));
  return spec.efforts.includes(effort as ClaudeEffort)
    ? effort as ClaudeEffort
    : spec.defaultEffort;
}

export function readStoredClaudeModel(): string {
  if (typeof window === 'undefined') return DEFAULT_CLAUDE_MODEL;
  const raw = localStorage.getItem(CLAUDE_MODEL_STORAGE_KEY);
  const model = normalizeClaudeModel(raw);
  if (raw !== model) {
    // Model and effort form one persisted selection. A stale or missing model
    // must reset the pair, rather than carrying an old effort onto Opus 5.
    localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, model);
    localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, claudeModelSpec(model).defaultEffort);
  }
  return model;
}

export function readStoredClaudeEffort(model = readStoredClaudeModel()): ClaudeEffort {
  if (typeof window === 'undefined') return claudeModelSpec(model).defaultEffort;
  const raw = localStorage.getItem(CLAUDE_EFFORT_STORAGE_KEY);
  const effort = normalizeClaudeEffort(model, raw);
  if (raw !== effort) localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, effort);
  return effort;
}

export function writeStoredClaudeSelection(model: string, effort: string): void {
  if (typeof window === 'undefined') return;
  const normalizedModel = normalizeClaudeModel(model);
  localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, normalizedModel);
  localStorage.setItem(
    CLAUDE_EFFORT_STORAGE_KEY,
    normalizeClaudeEffort(normalizedModel, effort),
  );
}
