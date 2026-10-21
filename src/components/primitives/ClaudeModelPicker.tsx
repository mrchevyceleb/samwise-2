import {
  CLAUDE_MODELS,
  claudeModelSpec,
  normalizeClaudeEffort,
  normalizeClaudeModel,
} from './claudeModels';
import { PickerPill } from './PickerPill';

const MODEL_OPTIONS = CLAUDE_MODELS.map((entry) => ({
  value: entry.id,
  label: entry.label,
}));

export function ClaudeModelPicker({
  model,
  effort,
  onModelChange,
  onEffortChange,
  disabled = false,
  align = 'left',
  drop = 'down',
}: {
  model: string;
  effort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  disabled?: boolean;
  align?: 'left' | 'right';
  drop?: 'down' | 'up';
}) {
  const spec = claudeModelSpec(model);

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <PickerPill
        ariaLabel="Claude model"
        title="choose the Claude model"
        value={model}
        options={MODEL_OPTIONS}
        disabled={disabled}
        align={align}
        drop={drop}
        onChange={(next) => onModelChange(normalizeClaudeModel(next))}
      />
      <PickerPill
        ariaLabel="Claude reasoning effort"
        title="choose Claude reasoning effort"
        value={effort}
        options={spec.efforts.map((entry) => ({ value: entry, label: `effort · ${entry}` }))}
        disabled={disabled}
        align="right"
        drop={drop}
        onChange={(next) => onEffortChange(normalizeClaudeEffort(model, next))}
      />
    </span>
  );
}
