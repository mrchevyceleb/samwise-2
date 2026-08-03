export type ClaudeModelCapability = {
  defaultEffort: string;
  efforts: ReadonlySet<string>;
};

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODEL_CAPABILITIES: Record<string, ClaudeModelCapability> = {
  'claude-opus-5': { defaultEffort: 'max', efforts: new Set(CLAUDE_EFFORTS) },
  'claude-opus-4-8': { defaultEffort: 'max', efforts: new Set(CLAUDE_EFFORTS) },
  'claude-sonnet-5': { defaultEffort: 'high', efforts: new Set(CLAUDE_EFFORTS) },
};

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

function claudeCapability(model: string): ClaudeModelCapability | undefined {
  return Object.prototype.hasOwnProperty.call(CLAUDE_MODEL_CAPABILITIES, model)
    ? CLAUDE_MODEL_CAPABILITIES[model]
    : undefined;
}

/**
 * Resolve all browser-supplied values at the server trust boundary. Unknown
 * models and unsupported model/effort pairs fall back to the signed catalog's
 * model-specific defaults instead of reaching the Claude CLI's --model/--effort
 * flags. Mirrors resolveCodexSelection.
 */
export function resolveClaudeSelection(
  requestedModel?: unknown,
  requestedEffort?: unknown,
): { model: string; effort: string } {
  const modelValue = typeof requestedModel === 'string' ? requestedModel : undefined;
  const effortValue = typeof requestedEffort === 'string' ? requestedEffort : undefined;
  const requestedCapability = modelValue ? claudeCapability(modelValue) : undefined;
  const model = requestedCapability ? modelValue! : DEFAULT_CLAUDE_MODEL;
  const capability = claudeCapability(model)!;
  const invalidRequestedModel = requestedModel !== undefined && !requestedCapability;
  const effort = !invalidRequestedModel && effortValue && capability.efforts.has(effortValue)
    ? effortValue
    : capability.defaultEffort;
  return { model, effort };
}
