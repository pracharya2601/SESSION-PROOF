/**
 * Pure session matcher (Agent 08, handoff §3.2 correction 3).
 *
 * Time overlap identifies CANDIDATE evidence for an appointment. It never
 * proves who was present. When evidence could belong to more than one
 * appointment of the same provider, the result is "ambiguous" and automatic
 * attribution is blocked.
 *
 * Rules:
 *  - Window = [startAt − buffer, endAt + buffer], computed in UTC instants.
 *    Local timezone (and local midnight) is irrelevant to matching.
 *  - Interval overlap is CLOSED / INCLUSIVE at both ends: an item whose
 *    observedTo equals window.from (or observedFrom equals window.to) is
 *    eligible. One millisecond beyond the edge is not.
 *  - Competing appointments count only if same providerId, not canceled,
 *    and not the target (by id). Their windows use the same buffer.
 *  - Items with null/unparseable/inverted observed times are never eligible
 *    for automatic attribution; a warning is emitted.
 *  - Evidence text (excerpt, speaker) is never inspected: names mentioned in
 *    text are not identity proof.
 *  - "no_evidence" means a successful retrieval yielded nothing eligible.
 *    Upstream failures are thrown by the EvidenceSource, never mapped here.
 *
 * No clock access; deterministic for identical inputs.
 */
import type { Appointment, EvidenceItem, EvidenceResult, MatchEvidenceFn, MatchResult } from "../../contracts";

/**
 * Default buffer (minutes) on each side of the scheduled window. This is a
 * HEURISTIC to tolerate early starts / late finishes and clock skew between
 * calendar and recording sources — not a policy or billing rule.
 */
export const DEFAULT_MATCH_BUFFER_MINUTES = 15;

interface Interval {
  from: number;
  to: number;
}

function parseInstant(s: string | null): number | null {
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Closed-interval overlap: touching endpoints count. */
function overlaps(a: Interval, b: Interval): boolean {
  return a.from <= b.to && b.from <= a.to;
}

function bufferedWindow(appt: Appointment, bufferMs: number): Interval {
  const start = parseInstant(appt.startAt);
  const end = parseInstant(appt.endAt);
  if (start === null || end === null) {
    throw new RangeError(`appointment ${appt.id} has invalid startAt/endAt`);
  }
  return { from: start - bufferMs, to: end + bufferMs };
}

const iso = (ms: number) => new Date(ms).toISOString();

export const matchEvidence: MatchEvidenceFn = (
  appointment: Appointment,
  evidence: EvidenceResult,
  competingAppointments: Appointment[],
  options?: { bufferMinutes?: number },
): MatchResult => {
  const bufferMinutes = options?.bufferMinutes ?? DEFAULT_MATCH_BUFFER_MINUTES;
  if (!Number.isFinite(bufferMinutes) || bufferMinutes < 0) {
    throw new RangeError(`bufferMinutes must be a non-negative finite number, got ${bufferMinutes}`);
  }
  const bufferMs = bufferMinutes * 60_000;
  const target = bufferedWindow(appointment, bufferMs);
  const window = { from: iso(target.from), to: iso(target.to) };

  const reasons: string[] = [];
  const warnings: string[] = [];

  // ---- coverage warnings (partial retrieval must stay visible, §8.3.9)
  if (evidence.completeness !== "complete") {
    warnings.push(`Evidence retrieval completeness is "${evidence.completeness}"; some evidence may be missing.`);
  }
  for (const src of evidence.unavailableSourceIds) {
    warnings.push(`Evidence source unavailable: ${src}.`);
  }
  for (const w of evidence.warnings) warnings.push(w);
  if (appointment.canceled) {
    warnings.push(`Target appointment ${appointment.id} is marked canceled.`);
  }

  // ---- competitors: same provider, active, not the target
  const competitors = competingAppointments
    .filter((c) => c.id !== appointment.id && c.providerId === appointment.providerId && !c.canceled)
    .map((c) => ({ id: c.id, win: bufferedWindow(c, bufferMs) }));

  // ---- eligibility by time only (text is never read)
  const eligible: { item: EvidenceItem; iv: Interval }[] = [];
  const untimed: string[] = [];
  for (const item of evidence.items) {
    const from = parseInstant(item.observedFrom);
    const to = parseInstant(item.observedTo);
    if (from === null || to === null || from > to) {
      untimed.push(item.id);
      continue;
    }
    const iv = { from, to };
    if (overlaps(iv, target)) eligible.push({ item, iv });
  }
  if (untimed.length > 0) {
    warnings.push(
      `${untimed.length} evidence item(s) lack valid observed times and are not eligible for automatic attribution: ${untimed.join(", ")}.`,
    );
  }

  // ---- ambiguity: any eligible item also inside a competitor's window
  const competingIds = new Set<string>();
  for (const { iv } of eligible) {
    for (const c of competitors) if (overlaps(iv, c.win)) competingIds.add(c.id);
  }
  if (competingIds.size > 0) {
    const ids = [...competingIds].sort();
    reasons.push(
      `Eligible evidence also overlaps the buffered window of ${ids.length} other active appointment(s) for the same provider (${ids.join(", ")}).`,
      "Time overlap identifies candidates only and does not prove who was present; automatic attribution is blocked pending review.",
    );
    return {
      outcome: "ambiguous",
      evidence: [],
      competingAppointmentIds: ids,
      window,
      evidenceWindow: null,
      reasons,
      warnings,
    };
  }

  if (eligible.length === 0) {
    reasons.push(
      evidence.items.length === 0
        ? "Retrieval succeeded but returned no evidence items."
        : `None of the ${evidence.items.length} retrieved evidence item(s) has observed times overlapping the window ${window.from}..${window.to}.`,
    );
    if (evidence.completeness !== "complete") {
      reasons.push("Retrieval was not complete, so absence of evidence is not conclusive.");
    }
    return {
      outcome: "no_evidence",
      evidence: [],
      competingAppointmentIds: [],
      window,
      evidenceWindow: null,
      reasons,
      warnings,
    };
  }

  const minFrom = Math.min(...eligible.map((e) => e.iv.from));
  const maxTo = Math.max(...eligible.map((e) => e.iv.to));
  reasons.push(
    `${eligible.length} evidence item(s) overlap the window ${window.from}..${window.to} (buffer ${bufferMinutes} min).`,
    competitors.length === 0
      ? "No other active same-provider appointment was supplied for comparison."
      : `No overlap with ${competitors.length} other active same-provider appointment(s).`,
    "Time overlap is a candidate signal, not identity proof; provider review confirms attribution.",
  );
  return {
    outcome: "matched",
    evidence: eligible.map((e) => e.item),
    competingAppointmentIds: [],
    window,
    evidenceWindow: { from: iso(minFrom), to: iso(maxTo) },
    reasons,
    warnings,
  };
};
