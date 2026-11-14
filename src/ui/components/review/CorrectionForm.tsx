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
    <section className="card rv-form" aria-label="Corrections">
      <h2>Provider corrections</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) props.onSave();
        }}
      >
        <div className="rv-field">
          <label htmlFor="rv-progress">Progress confirmation</label>
          <textarea
            id="rv-progress"
            rows={3}
            maxLength={2000}
            value={props.values.progress}
            aria-describedby="rv-progress-help"
            onChange={(e) => props.onChange({ ...props.values, progress: e.target.value })}
          />
          <small id="rv-progress-help" className="muted">
            Your own statement of progress. It is recorded as provider confirmed.
          </small>
        </div>
        <div className="rv-field">
          <label htmlFor="rv-minutes">Confirmed minutes</label>
          <input
            id="rv-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CONFIRMED_MINUTES}
            step={1}
            value={props.values.minutes}
            aria-invalid={minutesError ? true : undefined}
            aria-describedby={minutesError ? "rv-minutes-help rv-minutes-error" : "rv-minutes-help"}
            onChange={(e) => props.onChange({ ...props.values, minutes: e.target.value })}
          />
          <small id="rv-minutes-help" className="muted">
            Actual duration you attest to (whole minutes, 1–{MAX_CONFIRMED_MINUTES}). Scheduled was{" "}
            {props.scheduledMinutes} min; that is not a confirmation.
            {props.currentConfirmed !== null ? ` Currently confirmed: ${props.currentConfirmed} min.` : " Not yet confirmed."}
          </small>
          {minutesError && (
            <small id="rv-minutes-error" className="rv-field-error" role="alert">
              {minutesError}
            </small>
          )}
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            {props.saving ? "Saving…" : "Save changes"}
          </button>
          <button type="button" className="btn" disabled={!props.dirty || props.saving} onClick={props.onDiscard}>
            Discard
          </button>
        </div>
      </form>
    </section>
  );
}
