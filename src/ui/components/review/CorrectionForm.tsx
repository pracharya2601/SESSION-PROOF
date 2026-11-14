import { useId } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { PencilLine, RotateCcw, Save } from "lucide-react";
import { Button, Field, Input, Textarea } from "../../design";
import { Section } from "./Section";
import "../runs/runs.css";

/** Mirrors contracts MAX_CONFIRMED_MINUTES (kept local so zod is not bundled). Server re-validates. */
const MAX_CONFIRMED_MINUTES = 720;

/** Mirrors ReviewEdits.participantChoices max length. */
export const MAX_PARTICIPANT_CHOICES = 1000;

/** "unset" = not recorded (participantDirected undefined). */
export type DirectedValue = "unset" | "yes" | "no";

export interface CorrectionValues {
  progress: string;
  minutes: string;
  /** v3 participant direction; optional so older callers keep working. */
  directed?: DirectedValue;
  choices?: string;
}

const DIRECTED_OPTIONS: { value: DirectedValue; label: string }[] = [
  { value: "unset", label: "Not recorded" },
  { value: "yes", label: "Participant directed" },
  { value: "no", label: "Not participant directed" },
];

/** 3-state radio group styled as a segmented control. */
function DirectedControl(props: { value: DirectedValue; onChange: (v: DirectedValue) => void; describedBy?: string }) {
  const name = useId();
  const reduce = useReducedMotion();
  return (
    <div className="rv-pd-seg" role="radiogroup" aria-label="Participant direction" aria-describedby={props.describedBy}>
      {DIRECTED_OPTIONS.map((o) => {
        const on = props.value === o.value;
        return (
          <label key={o.value} className={`rv-pd-opt${on ? " is-on" : ""}`}>
            <input
              type="radio"
              className="rv-pd-radio"
              name={name}
              value={o.value}
              checked={on}
              onChange={() => props.onChange(o.value)}
            />
            {on && (
              <motion.span
                layoutId={`rv-pd-thumb-${name}`}
                className={`rv-pd-thumb rv-pd-thumb-${o.value}`}
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                aria-hidden="true"
              />
            )}
            <span className="rv-pd-text">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
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
  /** Existing attested participant direction / choices (from the bundle's attestations). */
  currentDirected?: DirectedValue;
  currentChoices?: string | null;
}) {
  const directed = props.values.directed ?? props.currentDirected ?? "unset";
  const choices = props.values.choices ?? "";
  const choicesTooLong = choices.length > MAX_PARTICIPANT_CHOICES;
  const currentDirected = props.currentDirected ?? "unset";
  const directedCleared = directed === "unset" && currentDirected !== "unset";
  const choicesCleared = choices.trim() === "" && !!props.currentChoices;
  const minutesError = validateMinutes(props.values.minutes);
  const progressTooLong = props.values.progress.length > 2000;
  const canSave = props.dirty && !props.saving && !minutesError && !progressTooLong && !choicesTooLong;
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
        <fieldset className="rv-pd">
          <legend className="rv-pd-legend">Participant direction</legend>
          <DirectedControl
            value={directed}
            onChange={(v) => props.onChange({ ...props.values, directed: v })}
            describedBy="rv-pd-hint"
          />
          <p id="rv-pd-hint" className="rv-muted rv-small rv-pd-hint">
            Did the participant direct this activity? Recorded as your attestation.
            {currentDirected !== "unset"
              ? ` Currently: ${currentDirected === "yes" ? "participant directed" : "not participant directed"}.`
              : " Not yet recorded."}
            {directedCleared ? " A recorded value cannot be removed, only changed." : ""}
          </p>
          <Field
            id="rv-choices"
            label="Participant choices"
            error={choicesTooLong ? <span role="alert">Keep it to {MAX_PARTICIPANT_CHOICES} characters.</span> : undefined}
            hint={
              <>
                The participant&apos;s own choices and preferences, in your words ({choices.length}/{MAX_PARTICIPANT_CHOICES}).
                {choicesCleared ? " Existing choices cannot be removed, only replaced." : ""}
              </>
            }
          >
            <Textarea
              rows={3}
              maxLength={MAX_PARTICIPANT_CHOICES}
              value={choices}
              onChange={(e) => props.onChange({ ...props.values, choices: e.target.value })}
            />
          </Field>
        </fieldset>
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
