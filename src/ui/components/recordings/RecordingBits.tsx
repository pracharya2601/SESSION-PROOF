import type { Recording } from "../../../contracts";
import { clockOf, dateOf, formatSpan, partitionChips, recordingDurationMs } from "./model";
import "./recordings.css";

/** Partition chips for one recording ("2 sessions · 1 unassigned · 1 suggestion"). */
export function RecordingChips({ recording, suggestions, archived }: { recording: Recording; suggestions: number | null; archived?: boolean }) {
  const chips = partitionChips(recording, suggestions);
  return (
    <span className="rc-chips">
      {chips.map((c) => (
        <span key={c.key} className={`rc-chip rc-chip-${c.tone}`}>
          {c.label}
        </span>
      ))}
      {archived && <span className="rc-chip rc-chip-archived">Archived</span>}
    </span>
  );
}

export function recordingDeleteNotes(r: Recording): string[] {
  const n = r.partition?.sessions.length ?? 0;
  return [
    `Deletes the transcript text of all ${r.segmentCount} segment${r.segmentCount === 1 ? "" : "s"}, their assignments and the recording itself.`,
    n > 0
      ? `The ${n} session${n === 1 ? "" : "s"} built from it keep${n === 1 ? "s" : ""} their evidence: each draft already holds a frozen copy of the excerpts it uses.`
      : "No session was built from this recording.",
    "Pending client suggestions for it are removed.",
    "An audit entry (who, when, which recording) is kept. No content is kept.",
  ];
}

export function recordingSummary(r: Recording) {
  return [
    { label: "Recorded", value: `${dateOf(r.startedAt)}, ${clockOf(r.startedAt)}${r.endedAt ? `–${clockOf(r.endedAt)}` : ""}` },
    { label: "Duration", value: formatSpan(recordingDurationMs(r)) },
    { label: "Segments", value: String(r.segmentCount) },
    { label: "Sessions", value: (r.partition?.sessions ?? []).map((s) => s.clientRef).join(", ") || "None" },
  ];
}

