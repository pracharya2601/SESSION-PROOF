import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  CircleDashed,
  Clock,
  HelpCircle,
  Loader2,
  PencilLine,
  FileQuestion,
  XCircle,
  Hourglass,
  type LucideIcon,
} from "lucide-react";
import type { SessionStatus } from "../../contracts";
import { cx } from "./cx";
import { springy } from "./motion";

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

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export const STATUS_TONES: Record<SessionStatus, StatusTone> = {
  SCHEDULED: "neutral",
  WAITING_FOR_EVIDENCE: "info",
  QUEUED: "info",
  PROCESSING: "info",
  NEEDS_REVIEW: "accent",
  APPROVED: "success",
  COMPLETED: "success",
  NO_EVIDENCE: "warning",
  AMBIGUOUS_MATCH: "warning",
  INCOMPLETE: "warning",
  FAILED: "danger",
};

const ICONS: Record<SessionStatus, LucideIcon> = {
  SCHEDULED: CircleDashed,
  WAITING_FOR_EVIDENCE: Hourglass,
  QUEUED: Clock,
  PROCESSING: Loader2,
  NEEDS_REVIEW: PencilLine,
  APPROVED: CheckCircle2,
  COMPLETED: CheckCheck,
  NO_EVIDENCE: FileQuestion,
  AMBIGUOUS_MATCH: HelpCircle,
  INCOMPLETE: AlertTriangle,
  FAILED: XCircle,
};

/** Work still in flight (pill pulses; Today polls while any session is in one of these). */
export const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["QUEUED", "PROCESSING", "APPROVED", "WAITING_FOR_EVIDENCE"]);
/** Statuses whose statusReason must be shown to the provider. */
export const REASON_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["NO_EVIDENCE", "AMBIGUOUS_MATCH", "INCOMPLETE", "FAILED"]);

export interface StatusPillProps {
  status: SessionStatus;
  size?: "sm" | "md";
  className?: string;
  /** Pass a stable id to animate the pill's layout across re-renders/lists. */
  layoutId?: string;
}

export function StatusPill({ status, size = "md", className, layoutId }: StatusPillProps) {
  const reduce = useReducedMotion();
  const Icon = ICONS[status] ?? CircleDashed;
  const active = ACTIVE_STATUSES.has(status);
  return (
    <motion.span
      layout={!reduce}
      layoutId={layoutId}
      transition={springy}
      className={cx("ds-pill", `ds-pill-${size}`, `ds-tone-${STATUS_TONES[status] ?? "neutral"}`, active && "ds-pill-active", className)}
      data-status={status}
    >
      <span className="ds-pill-ico" aria-hidden="true">
        {active && <span className="ds-pill-pulse" />}
        <Icon size={size === "sm" ? 12 : 14} className={status === "PROCESSING" ? "ds-spin" : undefined} />
      </span>
      <motion.span
        key={status}
        initial={reduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <span className="sr-only">Status: </span>
        {STATUS_LABELS[status] ?? status}
      </motion.span>
    </motion.span>
  );
}
