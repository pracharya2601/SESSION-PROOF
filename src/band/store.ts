/**
 * D1 storage for band visits and their transcript segments. Kept separate from
 * the frozen Repository interface: only the band module and the visits API use it.
 * Audio is never stored; only final transcript text with timestamps.
 */
import { Appointment, BandSegment, Visit, type BandTransport, type Transcriber } from "../contracts";

type Row = Record<string, unknown>;

function rowToVisit(r: Row): Visit {
  return Visit.parse({
    id: r.id,
    providerId: r.provider_id,
    appointmentId: r.appointment_id,
    clientRef: r.client_ref,
    bandNumber: r.band_number === null || r.band_number === undefined ? null : Number(r.band_number),
    transport: r.transport,
    transcriber: r.transcriber,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    audioStartedAt: r.audio_started_at ?? null,
    packets: Number(r.packets ?? 0),
    lostPackets: Number(r.lost_packets ?? 0),
    segmentCount: Number(r.segment_count ?? 0),
    sessionId: r.session_id ?? null,
    scenario: r.scenario ?? null,
  });
}

function rowToSegment(r: Row): BandSegment {
  return BandSegment.parse({
    id: `${String(r.visit_id)}:${Number(r.idx)}`,
    visitId: r.visit_id,
    index: Number(r.idx),
    observedFrom: r.observed_from,
    observedTo: r.observed_to,
    speaker: r.speaker ?? null,
    text: r.text,
    sourceMode: r.source_mode,
  });
}

const VISIT_SELECT = `SELECT v.*, (SELECT COUNT(*) FROM band_segments s WHERE s.visit_id = v.id) AS segment_count FROM band_visits v`;

export interface NewVisit {
  id: string;
  providerId: string;
  appointment: Appointment;
  bandNumber: number | null;
  transport: BandTransport;
  transcriber: Transcriber;
  startedAt: string;
  scenario?: string | null;
}

export interface VisitStore {
  /** Inserts the appointment and the visit in one batch. */
  createVisit(v: NewVisit): Promise<Visit>;
  getVisit(providerId: string, visitId: string): Promise<Visit | null>;
  getVisitByAppointment(appointmentId: string): Promise<Visit | null>;
  listVisits(providerId: string, limit: number): Promise<Visit[]>;
  setAudioStarted(visitId: string, at: string): Promise<void>;
  updateStats(visitId: string, packets: number, lostPackets: number): Promise<void>;
  /** Idempotent per (visit, index). */
  saveSegment(providerId: string, segment: BandSegment, now: string): Promise<void>;
  listSegments(visitId: string): Promise<BandSegment[]>;
  /**
   * recording → stopped, and the appointment's end moves to the real stop time.
   * Returns null when the visit is not the provider's. Already stopped: returns it unchanged.
   */
  stopVisit(providerId: string, visitId: string, endedAt: string): Promise<Visit | null>;
  setSession(visitId: string, sessionId: string): Promise<void>;
  /** Most recent non-canceled appointment for this client: the template for a new visit. */
  latestAppointmentForClient(providerId: string, clientRef: string): Promise<Appointment | null>;
}

export function createVisitStore(db: D1Database): VisitStore {
  const getById = async (id: string) => {
    const r = await db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).bind(id).first<Row>();
    return r ? rowToVisit(r) : null;
  };

  return {
    async createVisit(v) {
      const a = Appointment.parse(v.appointment);
      await db.batch([
        db
          .prepare(
            `INSERT INTO appointments (id, occurrence_id, provider_id, client_ref, start_at, end_at, start_ms, end_ms, timezone,
               service_code, plan_version, rule_version, rate_version, canceled, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          )
          .bind(
            a.id, a.occurrenceId, a.providerId, a.clientRef, a.startAt, a.endAt,
            Date.parse(a.startAt), Date.parse(a.endAt), a.timezone,
            a.serviceCode, a.planVersion, a.ruleVersion, a.rateVersion, v.startedAt,
          ),
        db
          .prepare(
            `INSERT INTO band_visits (id, provider_id, appointment_id, client_ref, band_number, transport, transcriber, status, started_at, scenario)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?)`,
          )
          .bind(v.id, v.providerId, a.id, a.clientRef, v.bandNumber, v.transport, v.transcriber, v.startedAt, v.scenario ?? null),
      ]);
      const out = await getById(v.id);
      if (!out) throw new Error("visit insert failed");
      return out;
    },

    async getVisit(providerId, visitId) {
      const v = await getById(visitId);
      return v && v.providerId === providerId ? v : null;
    },

    async getVisitByAppointment(appointmentId) {
      const r = await db.prepare(`${VISIT_SELECT} WHERE v.appointment_id = ?`).bind(appointmentId).first<Row>();
      return r ? rowToVisit(r) : null;
    },

    async listVisits(providerId, limit) {
      const { results } = await db
        .prepare(`${VISIT_SELECT} WHERE v.provider_id = ? ORDER BY v.started_at DESC LIMIT ?`)
        .bind(providerId, Math.max(1, Math.min(200, limit)))
        .all<Row>();
      return results.map(rowToVisit);
    },

    async setAudioStarted(visitId, at) {
      await db
        .prepare(`UPDATE band_visits SET audio_started_at = COALESCE(audio_started_at, ?) WHERE id = ?`)
        .bind(at, visitId)
        .run();
    },

    async updateStats(visitId, packets, lostPackets) {
      await db
        .prepare(`UPDATE band_visits SET packets = MAX(packets, ?), lost_packets = MAX(lost_packets, ?) WHERE id = ?`)
        .bind(packets, lostPackets, visitId)
        .run();
    },

    async saveSegment(providerId, s, now) {
      const seg = BandSegment.parse(s);
      await db
        .prepare(
          `INSERT OR IGNORE INTO band_segments (visit_id, idx, provider_id, observed_from, observed_to, speaker, text, source_mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(seg.visitId, seg.index, providerId, seg.observedFrom, seg.observedTo, seg.speaker, seg.text, seg.sourceMode, now)
        .run();
    },

    async listSegments(visitId) {
      const { results } = await db
        .prepare(`SELECT * FROM band_segments WHERE visit_id = ? ORDER BY idx ASC`)
        .bind(visitId)
        .all<Row>();
      return results.map(rowToSegment);
    },

    async stopVisit(providerId, visitId, endedAt) {
      const v = await getById(visitId);
      if (!v || v.providerId !== providerId) return null;
      if (v.status !== "recording") return v;
      const endMs = Date.parse(endedAt);
      await db.batch([
        db
          .prepare(`UPDATE band_visits SET status = 'stopped', ended_at = ? WHERE id = ? AND status = 'recording'`)
          .bind(endedAt, visitId),
        db
          .prepare(`UPDATE appointments SET end_at = ?, end_ms = ?, updated_at = ? WHERE id = ?`)
          .bind(endedAt, endMs, endedAt, v.appointmentId),
      ]);
      return getById(visitId);
    },

    async setSession(visitId, sessionId) {
      await db.prepare(`UPDATE band_visits SET session_id = ? WHERE id = ?`).bind(sessionId, visitId).run();
    },

    async latestAppointmentForClient(providerId, clientRef) {
      const r = await db
        .prepare(
          `SELECT * FROM appointments WHERE provider_id = ? AND client_ref = ? AND canceled = 0
           ORDER BY start_ms DESC LIMIT 1`,
        )
        .bind(providerId, clientRef)
        .first<Row>();
      if (!r) return null;
      return Appointment.parse({
        id: r.id,
        occurrenceId: r.occurrence_id,
        providerId: r.provider_id,
        clientRef: r.client_ref,
        startAt: r.start_at,
        endAt: r.end_at,
        timezone: r.timezone,
        serviceCode: r.service_code,
        planVersion: r.plan_version,
        ruleVersion: r.rule_version,
        rateVersion: r.rate_version,
        canceled: false,
      });
    },
  };
}
