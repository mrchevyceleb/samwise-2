import {
  CODEX_MODELS,
  codexModelSpec,
  normalizeCodexEffort,
  normalizeCodexModel,
} from './codexModels';
import { PickerPill } from './PickerPill';

const MODEL_OPTIONS = CODEX_MODELS.map((entry) => ({
  value: entry.id,
  label: entry.label,
}));

export function CodexModelPicker({
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
  const spec = codexModelSpec(model);

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <PickerPill
        ariaLabel="Codex model"
        title="choose the Codex model"
        value={model}
        options={MODEL_OPTIONS}
        disabled={disabled}
        align={align}
        drop={drop}
        onChange={(next) => onModelChange(normalizeCodexModel(next))}
      />
      <PickerPill
        ariaLabel="Codex reasoning effort"
        title="choose Codex reasoning effort"
        value={effort}
        options={spec.efforts.map((entry) => ({ value: entry, label: `effort · ${entry}` }))}
        disabled={disabled}
        align="right"
        drop={drop}
        onChange={(next) => onEffortChange(normalizeCodexEffort(model, next))}
      />
    </span>
  );
}
