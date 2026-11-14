import type { SessionStatus } from "../../contracts";

export const STATUS_LABELS: Record<SessionStatus, string> = {
  SCHEDULED: "Scheduled",
  WAITING_FOR_EVIDENCE: "Waiting for evidence",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  NEEDS_REVIEW: "Needs review",
  APPROVED: "Approved — finalizing",
  COMPLETED: "Completed",
  NO_EVIDENCE: "No evidence",
  AMBIGUOUS_MATCH: "Ambiguous match",
  INCOMPLETE: "Incomplete",
  FAILED: "Failed",
};

const STATUS_ICONS: Record<SessionStatus, string> = {
  SCHEDULED: "○",
  WAITING_FOR_EVIDENCE: "…",
  QUEUED: "⋯",
  PROCESSING: "↻",
  NEEDS_REVIEW: "✎",
  APPROVED: "✓",
  COMPLETED: "✔",
  NO_EVIDENCE: "!",
  AMBIGUOUS_MATCH: "?",
  INCOMPLETE: "!",
  FAILED: "✕",
};

/** Polling continues while any session is in one of these. */
export const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "QUEUED",
  "PROCESSING",
  "APPROVED",
  "WAITING_FOR_EVIDENCE",
]);

/** Statuses whose statusReason is shown to the provider. */
export const REASON_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "NO_EVIDENCE",
  "AMBIGUOUS_MATCH",
  "INCOMPLETE",
  "FAILED",
]);

export function StatusChip({ status }: { status: SessionStatus }) {
  return (
    <span className={`chip chip-${status}`}>
      <span aria-hidden="true">{STATUS_ICONS[status]}</span>
      <span>
        <span className="sr-only">Status: </span>
        {STATUS_LABELS[status] ?? status}
      </span>
    </span>
  );
}
