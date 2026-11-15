/**
 * Archive (reversible) and delete (permanent) for sessions, recordings and runs
 * (migrations/0013_archive.sql, routes in src/api/archive.ts).
 *
 * - Archive hides an item from its list (sessions, recordings, runs) and changes nothing else.
 * - Delete rules:
 *   session   only when it was never approved (status not APPROVED / COMPLETED, no approval or
 *             final on record) and not mid-processing. Removes bundles, evidence, run events,
 *             review links, notifications and pending deliveries; unlinks band visits and
 *             recordings (their segments for this appointment become unassigned) and dismisses
 *             the event, so discovery / the partitioner do not recreate it from the recordings
 *             that already exist.
 *   recording its segments (text) and assignments, hand-offs, pending suggestions and conversation
 *             rows, the row.
 *             Sessions built from it keep their frozen evidence (bundles snapshot it).
 *   run       only a delivery run, or a run whose session no longer exists.
 * - Every action writes an audit_log row: who, when, action, kind, id, counts. Never content.
 * All reads and writes are scoped to the provider; another provider's item is "not found".
 */
import type { Clock, Recording } from "../contracts";
import type { CalendarSync } from "../recordings/contract";

export const ARCHIVE_KINDS = ["session", "recording", "run"] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];
export type AuditAction = "archive" | "unarchive" | "delete";

export interface ArchivedItem {
  kind: ArchiveKind;
  id: string;
  archivedAt: string;
  archivedBy: string;
  reason: string | null;
}

export interface AuditRow {
  id: string;
  providerId: string;
  actor: string;
  action: AuditAction;
  itemKind: ArchiveKind;
  itemId: string;
  detail: Record<string, number | string | boolean | null>;
  at: string;
}

/** Session states that can never be deleted (archive only). */
export const LOCKED_STATUSES = new Set(["APPROVED", "COMPLETED"]);
/** Session states with a live workflow / queue message: wait, then delete. */
export const BUSY_STATUSES = new Set(["QUEUED", "PROCESSING"]);
/** Partition window buffer (src/contracts PARTITION_BUFFER_MINUTES), used to lift a dismissal. */
const EVENT_BUFFER_MS = 10 * 60_000;

export type DeleteOutcome =
  | { ok: true; detail: AuditRow["detail"] }
  | { ok: false; status: 404 | 409; code: string; message: string };

type Row = Record<string, unknown>;

/** SQL fragment: `alias.col` is not archived as `kind` for the provider in `alias.provider_id`. */
export function notArchivedSql(kind: ArchiveKind, idExpr: string, providerExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM archived_items ai_${kind} WHERE ai_${kind}.provider_id = ${providerExpr} AND ai_${kind}.kind = '${kind}' AND ai_${kind}.item_id = ${idExpr})`;
}

function partitionOf(raw: unknown): Recording["partition"] {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as Recording["partition"];
  } catch {
    return null;
  }
}

function ms(from: unknown, to: unknown): number {
  const a = Date.parse(String(from));
  const b = Date.parse(String(to));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
}

export interface ArchiveService {
  isArchived(providerId: string, kind: ArchiveKind, id: string): Promise<boolean>;
  listArchived(providerId: string, kind: ArchiveKind | null, limit?: number): Promise<ArchivedItem[]>;
  /** null when the item does not exist for this provider. */
  archive(providerId: string, actor: string, kind: ArchiveKind, id: string, reason: string | null): Promise<ArchivedItem | null>;
  /** false when the item was not archived. */
  unarchive(providerId: string, actor: string, kind: ArchiveKind, id: string): Promise<boolean>;
  deleteSession(providerId: string, actor: string, sessionId: string): Promise<DeleteOutcome>;
  deleteRecording(providerId: string, actor: string, recordingId: string): Promise<DeleteOutcome>;
  deleteRun(providerId: string, actor: string, runId: string): Promise<DeleteOutcome>;
  listAudit(providerId: string, limit?: number): Promise<AuditRow[]>;
}

export function createArchiveService(db: D1Database, clock: Clock): ArchiveService {
  const now = () => clock.now().toISOString();

  function auditStmt(a: Omit<AuditRow, "id" | "at">, at: string): D1PreparedStatement {
    return db
      .prepare(`INSERT INTO audit_log (id, provider_id, actor, action, item_kind, item_id, detail_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`aud_${crypto.randomUUID().replace(/-/g, "")}`, a.providerId, a.actor, a.action, a.itemKind, a.itemId, JSON.stringify(a.detail), at);
  }

  async function exists(providerId: string, kind: ArchiveKind, id: string): Promise<boolean> {
    const sql =
      kind === "session"
        ? `SELECT 1 AS x FROM sessions WHERE id = ? AND provider_id = ?`
        : kind === "recording"
          ? `SELECT 1 AS x FROM recordings WHERE id = ? AND provider_id = ?`
          : `SELECT 1 AS x FROM run_events WHERE run_id = ? AND provider_id = ? LIMIT 1`;
    return !!(await db.prepare(sql).bind(id, providerId).first<Row>());
  }

  /**
   * Pending content suggestions and the per-block conversation rows of a recording. Those tables
   * come from a later migration (0014), so they are looked up rather than assumed.
   */
  async function suggestionDeletes(recordingId: string): Promise<D1PreparedStatement[]> {
    const { results } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%suggestion%' OR name = 'recording_conversations')`)
      .all<Row>();
    const out: D1PreparedStatement[] = [];
    for (const t of results) {
      const name = String(t.name);
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
      const { results: cols } = await db.prepare(`PRAGMA table_info(${name})`).all<Row>();
      const names = new Set(cols.map((c) => String(c.name)));
      if (!names.has("recording_id")) continue;
      out.push(
        names.has("status") && name !== "recording_conversations"
          ? db.prepare(`DELETE FROM ${name} WHERE recording_id = ? AND status = 'pending'`).bind(recordingId)
          : db.prepare(`DELETE FROM ${name} WHERE recording_id = ?`).bind(recordingId),
      );
    }
    return out;
  }

  return {
    async isArchived(providerId, kind, id) {
      const r = await db
        .prepare(`SELECT 1 AS x FROM archived_items WHERE provider_id = ? AND kind = ? AND item_id = ?`)
        .bind(providerId, kind, id)
        .first<Row>();
      return !!r;
    },

    async listArchived(providerId, kind, limit = 200) {
      const { results } = await db
        .prepare(
          `SELECT * FROM archived_items WHERE provider_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY archived_at DESC LIMIT ?`,
        )
        .bind(...(kind ? [providerId, kind] : [providerId]), Math.max(1, Math.min(500, limit)))
        .all<Row>();
      return results.map((r) => ({
        kind: String(r.kind) as ArchiveKind,
        id: String(r.item_id),
        archivedAt: String(r.archived_at),
        archivedBy: String(r.archived_by),
        reason: (r.reason as string | null) ?? null,
      }));
    },

    async archive(providerId, actor, kind, id, reason) {
      if (!(await exists(providerId, kind, id))) return null;
      const at = now();
      const [ins] = await db.batch([
        db
          .prepare(
            `INSERT INTO archived_items (provider_id, kind, item_id, archived_at, archived_by, reason) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (provider_id, kind, item_id) DO NOTHING`,
          )
          .bind(providerId, kind, id, at, actor, reason),
      ]);
      if ((ins?.meta?.changes ?? 0) > 0) {
        await auditStmt({ providerId, actor, action: "archive", itemKind: kind, itemId: id, detail: {} }, at).run();
      }
      const r = await db
        .prepare(`SELECT * FROM archived_items WHERE provider_id = ? AND kind = ? AND item_id = ?`)
        .bind(providerId, kind, id)
        .first<Row>();
      return r
        ? { kind, id, archivedAt: String(r.archived_at), archivedBy: String(r.archived_by), reason: (r.reason as string | null) ?? null }
        : null;
    },

    async unarchive(providerId, actor, kind, id) {
      const at = now();
      const res = await db
        .prepare(`DELETE FROM archived_items WHERE provider_id = ? AND kind = ? AND item_id = ?`)
        .bind(providerId, kind, id)
        .run();
      if ((res.meta?.changes ?? 0) === 0) return false;
      await auditStmt({ providerId, actor, action: "unarchive", itemKind: kind, itemId: id, detail: {} }, at).run();
      return true;
    },

    // ------------------------------------------------------------ delete: session
    async deleteSession(providerId, actor, sessionId) {
      const s = await db
        .prepare(`SELECT id, appointment_id, occurrence_id, status, processing_revision FROM sessions WHERE id = ? AND provider_id = ?`)
        .bind(sessionId, providerId)
        .first<Row>();
      if (!s) return { ok: false, status: 404, code: "NOT_FOUND", message: "Session not found" };
      const status = String(s.status);
      const approvedEver = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM approvals WHERE session_id = ?1) + (SELECT COUNT(*) FROM final_bundles WHERE session_id = ?1)
                + (SELECT COUNT(*) FROM superseded_finals WHERE session_id = ?1) AS n`,
        )
        .bind(sessionId)
        .first<Row>();
      if (LOCKED_STATUSES.has(status) || Number(approvedEver?.n ?? 0) > 0) {
        return {
          ok: false,
          status: 409,
          code: "ARCHIVE_ONLY",
          message: "Approved sessions are kept for the audit trail. Archive it to hide it instead.",
        };
      }
      if (BUSY_STATUSES.has(status)) {
        return { ok: false, status: 409, code: "SESSION_BUSY", message: "This session is being processed. Try again when it finishes." };
      }
      const at = now();
      const appointmentId = String(s.appointment_id);
      const eventId = String(s.occurrence_id);

      // Recording segments assigned to this appointment become unassigned (24 h text sweep starts now).
      const { results: assigned } = await db
        .prepare(
          `SELECT recording_id, idx, observed_from, observed_to FROM recording_segment_assignments
           WHERE provider_id = ? AND appointment_id = ? AND status = 'assigned'`,
        )
        .bind(providerId, appointmentId)
        .all<Row>();
      const moved = new Map<string, { n: number; ms: number }>();
      for (const a of assigned) {
        const m = moved.get(String(a.recording_id)) ?? { n: 0, ms: 0 };
        m.n += 1;
        m.ms += ms(a.observed_from, a.observed_to);
        moved.set(String(a.recording_id), m);
      }
      const { results: handoffs } = await db
        .prepare(`SELECT DISTINCT recording_id FROM recording_sessions WHERE session_id = ? AND provider_id = ?`)
        .bind(sessionId, providerId)
        .all<Row>();
      const recIds = [...new Set([...moved.keys(), ...handoffs.map((h) => String(h.recording_id))])];
      const partitionUpdates: D1PreparedStatement[] = [];
      for (const rid of recIds) {
        const r = await db.prepare(`SELECT partition_json FROM recordings WHERE id = ? AND provider_id = ?`).bind(rid, providerId).first<Row>();
        const p = partitionOf(r?.partition_json);
        if (!p) continue;
        const m = moved.get(rid) ?? { n: 0, ms: 0 };
        const next = {
          ...p,
          sessions: p.sessions.filter((x) => x.sessionId !== sessionId),
          unassignedSegments: p.unassignedSegments + m.n,
          unassignedMs: (p.unassignedMs ?? 0) + m.ms,
        };
        partitionUpdates.push(
          db.prepare(`UPDATE recordings SET partition_json = ?, updated_at = ? WHERE id = ? AND provider_id = ?`).bind(JSON.stringify(next), at, rid, providerId),
        );
      }
      const count = async (sql: string) => Number((await db.prepare(sql).bind(sessionId, providerId).first<Row>())?.n ?? 0);
      const detail = {
        status,
        bundles: Number((await db.prepare(`SELECT COUNT(*) AS n FROM bundles WHERE session_id = ?`).bind(sessionId).first<Row>())?.n ?? 0),
        runEvents: await count(`SELECT COUNT(*) AS n FROM run_events WHERE session_id = ? AND provider_id = ?`),
        reviewLinks: await count(`SELECT COUNT(*) AS n FROM review_links WHERE session_id = ? AND provider_id = ?`),
        notifications: await count(`SELECT COUNT(*) AS n FROM notifications WHERE session_id = ? AND provider_id = ?`),
        segmentsUnassigned: assigned.length,
        recordings: recIds.length,
      };

      const p = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds);
      await db.batch([
        p(`DELETE FROM evidence WHERE session_id = ?`, sessionId),
        p(`DELETE FROM bundles WHERE session_id = ?`, sessionId),
        p(`DELETE FROM pending_deliveries WHERE session_id = ?`, sessionId),
        p(`DELETE FROM file_deliveries WHERE session_id = ?`, sessionId),
        p(`DELETE FROM client_snapshots WHERE session_id = ?`, sessionId),
        p(`DELETE FROM run_events WHERE session_id = ? AND provider_id = ?`, sessionId, providerId),
        p(`DELETE FROM review_links WHERE session_id = ? AND provider_id = ?`, sessionId, providerId),
        p(
          `DELETE FROM notification_log WHERE provider_id = ? AND notification_id IN (SELECT id FROM notifications WHERE session_id = ? AND provider_id = ?)`,
          providerId, sessionId, providerId,
        ),
        p(`DELETE FROM notifications WHERE session_id = ? AND provider_id = ?`, sessionId, providerId),
        p(`UPDATE band_visits SET session_id = NULL WHERE session_id = ? AND provider_id = ?`, sessionId, providerId),
        p(
          `UPDATE recording_segment_assignments SET status = 'unassigned', event_id = NULL, appointment_id = NULL, partitioned_at = ?
           WHERE provider_id = ? AND appointment_id = ? AND status = 'assigned'`,
          at, providerId, appointmentId,
        ),
        p(`DELETE FROM recording_sessions WHERE session_id = ? AND provider_id = ?`, sessionId, providerId),
        ...partitionUpdates,
        p(
          `INSERT INTO dismissed_events (provider_id, event_id, appointment_id, session_id, last_processing_revision, dismissed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider_id, event_id) DO UPDATE SET appointment_id = excluded.appointment_id, session_id = excluded.session_id,
             last_processing_revision = MAX(dismissed_events.last_processing_revision, excluded.last_processing_revision),
             dismissed_at = excluded.dismissed_at`,
          providerId, eventId, appointmentId, sessionId, Number(s.processing_revision ?? 0), at,
        ),
        p(`DELETE FROM archived_items WHERE provider_id = ? AND kind = 'session' AND item_id = ?`, providerId, sessionId),
        p(`DELETE FROM sessions WHERE id = ? AND provider_id = ?`, sessionId, providerId),
        auditStmt({ providerId, actor, action: "delete", itemKind: "session", itemId: sessionId, detail }, at),
      ]);
      return { ok: true, detail };
    },

    // ------------------------------------------------------------ delete: recording
    async deleteRecording(providerId, actor, recordingId) {
      const r = await db.prepare(`SELECT id, status FROM recordings WHERE id = ? AND provider_id = ?`).bind(recordingId, providerId).first<Row>();
      if (!r) return { ok: false, status: 404, code: "NOT_FOUND", message: "Recording not found" };
      if (String(r.status) === "recording") {
        return { ok: false, status: 409, code: "RECORDING_ACTIVE", message: "This recording is still running. Stop it on the phone first." };
      }
      const off = await db
        .prepare(`SELECT status FROM offline_visits WHERE visit_id = ? AND provider_id = ? AND target = 'recording'`)
        .bind(recordingId, providerId)
        .first<Row>();
      if (off && String(off.status) === "transcribing") {
        return { ok: false, status: 409, code: "RECORDING_BUSY", message: "This recording is being transcribed. Try again in a minute." };
      }
      const at = now();
      const n = async (sql: string) => Number((await db.prepare(sql).bind(recordingId).first<Row>())?.n ?? 0);
      const suggestions = await suggestionDeletes(recordingId);
      const detail = {
        segments: await n(`SELECT COUNT(*) AS n FROM band_segments WHERE visit_id = ?`),
        assignments: await n(`SELECT COUNT(*) AS n FROM recording_segment_assignments WHERE recording_id = ?`),
        sessionsKept: await n(`SELECT COUNT(DISTINCT session_id) AS n FROM recording_sessions WHERE recording_id = ?`),
      };
      const p = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds);
      await db.batch([
        p(`DELETE FROM band_segments WHERE visit_id = ? AND provider_id = ?`, recordingId, providerId),
        p(`DELETE FROM recording_segment_assignments WHERE recording_id = ? AND provider_id = ?`, recordingId, providerId),
        p(`DELETE FROM recording_sessions WHERE recording_id = ? AND provider_id = ?`, recordingId, providerId),
        ...suggestions,
        p(`DELETE FROM archived_items WHERE provider_id = ? AND kind = 'recording' AND item_id = ?`, providerId, recordingId),
        p(`DELETE FROM recordings WHERE id = ? AND provider_id = ?`, recordingId, providerId),
        auditStmt({ providerId, actor, action: "delete", itemKind: "recording", itemId: recordingId, detail }, at),
      ]);
      return { ok: true, detail };
    },

    // ------------------------------------------------------------ delete: run
    async deleteRun(providerId, actor, runId) {
      const { results } = await db
        .prepare(`SELECT run_kind, session_id FROM run_events WHERE run_id = ? AND provider_id = ?`)
        .bind(runId, providerId)
        .all<Row>();
      if (results.length === 0) return { ok: false, status: 404, code: "NOT_FOUND", message: "Run not found" };
      const delivery = results.some((e) => e.run_kind === "delivery");
      const sessionIds = [...new Set(results.map((e) => String(e.session_id)))];
      let sessionGone = true;
      for (const sid of sessionIds) {
        if (await db.prepare(`SELECT 1 AS x FROM sessions WHERE id = ? AND provider_id = ?`).bind(sid, providerId).first<Row>()) sessionGone = false;
      }
      if (!delivery && !sessionGone) {
        return {
          ok: false,
          status: 409,
          code: "ARCHIVE_ONLY",
          message: "A processing run is kept with its session. Archive it to hide it, or delete the draft session.",
        };
      }
      const at = now();
      const detail = { runEvents: results.length, runKind: delivery ? "delivery" : "processing", sessionDeleted: sessionGone };
      await db.batch([
        db.prepare(`DELETE FROM run_events WHERE run_id = ? AND provider_id = ?`).bind(runId, providerId),
        db.prepare(`DELETE FROM archived_items WHERE provider_id = ? AND kind = 'run' AND item_id = ?`).bind(providerId, runId),
        auditStmt({ providerId, actor, action: "delete", itemKind: "run", itemId: runId, detail }, at),
      ]);
      return { ok: true, detail };
    },

    async listAudit(providerId, limit = 100) {
      const { results } = await db
        .prepare(`SELECT * FROM audit_log WHERE provider_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
        .bind(providerId, Math.max(1, Math.min(500, limit)))
        .all<Row>();
      return results.map((r) => ({
        id: String(r.id),
        providerId: String(r.provider_id),
        actor: String(r.actor),
        action: String(r.action) as AuditAction,
        itemKind: String(r.item_kind) as ArchiveKind,
        itemId: String(r.item_id),
        detail: (() => {
          try {
            return JSON.parse(String(r.detail_json)) as AuditRow["detail"];
          } catch {
            return {};
          }
        })(),
        at: String(r.at),
      }));
    },
  };
}

// ------------------------------------------------------------------ dismissed events
/**
 * Wraps the partitioner's calendar pass: an event dismissed by a session delete is left out,
 * unless a recording created after the dismissal overlaps the event window (new evidence).
 */
export function withDismissedEvents(db: D1Database, sync: CalendarSync): CalendarSync {
  return async (providerId, from, to) => {
    const synced = await sync(providerId, from, to);
    if (synced.length === 0) return synced;
    const ids = [...new Set(synced.map((s) => s.event.eventId))].slice(0, 90);
    const { results } = await db
      .prepare(`SELECT event_id, dismissed_at FROM dismissed_events WHERE provider_id = ? AND event_id IN (${ids.map(() => "?").join(", ")})`)
      .bind(providerId, ...ids)
      .all<Row>();
    if (results.length === 0) return synced;
    const dismissed = new Map(results.map((r) => [String(r.event_id), String(r.dismissed_at)]));
    const out: typeof synced = [];
    for (const s of synced) {
      const at = dismissed.get(s.event.eventId);
      if (!at) {
        out.push(s);
        continue;
      }
      const winFrom = new Date(Date.parse(s.appointment.startAt) - EVENT_BUFFER_MS).toISOString();
      const winTo = new Date(Date.parse(s.appointment.endAt) + EVENT_BUFFER_MS).toISOString();
      const newer = await db
        .prepare(
          `SELECT 1 AS x FROM recordings WHERE provider_id = ? AND created_at > ?
             AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1`,
        )
        .bind(providerId, at, winTo, winFrom)
        .first<Row>();
      if (newer) out.push(s);
    }
    return out;
  };
}
