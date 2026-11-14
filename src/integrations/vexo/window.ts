import type { Appointment, EvidenceItem } from "../../contracts";

/** Buffer applied either side of the scheduled appointment when retrieving evidence. */
export const EVIDENCE_WINDOW_BUFFER_MINUTES = 60;

export function evidenceWindow(
  appointment: Appointment,
  bufferMinutes = EVIDENCE_WINDOW_BUFFER_MINUTES,
): { fromMs: number; toMs: number } {
  const buf = bufferMinutes * 60_000;
  return {
    fromMs: new Date(appointment.startAt).getTime() - buf,
    toMs: new Date(appointment.endAt).getTime() + buf,
  };
}

/**
 * True when the item overlaps the window. Items with no timestamps cannot be
 * placed in time and are excluded (callers report them as a warning).
 */
export function itemInWindow(item: EvidenceItem, w: { fromMs: number; toMs: number }): boolean {
  const from = item.observedFrom ? new Date(item.observedFrom).getTime() : null;
  const to = item.observedTo ? new Date(item.observedTo).getTime() : null;
  const start = from ?? to;
  const end = to ?? from;
  if (start === null || end === null) return false;
  return end >= w.fromMs && start <= w.toMs;
}
