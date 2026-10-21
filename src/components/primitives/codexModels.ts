export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type CodexModelSpec = {
  id: string;
  label: string;
  defaultEffort: CodexEffort;
  efforts: CodexEffort[];
  contextWindow: number;
};

const STANDARD_EFFORTS: CodexEffort[] = ['low', 'medium', 'high', 'xhigh'];
const MAX_EFFORTS: CodexEffort[] = [...STANDARD_EFFORTS, 'max'];
const ULTRA_EFFORTS: CodexEffort[] = [...MAX_EFFORTS, 'ultra'];

export const CODEX_MODEL_STORAGE_KEY = 'samwise-2:codex-model';
export const CODEX_EFFORT_STORAGE_KEY = 'samwise-2:codex-effort';
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';

// Synced with Codex CLI 0.159.3's model catalog on 2026-10-21.
export const CODEX_MODELS: CodexModelSpec[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    defaultEffort: 'low',
    efforts: ULTRA_EFFORTS,
    contextWindow: 500_000,
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    defaultEffort: 'medium',
    efforts: ULTRA_EFFORTS,
    contextWindow: 272_000,
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    defaultEffort: 'medium',
    efforts: ULTRA_EFFORTS,
    contextWindow: 272_000,
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    defaultEffort: 'medium',
    efforts: MAX_EFFORTS,
    contextWindow: 272_000,
  },
];

export function codexModelSpec(model: string): CodexModelSpec {
  return CODEX_MODELS.find((entry) => entry.id === model) ?? CODEX_MODELS[0];
}

export function normalizeCodexModel(model: string | null | undefined): string {
  return CODEX_MODELS.some((entry) => entry.id === model) ? model! : DEFAULT_CODEX_MODEL;
}

export function normalizeCodexEffort(model: string, effort: string | null | undefined): CodexEffort {
  const spec = codexModelSpec(normalizeCodexModel(model));
  return spec.efforts.includes(effort as CodexEffort)
    ? effort as CodexEffort
    : spec.defaultEffort;
}

export function contextWindowForCodexModel(model: string | undefined): number {
  return codexModelSpec(normalizeCodexModel(model)).contextWindow;
}

export function readStoredCodexModel(): string {
  if (typeof window === 'undefined') return DEFAULT_CODEX_MODEL;
  const raw = localStorage.getItem(CODEX_MODEL_STORAGE_KEY);
  const model = normalizeCodexModel(raw);
  if (raw !== model) {
    // Model and effort form one persisted selection. A stale or missing model
    // must reset the pair, rather than carrying an old effort onto 6.1 Sol.
    localStorage.setItem(CODEX_MODEL_STORAGE_KEY, model);
    localStorage.setItem(CODEX_EFFORT_STORAGE_KEY, codexModelSpec(model).defaultEffort);
  }
  return model;
}

export function readStoredCodexEffort(model = readStoredCodexModel()): CodexEffort {
  if (typeof window === 'undefined') return codexModelSpec(model).defaultEffort;
  const raw = localStorage.getItem(CODEX_EFFORT_STORAGE_KEY);
  const effort = normalizeCodexEffort(model, raw);
  if (raw !== effort) localStorage.setItem(CODEX_EFFORT_STORAGE_KEY, effort);
  return effort;
}

export function writeStoredCodexSelection(model: string, effort: string): void {
  if (typeof window === 'undefined') return;
  const normalizedModel = normalizeCodexModel(model);
  localStorage.setItem(CODEX_MODEL_STORAGE_KEY, normalizedModel);
  localStorage.setItem(
    CODEX_EFFORT_STORAGE_KEY,
    normalizeCodexEffort(normalizedModel, effort),
  );
}
