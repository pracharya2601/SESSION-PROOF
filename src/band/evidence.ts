/**
 * Evidence from band visits. An appointment created by a visit (id prefix
 * appt_visit_) gets its evidence from that visit's stored transcript segments;
 * every other appointment keeps the configured source (fixture or live Vexo).
 * This is routing by appointment, not a fallback: a band appointment never
 * reads fixtures, and a fixture appointment never reads band data.
 */
import {
  VISIT_APPOINTMENT_PREFIX,
  type Appointment,
  type EvidenceItem,
  type EvidenceResult,
  type EvidenceSource,
  type SourceMode,
} from "../contracts";
import { evidenceWindow, itemInWindow } from "../integrations/vexo/window";
import type { VisitStore } from "./store";

export function isVisitAppointment(a: Pick<Appointment, "id">): boolean {
  return a.id.startsWith(VISIT_APPOINTMENT_PREFIX);
}

export function evidenceIdFor(index: number): string {
  return `ev_${String(index).padStart(3, "0")}`;
}

export class BandEvidenceSource implements EvidenceSource {
  /** Default label; the real mode per appointment comes from modeFor(). */
  readonly mode: SourceMode = "live";
  constructor(
    private readonly store: VisitStore,
    private readonly now: () => Date,
  ) {}

  async modeFor(appointment: Appointment): Promise<SourceMode> {
    const visit = await this.store.getVisitByAppointment(appointment.id);
    return visit?.transcriber === "deepgram" ? "live" : "fixture";
  }

  async retrieveEvidence(appointment: Appointment): Promise<EvidenceResult> {
    const visit = await this.store.getVisitByAppointment(appointment.id);
    if (!visit || visit.providerId !== appointment.providerId) {
      return { items: [], completeness: "unknown", unavailableSourceIds: [], warnings: ["No band recording is linked to this appointment."] };
    }
    const segments = await this.store.listSegments(visit.id);
    const retrievedAt = this.now().toISOString();
    const sourceId = `band_visit:${visit.id}`;
    const all: EvidenceItem[] = segments.map((s) => ({
      id: evidenceIdFor(s.index),
      sourceId,
      sourceMode: s.sourceMode,
      observedFrom: s.observedFrom,
      observedTo: s.observedTo,
      speaker: s.speaker,
      excerpt: s.text.slice(0, 4000),
      retrievedAt,
    }));
    const w = evidenceWindow(appointment);
    const items = all.filter((i) => itemInWindow(i, w)).slice(0, 500);
    const warnings: string[] = [];
    if (visit.transcriber === "simulated") warnings.push("Simulated transcript (synthetic, dev only): not a real recording.");
    if (visit.status === "recording") warnings.push("The band recording was not stopped; the transcript may be incomplete.");
    if (visit.lostPackets > 0) {
      const pct = visit.packets > 0 ? Math.round((visit.lostPackets / (visit.packets + visit.lostPackets)) * 1000) / 10 : 0;
      warnings.push(`${visit.lostPackets} audio packet(s) (${pct}%) were lost on the Bluetooth link.`);
    }
    if (all.length > items.length) warnings.push(`${all.length - items.length} transcript segment(s) fell outside the visit window.`);
    return {
      items,
      completeness: visit.status === "stopped" && visit.lostPackets === 0 ? "complete" : "partial",
      unavailableSourceIds: [],
      warnings,
    };
  }
}

/** Routes visit appointments to the band source, everything else to the configured one. */
export class VisitRoutingEvidenceSource implements EvidenceSource {
  constructor(
    private readonly band: BandEvidenceSource,
    private readonly other: EvidenceSource,
  ) {}

  get mode(): SourceMode {
    return this.other.mode;
  }

  async modeFor(appointment: Appointment): Promise<SourceMode> {
    return isVisitAppointment(appointment) ? this.band.modeFor(appointment) : this.other.mode;
  }

  retrieveEvidence(appointment: Appointment): Promise<EvidenceResult> {
    return isVisitAppointment(appointment) ? this.band.retrieveEvidence(appointment) : this.other.retrieveEvidence(appointment);
  }
}
