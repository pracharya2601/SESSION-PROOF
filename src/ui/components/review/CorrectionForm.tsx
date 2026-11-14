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

/** Mirrors ReviewEdits.activitySummary max length. */
export const MAX_ACTIVITY_SUMMARY = 2000;

/** Checkbox group id (ApprovalChecklist jumps here for goal_addressed). */
export const GOALS_GROUP_ID = "rv-goals";
/** Activity summary textarea id (ApprovalChecklist jumps here for service_description). */
export const SUMMARY_ID = "rv-summary";

/** "unset" = not recorded (participantDirected undefined). */
export type DirectedValue = "unset" | "yes" | "no";

export interface CorrectionValues {
  progress: string;
  minutes: string;
  /** v3 participant direction; optional so older callers keep working. */
  directed?: DirectedValue;
  choices?: string;
  /** Plan goal ids the provider confirms were addressed; undefined = unchanged. */
  goals?: string[];
  /** Provider-written activity summary. */
  summary?: string;
}

export interface PlanGoalOption {
  goalId: string;
  objective: string;
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
  /** The session's plan goals (frozen config) and the provider's existing confirmations. */
  goals?: PlanGoalOption[];
  currentGoals?: string[];
  currentSummary?: string | null;
}) {
  const goalOptions = props.goals ?? [];
  const checkedGoals = props.values.goals ?? props.currentGoals ?? [];
  const summary = props.values.summary ?? "";
  const summaryTooLong = summary.length > MAX_ACTIVITY_SUMMARY;
  const summaryCleared = summary.trim() === "" && !!props.currentSummary;
  const toggleGoal = (id: string, on: boolean) => {
    const next = on ? [...checkedGoals, id] : checkedGoals.filter((g) => g !== id);
    // Keep plan order so "unchanged" compares cleanly.
    props.onChange({ ...props.values, goals: goalOptions.map((g) => g.goalId).filter((g) => next.includes(g)) });
  };
  const directed = props.values.directed ?? props.currentDirected ?? "unset";
  const choices = props.values.choices ?? "";
  const choicesTooLong = choices.length > MAX_PARTICIPANT_CHOICES;
  const currentDirected = props.currentDirected ?? "unset";
  const directedCleared = directed === "unset" && currentDirected !== "unset";
  const choicesCleared = choices.trim() === "" && !!props.currentChoices;
  const minutesError = validateMinutes(props.values.minutes);
  const progressTooLong = props.values.progress.length > 2000;
  const canSave = props.dirty && !props.saving && !minutesError && !progressTooLong && !choicesTooLong && !summaryTooLong;
  return (
    <Section label="Corrections" title="Provider corrections" icon={<PencilLine size={18} />} className="rv-form">
      <form
        className="rv-form-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) props.onSave();
        }}
      >
        {goalOptions.length > 0 && (
          <fieldset className="rv-pd" id={GOALS_GROUP_ID} tabIndex={-1} aria-describedby="rv-goals-hint">
            <legend className="rv-pd-legend">Plan goals</legend>
            <div style={{ display: "grid", gap: 6 }}>
              {goalOptions.map((g) => (
                <label key={g.goalId} className="rv-small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    checked={checkedGoals.includes(g.goalId)}
                    onChange={(e) => toggleGoal(g.goalId, e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong>{g.objective}</strong>
                    <span className="rv-muted"> — Addressed in this visit (I confirm)</span>
                  </span>
                </label>
              ))}
            </div>
            <p id="rv-goals-hint" className="rv-muted rv-small rv-pd-hint">
              Recorded as your confirmation, shown as &ldquo;provider confirmed&rdquo; — never as transcript evidence.
            </p>
          </fieldset>
        )}
        <Field
          id={SUMMARY_ID}
          label="Activity summary"
          error={summaryTooLong ? <span role="alert">Keep it to {MAX_ACTIVITY_SUMMARY} characters.</span> : undefined}
          hint={
            <>
              Optional. What you did in the visit, in your own words; shown on the session note as provider written (
              {summary.length}/{MAX_ACTIVITY_SUMMARY}).
              {summaryCleared ? " An existing summary cannot be removed, only replaced." : ""}
            </>
          }
        >
          <Textarea
            rows={3}
            maxLength={MAX_ACTIVITY_SUMMARY}
            value={summary}
            onChange={(e) => props.onChange({ ...props.values, summary: e.target.value })}
          />
        </Field>
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
