/**
 * D1 storage for offline recordings (migrations/0010_offline_visits.sql). The visit itself is a
 * normal band_visits row (status "stopped" from the start: it happened in the past); this table
 * tracks the upload / transcription state. Its appointment is created canceled = 1 so discovery
 * and overlap checks ignore it until the transcript is stored (releaseAppointment).
 * Holds ids, times, sizes and error codes only: never audio or transcript text.
 */
import { Appointment, type Transcriber } from "../contracts";

type Row = Record<string, unknown>;

export type OfflineRowStatus = "awaiting_audio" | "transcribing" | "transcribed" | "failed";

export interface OfflineRow {
  visitId: string;
  providerId: string;
  deviceId: string;
  localId: string;
  status: OfflineRowStatus;
  recordedFrom: string;
  recordedTo: string;
  consentConfirmedAt: string;
  audioKey: string | null;
  audioBytes: number | null;
  uploadedAt: string | null;
  attempts: number;
  error: { code: string; message: string; retryable: boolean } | null;
  audioDeleteAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRow(r: Row): OfflineRow {
  return {
    visitId: String(r.visit_id),
    providerId: String(r.provider_id),
    deviceId: String(r.device_id),
    localId: String(r.local_id),
    status: String(r.status) as OfflineRowStatus,
    recordedFrom: String(r.recorded_from),
    recordedTo: String(r.recorded_to),
    consentConfirmedAt: String(r.consent_confirmed_at),
    audioKey: (r.audio_key as string | null) ?? null,
    audioBytes: r.audio_bytes === null || r.audio_bytes === undefined ? null : Number(r.audio_bytes),
    uploadedAt: (r.uploaded_at as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    error: r.error_code
      ? { code: String(r.error_code), message: String(r.error_message ?? ""), retryable: Number(r.error_retryable) === 1 }
      : null,
    audioDeleteAfter: (r.audio_delete_after as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export interface NewOfflineVisit {
  visitId: string;
  providerId: string;
  deviceId: string;
  localId: string;
  appointment: Appointment;
  bandNumber: number | null;
  transcriber: Transcriber;
  recordedFrom: string;
  recordedTo: string;
  consentConfirmedAt: string;
  now: string;
}

export interface OfflineStore {
  /** Appointment (canceled) + stopped band visit + offline row, atomically. Throws on a (device, localId) clash. */
  create(v: NewOfflineVisit): Promise<OfflineRow>;
  getByLocalId(deviceId: string, localId: string): Promise<OfflineRow | null>;
  /** null when not the provider's. */
  get(providerId: string, visitId: string): Promise<OfflineRow | null>;
  /** awaiting_audio|failed → transcribing with this object. False when the row was in another state. */
  markUploaded(visitId: string, a: { key: string; bytes: number; now: string }): Promise<boolean>;
  /** Queue send failed after markUploaded: back to awaiting_audio; the object is swept after `deleteAfter`. */
  revertUpload(visitId: string, now: string, deleteAfter: string): Promise<void>;
  startAttempt(visitId: string, attempt: number, now: string): Promise<void>;
  markTranscribed(visitId: string, now: string): Promise<void>;
  markFailed(visitId: string, f: { code: string; message: string; retryable: boolean; deleteAfter: string | null; now: string }): Promise<void>;
  /** The R2 object is gone. */
  clearAudio(visitId: string, now: string): Promise<void>;
  /** Ask the sweep to delete the object (e.g. a delete right after transcription failed). */
  scheduleAudioDelete(visitId: string, at: string): Promise<void>;
  /** Un-cancel the visit appointment so it is processed like any stopped visit. */
  releaseAppointment(appointmentId: string, now: string): Promise<void>;
  listAudioDue(now: string, limit: number): Promise<OfflineRow[]>;
  listStuck(updatedBefore: string, limit: number): Promise<OfflineRow[]>;
}

export function createOfflineStore(db: D1Database): OfflineStore {
  const byId = async (id: string) => {
    const r = await db.prepare(`SELECT * FROM offline_visits WHERE visit_id = ?`).bind(id).first<Row>();
    return r ? toRow(r) : null;
  };
  return {
    async create(v) {
      const a = Appointment.parse(v.appointment);
      await db.batch([
        db
          .prepare(
            `INSERT INTO appointments (id, occurrence_id, provider_id, client_ref, start_at, end_at, start_ms, end_ms, timezone,
               service_code, plan_version, rule_version, rate_version, canceled, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .bind(
            a.id, a.occurrenceId, a.providerId, a.clientRef, a.startAt, a.endAt,
            Date.parse(a.startAt), Date.parse(a.endAt), a.timezone,
            a.serviceCode, a.planVersion, a.ruleVersion, a.rateVersion, v.now,
          ),
        db
          .prepare(
            `INSERT INTO band_visits (id, provider_id, appointment_id, client_ref, band_number, transport, transcriber, status, started_at, ended_at)
             VALUES (?, ?, ?, ?, ?, 'ble', ?, 'stopped', ?, ?)`,
          )
          .bind(v.visitId, v.providerId, a.id, a.clientRef, v.bandNumber, v.transcriber, v.recordedFrom, v.recordedTo),
        db
          .prepare(
            `INSERT INTO offline_visits (visit_id, provider_id, device_id, local_id, status, recorded_from, recorded_to,
               consent_confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'awaiting_audio', ?, ?, ?, ?, ?)`,
          )
          .bind(v.visitId, v.providerId, v.deviceId, v.localId, v.recordedFrom, v.recordedTo, v.consentConfirmedAt, v.now, v.now),
      ]);
      const out = await byId(v.visitId);
      if (!out) throw new Error("offline visit insert failed");
      return out;
    },

    async getByLocalId(deviceId, localId) {
      const r = await db.prepare(`SELECT * FROM offline_visits WHERE device_id = ? AND local_id = ?`).bind(deviceId, localId).first<Row>();
      return r ? toRow(r) : null;
    },

    async get(providerId, visitId) {
      const r = await byId(visitId);
      return r && r.providerId === providerId ? r : null;
    },

    async markUploaded(visitId, a) {
      const r = await db
        .prepare(
          `UPDATE offline_visits SET status = 'transcribing', audio_key = ?, audio_bytes = ?, uploaded_at = ?, attempts = 0,
             error_code = NULL, error_message = NULL, error_retryable = NULL, audio_delete_after = NULL, updated_at = ?
           WHERE visit_id = ? AND status IN ('awaiting_audio', 'failed')`,
        )
        .bind(a.key, a.bytes, a.now, a.now, visitId)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async revertUpload(visitId, now, deleteAfter) {
      await db
        .prepare(`UPDATE offline_visits SET status = 'awaiting_audio', audio_delete_after = ?, updated_at = ? WHERE visit_id = ? AND status = 'transcribing'`)
        .bind(deleteAfter, now, visitId)
        .run();
    },

    async startAttempt(visitId, attempt, now) {
      await db
        .prepare(`UPDATE offline_visits SET status = 'transcribing', attempts = MAX(attempts, ?), updated_at = ? WHERE visit_id = ? AND status = 'transcribing'`)
        .bind(attempt, now, visitId)
        .run();
    },

    async markTranscribed(visitId, now) {
      await db
        .prepare(
          `UPDATE offline_visits SET status = 'transcribed', error_code = NULL, error_message = NULL, error_retryable = NULL, updated_at = ?
           WHERE visit_id = ?`,
        )
        .bind(now, visitId)
        .run();
    },

    async markFailed(visitId, f) {
      await db
        .prepare(
          `UPDATE offline_visits SET status = 'failed', error_code = ?, error_message = ?, error_retryable = ?,
             audio_delete_after = CASE WHEN audio_key IS NULL THEN NULL ELSE ? END, updated_at = ?
           WHERE visit_id = ? AND status <> 'transcribed'`,
        )
        .bind(f.code, f.message.slice(0, 300), f.retryable ? 1 : 0, f.deleteAfter, f.now, visitId)
        .run();
    },

    async clearAudio(visitId, now) {
      await db
        .prepare(`UPDATE offline_visits SET audio_key = NULL, audio_delete_after = NULL, updated_at = ? WHERE visit_id = ?`)
        .bind(now, visitId)
        .run();
    },

    async scheduleAudioDelete(visitId, at) {
      await db.prepare(`UPDATE offline_visits SET audio_delete_after = ? WHERE visit_id = ? AND audio_key IS NOT NULL`).bind(at, visitId).run();
    },

    async releaseAppointment(appointmentId, now) {
      await db.prepare(`UPDATE appointments SET canceled = 0, updated_at = ? WHERE id = ?`).bind(now, appointmentId).run();
    },

    async listAudioDue(now, limit) {
      const { results } = await db
        .prepare(`SELECT * FROM offline_visits WHERE audio_key IS NOT NULL AND audio_delete_after IS NOT NULL AND audio_delete_after <= ? LIMIT ?`)
        .bind(now, limit)
        .all<Row>();
      return results.map(toRow);
    },

    async listStuck(updatedBefore, limit) {
      const { results } = await db
        .prepare(`SELECT * FROM offline_visits WHERE status = 'transcribing' AND updated_at < ? LIMIT ?`)
        .bind(updatedBefore, limit)
        .all<Row>();
      return results.map(toRow);
    },
  };
}
