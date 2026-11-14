import type { SessionStatus, SessionSummary } from "../../contracts";

/**
 * Polling while sessions are moving. Fast only while the pipeline is actually working
 * (QUEUED / PROCESSING / APPROVED finalizing); a visit still WAITING_FOR_EVIDENCE can sit there
 * for the length of the visit, so it is checked slowly. Errors back off; hidden tabs pause.
 */
export const POLL_FAST_MS = 4000;
export const POLL_SLOW_MS = 20000;
export const POLL_ERROR_MAX_MS = 60000;
export const POLL_MAX = 40;
const FAST_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["QUEUED", "PROCESSING", "APPROVED"]);

/** Delay before the next poll: by what is moving, doubled per consecutive error (capped). */
export function nextPollDelay(list: SessionSummary[] | null, consecutiveErrors: number): number {
  const base = list === null || list.some((s) => FAST_STATUSES.has(s.status)) ? POLL_FAST_MS : POLL_SLOW_MS;
  if (consecutiveErrors <= 0) return base;
  return Math.min(POLL_ERROR_MAX_MS, base * 2 ** consecutiveErrors);
}
