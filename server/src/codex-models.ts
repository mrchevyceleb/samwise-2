export type CodexModelCapability = {
  defaultEffort: string;
  efforts: ReadonlySet<string>;
};

const STANDARD_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_MODEL_CAPABILITIES: Record<string, CodexModelCapability> = {
  'gpt-6.1-sol': {
    defaultEffort: 'low',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max', 'ultra']),
  },
  'gpt-6-astra': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max', 'ultra']),
  },
  'gpt-6-sol': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max', 'ultra']),
  },
  'gpt-6-luna': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max']),
  },
};

export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';

function codexCapability(model: string): CodexModelCapability | undefined {
  return Object.prototype.hasOwnProperty.call(CODEX_MODEL_CAPABILITIES, model)
    ? CODEX_MODEL_CAPABILITIES[model]
    : undefined;
}

/**
 * Resolve all browser-supplied values at the server trust boundary. Unknown
 * models and unsupported model/effort pairs fall back to the signed catalog's
 * model-specific defaults instead of reaching the Codex CLI.
 */
export function resolveCodexSelection(
  requestedModel?: unknown,
  requestedEffort?: unknown,
): { model: string; effort: string } {
  const modelValue = typeof requestedModel === 'string' ? requestedModel : undefined;
  const effortValue = typeof requestedEffort === 'string' ? requestedEffort : undefined;
  const requestedCapability = modelValue ? codexCapability(modelValue) : undefined;
  const model = requestedCapability ? modelValue! : DEFAULT_CODEX_MODEL;
  const capability = codexCapability(model)!;
  const invalidRequestedModel = requestedModel !== undefined && !requestedCapability;
  const effort = !invalidRequestedModel && effortValue && capability.efforts.has(effortValue)
    ? effortValue
    : capability.defaultEffort;
  return { model, effort };
}
