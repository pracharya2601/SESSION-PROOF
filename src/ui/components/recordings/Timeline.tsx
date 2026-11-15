import { hrefs } from "../../shell/routes";
import { clockOf, type SegmentTone, type TimelineLayout } from "./model";
import "./recordings.css";

export const TONE_LABELS: Record<SegmentTone, string> = {
  assigned: "Assigned",
  suggested: "Suggestion pending",
  ambiguous: "Ambiguous",
  unassigned: "Unassigned",
  pending: "Not partitioned yet",
};

/**
 * Horizontal timeline: one lane per calendar event (its window shaded), assigned segments in
 * their event's lane, everything else in "Not assigned". Segments are buttons that select the
 * matching transcript row below.
 */
export function Timeline({
  layout,
  selected,
  onSelect,
  timeZone,
}: {
  layout: TimelineLayout;
  selected: number | null;
  onSelect: (index: number) => void;
  timeZone?: string;
}) {
  return (
    <div>
      <div className="rc-tl" role="group" aria-label="Recording timeline">
        <div className="rc-tl-axis-pad" aria-hidden="true" />
        <div className="rc-tl-axis" aria-hidden="true">
          {layout.ticks.map((t) => (
            <span key={t.left} className="rc-tl-tick" style={{ left: `${t.left}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        {layout.lanes.map((lane) => (
          <div key={lane.id} style={{ display: "contents" }}>
            <div className="rc-tl-label">
              {lane.eventId ? (
                <>
                  {lane.sessionId ? (
                    <a className="mono" href={hrefs.session(lane.sessionId)} title="Open the session">
                      {lane.label}
                    </a>
                  ) : (
                    <span className="mono">{lane.label}</span>
                  )}
                  <span className="tiny muted">
                    {lane.timeLabel}
                    {lane.dismissed ? " · dismissed" : lane.sessionId ? "" : " · no session"}
                  </span>
                </>
              ) : (
                <span className="muted">{lane.label}</span>
              )}
            </div>
            <div className="rc-tl-track">
              {lane.window && (
                <div
                  className={[
                    "rc-tl-window",
                    lane.window.clippedStart && "is-clip-start",
                    lane.window.clippedEnd && "is-clip-end",
                    lane.dismissed && "is-dismissed",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: `${lane.window.left}%`, width: `${lane.window.width}%` }}
                  aria-hidden="true"
                />
              )}
              {lane.segments.map((s) => (
                <button
                  key={s.index}
                  type="button"
                  className={`rc-tl-seg rc-tone-${s.tone}${selected === s.index ? " is-selected" : ""}`}
                  style={{ left: `${s.left}%`, width: `${s.width}%` }}
                  aria-label={`Segment ${s.index}, ${clockOf(s.from, timeZone)}–${clockOf(s.to, timeZone)}, ${TONE_LABELS[s.tone]}${lane.eventId ? `, ${lane.label}` : ""}`}
                  aria-pressed={selected === s.index}
                  title={`${clockOf(s.from, timeZone)}–${clockOf(s.to, timeZone)} · ${TONE_LABELS[s.tone]}`}
                  onClick={() => onSelect(s.index)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rc-legend" aria-hidden="true">
        {(Object.keys(TONE_LABELS) as SegmentTone[]).map((t) => (
          <span key={t}>
            <i className={`rc-tone-${t}`} /> {TONE_LABELS[t]}
          </span>
        ))}
      </div>
    </div>
  );
}
