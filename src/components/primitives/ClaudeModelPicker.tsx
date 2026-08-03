import {
  CLAUDE_MODELS,
  claudeModelSpec,
  normalizeClaudeEffort,
  normalizeClaudeModel,
} from './claudeModels';

export function ClaudeModelPicker({
  model,
  effort,
  onModelChange,
  onEffortChange,
  disabled = false,
}: {
  model: string;
  effort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  disabled?: boolean;
}) {
  const selectStyle = {
    background: 'transparent',
    color: 'var(--ink-soft)',
    border: '1px solid var(--rule)',
    borderRadius: 999,
    padding: '3px 10px',
    fontFamily: 'var(--serif-display)',
    fontStyle: 'italic',
    fontSize: 12.5,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  } as const;
  const spec = claudeModelSpec(model);

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        aria-label="Claude model"
        title="choose the Claude model"
        value={model}
        disabled={disabled}
        style={selectStyle}
        onChange={(event) => onModelChange(normalizeClaudeModel(event.target.value))}
      >
        {CLAUDE_MODELS.map((entry) => (
          <option key={entry.id} value={entry.id}>{entry.label}</option>
        ))}
      </select>
      <select
        aria-label="Claude reasoning effort"
        title="choose Claude reasoning effort"
        value={effort}
        disabled={disabled}
        style={selectStyle}
        onChange={(event) => onEffortChange(normalizeClaudeEffort(model, event.target.value))}
      >
        {spec.efforts.map((entry) => (
          <option key={entry} value={entry}>{`effort · ${entry}`}</option>
        ))}
      </select>
    </span>
  );
}
