/**
 * D1 storage for recordings (migrations/0011_recordings.sql). Segments are band_segments rows
 * keyed by the recording id, so the visit store's segment methods are reused as is.
 * Holds ids, times, counts and transcript segments; never audio. Every read that takes a
 * providerId is scoped to it.
 */
import { BandSegment, ConversationAssessment, Recording, Suggestion, type BandTransport, type ConversationType } from "../contracts";
import { createVisitStore } from "../band/store";
import type { CaptureStore } from "../band/capture";
import { notArchivedSql } from "../archive";

type Row = Record<string, unknown>;

export type RecordingTranscriber = Recording["transcriber"];
export type RecordingPartition = NonNullable<Recording["partition"]>;

/** Recording plus the server-side fields the contract does not expose. */
export interface RecordingRow {
  recording: Recording;
  deviceId: string | null;
  origin: "live" | "offline";
  audioStartedAt: string | null;
  timezone: string | null;
  scenario: string | null;
  attempts: number;
  /** Partition failure code (status "failed"), else null. */
  errorCode: string | null;
  updatedAt: string;
}

export interface NewRecording {
  id: string;
  providerId: string;
  deviceId: string | null;
  bandNumber: number | null;
  transport: BandTransport;
  transcriber: RecordingTranscriber;
  startedAt: string;
  timezone: string | null;
  scenario: string | null;
  now: string;
}

/** calendar_time: pass 1 (time rule). provider_confirmed_content: the provider accepted a content suggestion. */
export type AssignmentMethod = "calendar_time" | "provider_confirmed_content";

/** Unassigned text covered by a PENDING content suggestion with a client is kept this long (else 24 h). */
export const SUGGESTION_TEXT_RETENTION_MS = 7 * 24 * 3600_000;
/** Must match partition.ts UNASSIGNED_TEXT_RETENTION_MS (the sweep passes now − 24 h). */
const BASE_TEXT_RETENTION_MS = 24 * 3600_000;

export interface AssignmentRow {
  recordingId: string;
  index: number;
  providerId: string;
  status: "assigned" | "unassigned" | "ambiguous";
  eventId: string | null;
  appointmentId: string | null;
  candidateEventIds: string[];
  candidateAppointmentIds: string[];
  observedFrom: string;
  observedTo: string;
  partitionedAt: string;
  textDeletedAt: string | null;
  /** Absent → calendar_time. */
  method?: AssignmentMethod;
}

/** A conversation-type row (migrations/0014): one per (recording, scope_key). */
export interface ConversationRow {
  recordingId: string;
  /** "event:<eventId>" | "suggestion:<id>" */
  scopeKey: string;
  providerId: string;
  appointmentId: string | null;
  segmentCount: number;
  conversationType: ConversationType;
  confidence: number;
  method: "rules" | "ai+rules";
  signals: ConversationAssessment["signals"];
  providerDecision: "client_session" | "dismissed" | null;
  decidedAt: string | null;
  updatedAt: string;
}

/** A content suggestion as stored (the contract type; provider id kept for scoping). */
export type SuggestionRow = Suggestion & { providerId: string };

export interface HandoffRow {
  recordingId: string;
  eventId: string;
  providerId: string;
  appointmentId: string;
  clientRef: string;
  sessionId: string;
  segmentCount: number;
  handedOffAt: string;
}

export interface AssignedSegment {
  recordingId: string;
  segment: BandSegment;
}

export interface RecordingStore {
  create(r: NewRecording): Promise<Recording>;
  /** null when missing or not the provider's. */
  get(providerId: string, id: string): Promise<RecordingRow | null>;
  /** Newest first. Archived recordings (archived_items) are left out unless opts.includeArchived. */
  list(providerId: string, limit: number, opts?: { includeArchived?: boolean }): Promise<Recording[]>;
  /** The CaptureSession / offline-job writer for this recording's segments and stats. */
  capture: CaptureStore & { deleteSegments(id: string): Promise<void>; saveSegments(providerId: string, s: BandSegment[], now: string): Promise<void> };
  /** recording → stopped. null when not the provider's; other states: returned unchanged. */
  stop(providerId: string, id: string, endedAt: string): Promise<RecordingRow | null>;
  startAttempt(id: string, attempt: number, now: string): Promise<void>;
  listAssignments(recordingId: string): Promise<AssignmentRow[]>;
  /** Upserts assignment rows (keeps text_deleted_at). */
  saveAssignments(rows: AssignmentRow[]): Promise<void>;
  listHandoffs(recordingId: string): Promise<HandoffRow[]>;
  saveHandoff(h: HandoffRow): Promise<void>;
  markPartitioned(id: string, partition: RecordingPartition, now: string): Promise<void>;
  markFailed(id: string, code: string, now: string): Promise<void>;
  /** offline_visits status for an offline recording, or null (live recording). */
  offlineState(id: string): Promise<string | null>;

  // evidence
  /** Assigned segments (with text) of this appointment across ALL the provider's recordings, by time. */
  listAssignedSegments(providerId: string, appointmentId: string): Promise<AssignedSegment[]>;
  countAmbiguous(providerId: string, appointmentId: string): Promise<number>;
  /** The provider's recordings whose [start, end] overlaps [from, to]. */
  listOverlapping(providerId: string, from: string, to: string): Promise<RecordingRow[]>;
  /** Provider-scoped batch lookup. */
  listByIds(providerId: string, ids: string[]): Promise<RecordingRow[]>;
  /** Sessions this recording handed segments to (for the web view). */
  sessionIdsByEvent(recordingId: string): Promise<Map<string, { sessionId: string; clientRef: string }>>;

  // sweeps
  listUnassignedTextDue(partitionedBefore: string, limit: number): Promise<AssignmentRow[]>;
  deleteSegmentText(recordingId: string, index: number, now: string): Promise<void>;
  listByStatus(status: Recording["status"], updatedBefore: string, limit: number): Promise<RecordingRow[]>;

  // content suggestions (pass 2, migrations/0014_assignment_suggestions.sql)
  listSuggestions(recordingId: string): Promise<SuggestionRow[]>;
  getSuggestion(providerId: string, recordingId: string, id: string): Promise<SuggestionRow | null>;
  /** Inserts new suggestions; an existing id is left untouched (decisions are never overwritten). */
  insertSuggestions(rows: SuggestionRow[]): Promise<void>;
  /** pending → accepted|rejected. false when it was not pending (raced / already decided). */
  decideSuggestion(id: string, status: "accepted" | "rejected", now: string, acceptedClientRef: string | null): Promise<boolean>;
  /** Accepted → back to pending (the accept failed after the claim). */
  reopenSuggestion(id: string): Promise<void>;
  setSuggestionTarget(id: string, appointmentId: string, sessionId: string): Promise<void>;
  /** Upserts provider-confirmed assignments (method provider_confirmed_content). */
  saveContentAssignments(rows: AssignmentRow[]): Promise<void>;
  /** Segments of this appointment assigned by the provider from a content suggestion. */
  countContentAssigned(providerId: string, appointmentId: string): Promise<number>;

  // conversation types (migrations/0014)
  /** Upserts the classification; an existing provider decision is kept. */
  saveConversation(row: Omit<ConversationRow, "providerDecision" | "decidedAt">): Promise<void>;
  listConversations(recordingId: string): Promise<ConversationRow[]>;
  /** The provider's rows for this appointment across all recordings. */
  listConversationsForAppointment(providerId: string, appointmentId: string): Promise<ConversationRow[]>;
  /** Records the provider's decision on every row of this appointment. Returns rows changed. */
  decideConversation(providerId: string, appointmentId: string, decision: "client_session" | "dismissed", now: string): Promise<number>;
}

const SELECT = `SELECT r.*,
  (SELECT COUNT(*) FROM band_segments s WHERE s.visit_id = r.id)
  + (SELECT COUNT(*) FROM recording_segment_assignments a WHERE a.recording_id = r.id AND a.text_deleted_at IS NOT NULL) AS segment_count
  FROM recordings r`;

function parsePartition(raw: unknown): Recording["partition"] {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return Recording.shape.partition.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function toRow(r: Row): RecordingRow {
  const recording = Recording.parse({
    id: r.id,
    providerId: r.provider_id,
    bandNumber: r.band_number === null || r.band_number === undefined ? null : Number(r.band_number),
    transcriber: r.transcriber,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    packets: Number(r.packets ?? 0),
    lostPackets: Number(r.lost_packets ?? 0),
    segmentCount: Number(r.segment_count ?? 0),
    consentConfirmedAt: (r.consent_confirmed_at as string | null) ?? null,
    partition: parsePartition(r.partition_json),
  });
  return {
    recording,
    deviceId: (r.device_id as string | null) ?? null,
    origin: r.origin === "offline" ? "offline" : "live",
    audioStartedAt: (r.audio_started_at as string | null) ?? null,
    timezone: (r.timezone as string | null) ?? null,
    scenario: (r.scenario as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    errorCode: (r.error_code as string | null) ?? null,
    updatedAt: String(r.updated_at),
  };
}

function jsonList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toAssignment(r: Row): AssignmentRow {
  return {
    recordingId: String(r.recording_id),
    index: Number(r.idx),
    providerId: String(r.provider_id),
    status: String(r.status) as AssignmentRow["status"],
    eventId: (r.event_id as string | null) ?? null,
    appointmentId: (r.appointment_id as string | null) ?? null,
    candidateEventIds: jsonList(r.candidate_event_ids),
    candidateAppointmentIds: jsonList(r.candidate_appointment_ids),
    observedFrom: String(r.observed_from),
    observedTo: String(r.observed_to),
    partitionedAt: String(r.partitioned_at),
    textDeletedAt: (r.text_deleted_at as string | null) ?? null,
    method: r.method === "provider_confirmed_content" ? "provider_confirmed_content" : "calendar_time",
  };
}

function intList(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

function toConversation(r: Row): ConversationRow {
  let signals: ConversationAssessment["signals"];
  try {
    signals = ConversationAssessment.shape.signals.parse(JSON.parse(String(r.signals_json)));
  } catch {
    signals = { speakers: 0, participantVoice: false, planTermHits: 0, workTermHits: 0, otherClientRefs: 0, familyTermHits: 0, phoneCues: 0, personalTermHits: 0, eventTitleHint: null };
  }
  const d = r.provider_decision;
  return {
    recordingId: String(r.recording_id),
    scopeKey: String(r.scope_key),
    providerId: String(r.provider_id),
    appointmentId: (r.appointment_id as string | null) ?? null,
    segmentCount: Number(r.segment_count ?? 0),
    conversationType: ConversationAssessment.shape.conversationType.catch("unclear").parse(r.conversation_type),
    confidence: Number(r.confidence ?? 0),
    method: r.method === "ai+rules" ? "ai+rules" : "rules",
    signals,
    providerDecision: d === "client_session" || d === "dismissed" ? d : null,
    decidedAt: (r.decided_at as string | null) ?? null,
    updatedAt: String(r.updated_at),
  };
}

function toSuggestion(r: Row): SuggestionRow {
  const s = Suggestion.parse({
    id: r.id,
    recordingId: r.recording_id,
    segmentIndexes: intList(r.segment_indexes),
    from: r.observed_from,
    to: r.observed_to,
    suggestedClientRef: (r.suggested_client_ref as string | null) ?? null,
    eventId: (r.event_id as string | null) ?? null,
    kind: r.kind,
    confidence: Number(r.confidence),
    method: r.method,
    rationale: r.rationale,
    candidateClientRefs: jsonList(r.candidate_client_refs),
    status: r.status,
    createdAt: r.created_at,
    decidedAt: (r.decided_at as string | null) ?? null,
    acceptedClientRef: (r.accepted_client_ref as string | null) ?? null,
    appointmentId: (r.appointment_id as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
  });
  return { ...s, providerId: String(r.provider_id) };
}

const BATCH = 50;

export function createRecordingStore(db: D1Database): RecordingStore {
  const segments = createVisitStore(db);
  const byId = async (id: string) => {
    const r = await db.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<Row>();
    return r ? toRow(r) : null;
  };
  const touch = (id: string, sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds, id).run();

  return {
    async create(n) {
      await db
        .prepare(
          `INSERT INTO recordings (id, provider_id, device_id, band_number, transport, transcriber, status, origin, started_at,
             timezone, scenario, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'recording', 'live', ?, ?, ?, ?, ?)`,
        )
        .bind(n.id, n.providerId, n.deviceId, n.bandNumber, n.transport, n.transcriber, n.startedAt, n.timezone, n.scenario, n.now, n.now)
        .run();
      const out = await byId(n.id);
      if (!out) throw new Error("recording insert failed");
      return out.recording;
    },

    async get(providerId, id) {
      const r = await byId(id);
      return r && r.recording.providerId === providerId ? r : null;
    },

    async list(providerId, limit, opts) {
      const archived = opts?.includeArchived ? "" : ` AND ${notArchivedSql("recording", "r.id", "r.provider_id")}`;
      const { results } = await db
        .prepare(`${SELECT} WHERE r.provider_id = ?${archived} ORDER BY r.started_at DESC LIMIT ?`)
        .bind(providerId, Math.max(1, Math.min(200, limit)))
        .all<Row>();
      return results.map((r) => toRow(r).recording);
    },

    capture: {
      listSegments: (id) => segments.listSegments(id),
      saveSegment: (providerId, s, now) => segments.saveSegment(providerId, s, now),
      saveSegments: (providerId, s, now) => segments.saveSegments(providerId, s, now),
      deleteSegments: (id) => segments.deleteSegments(id),
      async setAudioStarted(id, at) {
        await db.prepare(`UPDATE recordings SET audio_started_at = COALESCE(audio_started_at, ?) WHERE id = ?`).bind(at, id).run();
      },
      async updateStats(id, packets, lostPackets) {
        await db
          .prepare(`UPDATE recordings SET packets = MAX(packets, ?), lost_packets = MAX(lost_packets, ?) WHERE id = ?`)
          .bind(packets, lostPackets, id)
          .run();
      },
    },

    async stop(providerId, id, endedAt) {
      const r = await byId(id);
      if (!r || r.recording.providerId !== providerId) return null;
      if (r.recording.status !== "recording") return r;
      await touch(id, `UPDATE recordings SET status = 'stopped', ended_at = ?, updated_at = ? WHERE status = 'recording' AND id = ?`, endedAt, endedAt);
      return byId(id);
    },

    async startAttempt(id, attempt, now) {
      await touch(id, `UPDATE recordings SET attempts = MAX(attempts, ?), updated_at = ? WHERE id = ?`, attempt, now);
    },

    async listAssignments(recordingId) {
      const { results } = await db
        .prepare(`SELECT * FROM recording_segment_assignments WHERE recording_id = ? ORDER BY idx ASC`)
        .bind(recordingId)
        .all<Row>();
      return results.map(toAssignment);
    },

    async saveAssignments(rows) {
      const stmts = rows.map((a) =>
        db
          .prepare(
            `INSERT INTO recording_segment_assignments (recording_id, idx, provider_id, status, event_id, appointment_id,
               candidate_event_ids, candidate_appointment_ids, observed_from, observed_to, partitioned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (recording_id, idx) DO UPDATE SET status = excluded.status, event_id = excluded.event_id,
               appointment_id = excluded.appointment_id, candidate_event_ids = excluded.candidate_event_ids,
               candidate_appointment_ids = excluded.candidate_appointment_ids, observed_from = excluded.observed_from,
               observed_to = excluded.observed_to, partitioned_at = excluded.partitioned_at
             WHERE recording_segment_assignments.method <> 'provider_confirmed_content'`,
          )
          .bind(
            a.recordingId, a.index, a.providerId, a.status, a.eventId, a.appointmentId,
            a.candidateEventIds.length ? JSON.stringify(a.candidateEventIds) : null,
            a.candidateAppointmentIds.length ? JSON.stringify(a.candidateAppointmentIds) : null,
            a.observedFrom, a.observedTo, a.partitionedAt,
          ),
      );
      for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
    },

    async listHandoffs(recordingId) {
      const { results } = await db.prepare(`SELECT * FROM recording_sessions WHERE recording_id = ?`).bind(recordingId).all<Row>();
      return results.map((r) => ({
        recordingId: String(r.recording_id),
        eventId: String(r.event_id),
        providerId: String(r.provider_id),
        appointmentId: String(r.appointment_id),
        clientRef: String(r.client_ref),
        sessionId: String(r.session_id),
        segmentCount: Number(r.segment_count),
        handedOffAt: String(r.handed_off_at),
      }));
    },

    async saveHandoff(h) {
      await db
        .prepare(
          `INSERT INTO recording_sessions (recording_id, event_id, provider_id, appointment_id, client_ref, session_id, segment_count, handed_off_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (recording_id, event_id) DO UPDATE SET appointment_id = excluded.appointment_id, client_ref = excluded.client_ref,
             session_id = excluded.session_id, segment_count = excluded.segment_count, handed_off_at = excluded.handed_off_at`,
        )
        .bind(h.recordingId, h.eventId, h.providerId, h.appointmentId, h.clientRef, h.sessionId, h.segmentCount, h.handedOffAt)
        .run();
    },

    async markPartitioned(id, partition, now) {
      await touch(
        id,
        `UPDATE recordings SET status = 'partitioned', partition_json = ?, partitioned_at = ?, error_code = NULL, updated_at = ? WHERE id = ?`,
        JSON.stringify(partition), partition.partitionedAt, now,
      );
    },

    async markFailed(id, code, now) {
      await touch(id, `UPDATE recordings SET status = 'failed', error_code = ?, updated_at = ? WHERE status <> 'partitioned' AND id = ?`, code, now);
    },

    async offlineState(id) {
      const r = await db.prepare(`SELECT status FROM offline_visits WHERE visit_id = ? AND target = 'recording'`).bind(id).first<Row>();
      return r ? String(r.status) : null;
    },

    async listAssignedSegments(providerId, appointmentId) {
      const { results } = await db
        .prepare(
          `SELECT s.*, a.recording_id AS rec_id FROM recording_segment_assignments a
           JOIN band_segments s ON s.visit_id = a.recording_id AND s.idx = a.idx AND s.provider_id = a.provider_id
           JOIN recordings r ON r.id = a.recording_id AND r.provider_id = a.provider_id
           WHERE a.provider_id = ? AND a.appointment_id = ? AND a.status = 'assigned'
           ORDER BY s.observed_from ASC, r.started_at ASC, a.recording_id ASC, s.idx ASC
           LIMIT 500`,
        )
        .bind(providerId, appointmentId)
        .all<Row>();
      return results.map((r) => ({
        recordingId: String(r.rec_id),
        segment: BandSegment.parse({
          id: `${String(r.visit_id)}:${Number(r.idx)}`,
          visitId: r.visit_id,
          index: Number(r.idx),
          observedFrom: r.observed_from,
          observedTo: r.observed_to,
          speaker: r.speaker ?? null,
          text: r.text,
          sourceMode: r.source_mode,
        }),
      }));
    },

    async countAmbiguous(providerId, appointmentId) {
      const r = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM recording_segment_assignments a
           WHERE a.provider_id = ? AND a.status = 'ambiguous'
             AND EXISTS (SELECT 1 FROM json_each(a.candidate_appointment_ids) j WHERE j.value = ?)`,
        )
        .bind(providerId, appointmentId)
        .first<Row>();
      return Number(r?.n ?? 0);
    },

    async listOverlapping(providerId, from, to) {
      const { results } = await db
        .prepare(
          `${SELECT} WHERE r.provider_id = ? AND COALESCE(r.audio_started_at, r.started_at) <= ?
             AND (r.ended_at IS NULL OR r.ended_at >= ?) ORDER BY r.started_at ASC LIMIT 50`,
        )
        .bind(providerId, to, from)
        .all<Row>();
      return results.map(toRow);
    },

    async listByIds(providerId, ids) {
      if (ids.length === 0) return [];
      const uniq = [...new Set(ids)].slice(0, 50);
      const { results } = await db
        .prepare(`${SELECT} WHERE r.provider_id = ? AND r.id IN (${uniq.map(() => "?").join(", ")})`)
        .bind(providerId, ...uniq)
        .all<Row>();
      return results.map(toRow);
    },

    async sessionIdsByEvent(recordingId) {
      const out = new Map<string, { sessionId: string; clientRef: string }>();
      const { results } = await db.prepare(`SELECT event_id, session_id, client_ref FROM recording_sessions WHERE recording_id = ?`).bind(recordingId).all<Row>();
      for (const h of results.map((r) => ({ eventId: String(r.event_id), sessionId: String(r.session_id), clientRef: String(r.client_ref) }))) out.set(h.eventId, { sessionId: h.sessionId, clientRef: h.clientRef });
      return out;
    },

    async listUnassignedTextDue(partitionedBefore, limit) {
      // A pending content suggestion WITH a client holds the text up to 7 days; "none",
      // rejected and accepted suggestions do not (normal 24 h).
      const heldBefore = new Date(Date.parse(partitionedBefore) - (SUGGESTION_TEXT_RETENTION_MS - BASE_TEXT_RETENTION_MS)).toISOString();
      const { results } = await db
        .prepare(
          `SELECT a.* FROM recording_segment_assignments a
           WHERE a.status = 'unassigned' AND a.text_deleted_at IS NULL AND a.partitioned_at <= ?
             AND (a.partitioned_at <= ? OR NOT EXISTS (
               SELECT 1 FROM recording_assignment_suggestions s, json_each(s.segment_indexes) j
               WHERE s.recording_id = a.recording_id AND s.provider_id = a.provider_id AND s.status = 'pending'
                 AND s.suggested_client_ref IS NOT NULL AND j.value = a.idx))
           LIMIT ?`,
        )
        .bind(partitionedBefore, heldBefore, limit)
        .all<Row>();
      return results.map(toAssignment);
    },

    async deleteSegmentText(recordingId, index, now) {
      await db.batch([
        db
          .prepare(
            `DELETE FROM band_segments WHERE visit_id = ? AND idx = ? AND EXISTS (SELECT 1 FROM recording_segment_assignments a
               WHERE a.recording_id = ? AND a.idx = ? AND a.status = 'unassigned')`,
          )
          .bind(recordingId, index, recordingId, index),
        db
          .prepare(`UPDATE recording_segment_assignments SET text_deleted_at = ? WHERE recording_id = ? AND idx = ? AND status = 'unassigned'`)
          .bind(now, recordingId, index),
      ]);
    },

    async listByStatus(status, updatedBefore, limit) {
      const { results } = await db
        .prepare(`${SELECT} WHERE r.status = ? AND r.updated_at < ? ORDER BY r.updated_at ASC LIMIT ?`)
        .bind(status, updatedBefore, limit)
        .all<Row>();
      return results.map(toRow);
    },

    async listSuggestions(recordingId) {
      const { results } = await db
        .prepare(`SELECT * FROM recording_assignment_suggestions WHERE recording_id = ? ORDER BY observed_from ASC, id ASC LIMIT 200`)
        .bind(recordingId)
        .all<Row>();
      return results.map(toSuggestion);
    },

    async getSuggestion(providerId, recordingId, id) {
      const r = await db
        .prepare(`SELECT * FROM recording_assignment_suggestions WHERE id = ? AND recording_id = ? AND provider_id = ?`)
        .bind(id, recordingId, providerId)
        .first<Row>();
      return r ? toSuggestion(r) : null;
    },

    async insertSuggestions(rows) {
      const stmts = rows.map((s) =>
        db
          .prepare(
            `INSERT INTO recording_assignment_suggestions (id, recording_id, provider_id, segment_indexes, observed_from, observed_to,
               suggested_client_ref, event_id, kind, confidence, method, rationale, candidate_client_refs, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
             ON CONFLICT (id) DO NOTHING`,
          )
          .bind(
            s.id, s.recordingId, s.providerId, JSON.stringify(s.segmentIndexes), s.from, s.to,
            s.suggestedClientRef, s.eventId, s.kind, s.confidence, s.method, s.rationale.slice(0, 200),
            JSON.stringify(s.candidateClientRefs), s.createdAt,
          ),
      );
      for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
    },

    async decideSuggestion(id, status, now, acceptedClientRef) {
      const r = await db
        .prepare(
          `UPDATE recording_assignment_suggestions SET status = ?, decided_at = ?, accepted_client_ref = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(status, now, acceptedClientRef, id)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async reopenSuggestion(id) {
      await db
        .prepare(
          `UPDATE recording_assignment_suggestions SET status = 'pending', decided_at = NULL, accepted_client_ref = NULL
           WHERE id = ? AND status = 'accepted' AND session_id IS NULL`,
        )
        .bind(id)
        .run();
    },

    async setSuggestionTarget(id, appointmentId, sessionId) {
      await db.prepare(`UPDATE recording_assignment_suggestions SET appointment_id = ?, session_id = ? WHERE id = ?`).bind(appointmentId, sessionId, id).run();
    },

    async saveContentAssignments(rows) {
      const stmts = rows.map((a) =>
        db
          .prepare(
            `INSERT INTO recording_segment_assignments (recording_id, idx, provider_id, status, event_id, appointment_id,
               candidate_event_ids, candidate_appointment_ids, observed_from, observed_to, partitioned_at, method)
             VALUES (?, ?, ?, 'assigned', ?, ?, NULL, NULL, ?, ?, ?, 'provider_confirmed_content')
             ON CONFLICT (recording_id, idx) DO UPDATE SET status = 'assigned', event_id = excluded.event_id,
               appointment_id = excluded.appointment_id, candidate_event_ids = NULL, candidate_appointment_ids = NULL,
               method = 'provider_confirmed_content'`,
          )
          .bind(a.recordingId, a.index, a.providerId, a.eventId, a.appointmentId, a.observedFrom, a.observedTo, a.partitionedAt),
      );
      for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
    },

    async countContentAssigned(providerId, appointmentId) {
      const r = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM recording_segment_assignments
           WHERE provider_id = ? AND appointment_id = ? AND status = 'assigned' AND method = 'provider_confirmed_content'`,
        )
        .bind(providerId, appointmentId)
        .first<Row>();
      return Number(r?.n ?? 0);
    },

    async saveConversation(c) {
      await db
        .prepare(
          `INSERT INTO recording_conversations (recording_id, scope_key, provider_id, appointment_id, segment_count, conversation_type,
             confidence, method, signals_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (recording_id, scope_key) DO UPDATE SET appointment_id = excluded.appointment_id, segment_count = excluded.segment_count,
             conversation_type = excluded.conversation_type, confidence = excluded.confidence, method = excluded.method,
             signals_json = excluded.signals_json, updated_at = excluded.updated_at`,
        )
        .bind(c.recordingId, c.scopeKey, c.providerId, c.appointmentId, c.segmentCount, c.conversationType, c.confidence, c.method, JSON.stringify(c.signals), c.updatedAt)
        .run();
    },

    async listConversations(recordingId) {
      const { results } = await db.prepare(`SELECT * FROM recording_conversations WHERE recording_id = ? ORDER BY scope_key`).bind(recordingId).all<Row>();
      return results.map(toConversation);
    },

    async listConversationsForAppointment(providerId, appointmentId) {
      const { results } = await db
        .prepare(`SELECT * FROM recording_conversations WHERE provider_id = ? AND appointment_id = ? ORDER BY segment_count DESC, recording_id ASC LIMIT 50`)
        .bind(providerId, appointmentId)
        .all<Row>();
      return results.map(toConversation);
    },

    async decideConversation(providerId, appointmentId, decision, now) {
      const r = await db
        .prepare(`UPDATE recording_conversations SET provider_decision = ?, decided_at = ? WHERE provider_id = ? AND appointment_id = ?`)
        .bind(decision, now, providerId, appointmentId)
        .run();
      return r.meta?.changes ?? 0;
    },
  };
}
