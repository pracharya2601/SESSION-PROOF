/**
 * Evidence for calendar appointments (id prefix appt_cal_): the provider's recording segments
 * the partitioner ASSIGNED to that appointment, across ALL recordings (one visit can span two
 * recordings, e.g. a band reconnect or a phone restart). Unassigned and ambiguous segments are
 * never evidence. Evidence ids are ev_001… in time order, so they are stable per session for
 * the same set of segments. Routing is by appointment id, never a fallback.
 */
import type { Appointment, EvidenceItem, EvidenceResult, EvidenceSource, SourceMode } from "../contracts";
import { evidenceIdFor } from "../band/evidence";
import { CALENDAR_APPOINTMENT_PREFIX } from "./contract";
import type { RecordingRow, RecordingStore } from "./store";

/** A stretch of the event with no recording running, between two recordings, longer than this is flagged. */
export const RECORDING_GAP_WARN_MS = 2 * 60_000;

export function isCalendarAppointment(a: Pick<Appointment, "id">): boolean {
  return a.id.startsWith(CALENDAR_APPOINTMENT_PREFIX);
}

function span(r: RecordingRow, nowMs: number): { from: number; to: number } {
  const from = Date.parse(r.audioStartedAt ?? r.recording.startedAt);
  const to = r.recording.endedAt ? Date.parse(r.recording.endedAt) : nowMs;
  return { from, to: Math.max(from, to) };
}

/** Uncovered stretches strictly between recordings, inside [start, end]. */
export function interiorGaps(intervals: { from: number; to: number }[], start: number, end: number): { from: number; to: number }[] {
  const ivs = intervals
    .map((i) => ({ from: Math.max(start, i.from), to: Math.min(end, i.to) }))
    .filter((i) => i.to > i.from)
    .sort((a, b) => a.from - b.from);
  const gaps: { from: number; to: number }[] = [];
  let cur: { from: number; to: number } | null = null;
  for (const i of ivs) {
    if (!cur) cur = { ...i };
    else if (i.from <= cur.to) cur.to = Math.max(cur.to, i.to);
    else {
      gaps.push({ from: cur.to, to: i.from });
      cur = { ...i };
    }
  }
  return gaps;
}

export class RecordingEvidenceSource implements EvidenceSource {
  readonly mode: SourceMode = "live";
  constructor(
    private readonly store: RecordingStore,
    private readonly now: () => Date,
  ) {}

  private async contributing(appointment: Appointment) {
    const segs = await this.store.listAssignedSegments(appointment.providerId, appointment.id);
    const recs = await this.store.listByIds(appointment.providerId, segs.map((s) => s.recordingId));
    return { segs, recs };
  }

  async modeFor(appointment: Appointment): Promise<SourceMode> {
    const { recs } = await this.contributing(appointment);
    return recs.some((r) => r.recording.transcriber !== "deepgram") ? "fixture" : "live";
  }

  async retrieveEvidence(appointment: Appointment): Promise<EvidenceResult> {
    const { segs, recs } = await this.contributing(appointment);
    const ambiguous = await this.store.countAmbiguous(appointment.providerId, appointment.id);
    const warnings: string[] = [];
    const byContent = await this.store.countContentAssigned(appointment.providerId, appointment.id);
    if (byContent > 0) warnings.push(`${byContent} line${byContent === 1 ? "" : "s"} assigned by provider from content suggestion.`);
    if (ambiguous > 0) {
      warnings.push(`${ambiguous} transcript segment(s) near this appointment could belong to another appointment too and were left out (ambiguous).`);
    }
    if (segs.length === 0) {
      return { items: [], completeness: "unknown", unavailableSourceIds: [], warnings: ["No recording segments were assigned to this appointment.", ...warnings] };
    }
    const retrievedAt = this.now().toISOString();
    const items: EvidenceItem[] = segs.map((s, i) => ({
      id: evidenceIdFor(i + 1),
      sourceId: `recording:${s.recordingId}`,
      sourceMode: s.segment.sourceMode,
      observedFrom: s.segment.observedFrom,
      observedTo: s.segment.observedTo,
      speaker: s.segment.speaker,
      excerpt: s.segment.text.slice(0, 4000),
      retrievedAt,
    }));

    if (recs.some((r) => r.recording.transcriber === "simulated")) warnings.push("Simulated transcript (synthetic, dev only): not a real recording.");
    if (recs.some((r) => r.recording.status === "recording")) warnings.push("A recording was not stopped; the transcript may be incomplete.");
    const packets = recs.reduce((n, r) => n + r.recording.packets, 0);
    const lost = recs.reduce((n, r) => n + r.recording.lostPackets, 0);
    if (lost > 0) {
      const pct = Math.round((lost / (packets + lost)) * 1000) / 10;
      warnings.push(`${lost} audio packet(s) (${pct}%) were lost on the Bluetooth link.`);
    }
    if (recs.length > 1) warnings.push(`This visit's transcript comes from ${recs.length} recordings.`);
    // Gaps between recordings inside the scheduled event (all the provider's recordings count).
    const start = Date.parse(appointment.startAt);
    const end = Date.parse(appointment.endAt);
    const nowMs = this.now().getTime();
    const around = await this.store.listOverlapping(appointment.providerId, appointment.startAt, appointment.endAt);
    const gaps = interiorGaps(around.map((r) => span(r, nowMs)), start, end).filter((g) => g.to - g.from > RECORDING_GAP_WARN_MS);
    for (const g of gaps) {
      warnings.push(`No recording ran for ${Math.round((g.to - g.from) / 60_000)} min inside the appointment (${new Date(g.from).toISOString()} – ${new Date(g.to).toISOString()}).`);
    }
    const complete = lost === 0 && gaps.length === 0 && ambiguous === 0 && recs.every((r) => r.recording.status === "partitioned" || r.recording.status === "stopped");
    return { items, completeness: complete ? "complete" : "partial", unavailableSourceIds: [], warnings };
  }
}

/** Routes calendar appointments to recording evidence, everything else to `other`. */
export class RecordingRoutingEvidenceSource implements EvidenceSource {
  constructor(
    private readonly recordings: RecordingEvidenceSource,
    private readonly other: EvidenceSource,
  ) {}

  get mode(): SourceMode {
    return this.other.mode;
  }

  async modeFor(appointment: Appointment): Promise<SourceMode> {
    if (isCalendarAppointment(appointment)) return this.recordings.modeFor(appointment);
    return this.other.modeFor ? this.other.modeFor(appointment) : this.other.mode;
  }

  retrieveEvidence(appointment: Appointment): Promise<EvidenceResult> {
    return isCalendarAppointment(appointment) ? this.recordings.retrieveEvidence(appointment) : this.other.retrieveEvidence(appointment);
  }
}
