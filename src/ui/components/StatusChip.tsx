/** v1 compatibility shim — the canonical implementation is design/StatusPill. */
import type { SessionStatus } from "../../contracts";
import { StatusPill } from "../design/StatusPill";

export { STATUS_LABELS, ACTIVE_STATUSES, REASON_STATUSES } from "../design/StatusPill";

export function StatusChip({ status }: { status: SessionStatus }) {
  return <StatusPill status={status} size="sm" />;
}
