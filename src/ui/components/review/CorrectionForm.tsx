import { PencilLine, RotateCcw, Save } from "lucide-react";
import { Button, Field, Input, Textarea } from "../../design";
import { Section } from "./Section";

/** Mirrors contracts MAX_CONFIRMED_MINUTES (kept local so zod is not bundled). Server re-validates. */
const MAX_CONFIRMED_MINUTES = 720;

export interface CorrectionValues {
  progress: string;
  minutes: string;
}

export function validateMinutes(raw: string): string | null {
  if (raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return "Enter a whole number of minutes.";
  const n = Number(raw);
  if (n < 1 || n > MAX_CONFIRMED_MINUTES) return `Enter between 1 and ${MAX_CONFIRMED_MINUTES} minutes.`;
  return null;
}

export function CorrectionForm(props: {
  values: CorrectionValues;
  onChange: (v: CorrectionValues) => void;
  onSave: () => void;
  onDiscard: () => void;
  dirty: boolean;
  saving: boolean;
  scheduledMinutes: number;
  currentConfirmed: number | null;
}) {
  const minutesError = validateMinutes(props.values.minutes);
  const progressTooLong = props.values.progress.length > 2000;
  const canSave = props.dirty && !props.saving && !minutesError && !progressTooLong;
  return (
    <Section label="Corrections" title="Provider corrections" icon={<PencilLine size={18} />} className="rv-form">
      <form
        className="rv-form-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) props.onSave();
        }}
      >
        <Field
          id="rv-progress"
          label="Progress confirmation"
          hint="Your own statement of progress. It is recorded as provider confirmed."
        >
          <Textarea
            rows={3}
            maxLength={2000}
            value={props.values.progress}
            onChange={(e) => props.onChange({ ...props.values, progress: e.target.value })}
          />
        </Field>
        <Field
          id="rv-minutes"
          label="Confirmed minutes"
          error={minutesError ? <span role="alert">{minutesError}</span> : undefined}
          hint={
            <>
              Actual duration you attest to (whole minutes, 1–{MAX_CONFIRMED_MINUTES}). Scheduled was {props.scheduledMinutes} min;
              that is not a confirmation.
              {props.currentConfirmed !== null ? ` Currently confirmed: ${props.currentConfirmed} min.` : " Not yet confirmed."}
            </>
          }
        >
          <Input
            className="rv-minutes-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CONFIRMED_MINUTES}
            step={1}
            placeholder="—"
            value={props.values.minutes}
            onChange={(e) => props.onChange({ ...props.values, minutes: e.target.value })}
          />
        </Field>
        <div className="rv-row">
          <Button type="submit" variant="primary" loading={props.saving} disabled={!canSave} icon={<Save size={16} />}>
            {props.saving ? "Saving…" : "Save changes"}
          </Button>
          <Button variant="ghost" disabled={!props.dirty || props.saving} onClick={props.onDiscard} icon={<RotateCcw size={16} />}>
            Discard
          </Button>
        </div>
      </form>
    </Section>
  );
}
