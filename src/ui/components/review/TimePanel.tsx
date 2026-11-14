import type { TimeSummary } from "../../../contracts";
import { formatInstant } from "./format";

export function TimePanel(props: { time: TimeSummary }) {
  const t = props.time;
  return (
    <section className="card rv-time" aria-label="Time summary">
      <h2>Time</h2>
      <dl className="rv-dl">
        <dt>Scheduled</dt>
        <dd>
          {t.scheduledMinutes} min{" "}
          <span className="muted">
            ({formatInstant(t.scheduledFrom, t.timezone)} – {formatInstant(t.scheduledTo, t.timezone, false)})
          </span>
        </dd>
        <dt>
          Evidence window <span className="muted">(informational only)</span>
        </dt>
        <dd>
          {t.evidenceWindowFrom && t.evidenceWindowTo ? (
            <>
              {t.evidenceWindowMinutes ?? "—"} min{" "}
              <span className="muted">
                ({formatInstant(t.evidenceWindowFrom, t.timezone, false)} – {formatInstant(t.evidenceWindowTo, t.timezone, false)})
              </span>
            </>
          ) : (
            <span className="muted">No evidence window</span>
          )}
        </dd>
        <dt>Confirmed duration (provider)</dt>
        <dd>{t.confirmedMinutes !== null ? `${t.confirmedMinutes} min` : <strong className="rv-warn">Not confirmed</strong>}</dd>
      </dl>
    </section>
  );
}
