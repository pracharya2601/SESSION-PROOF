/**
 * D1 implementation of the frozen Repository interface (Agent 04).
 *
 * Rules:
 *  - Prepared statements with bound parameters only.
 *  - Multi-write operations use db.batch (one implicit transaction). Every
 *    dependent write in a batch carries the SAME precondition guard, so a
 *    failed precondition makes every statement a no-op (no partial state).
 *    Unique-constraint violations abort and roll back the whole batch; the
 *    caller then re-reads to classify (replay vs conflict).
 *  - JSON read back from the database is validated with zod.
 */
import { z } from "zod";
import {
  Appointment,
  ApprovalRecord,
  deliveryKey as makeDeliveryKey,
  FinalBundle,
  ServiceConfig,
  SessionBundle,
  SessionRecord,
  SessionStatus,
  SessionSummary,
  EvidenceItem,
} from "../contracts";
import type {
  ApprovalWrite,
  ConditionalResult,
  PendingDelivery,
  Repository,
} from "./repository";

export const MAX_PAGE_SIZE = 50;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Claimed deliveries are hidden for this long so concurrent dispatchers don't double-send. */
export const CLAIM_LEASE_MS = 60_000;
const MAX_ERROR_LEN = 500;

type Row = Record<string, unknown>;

const PendingDeliverySchema = z.object({
  deliveryKey: z.string(),
  operation: z.enum(["process_session", "approval_notification"]),
  sessionId: z.string(),
  revision: z.number().int(),
  payload: z.record(z.unknown()),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string(),
  status: z.enum(["pending", "done", "exhausted"]),
  lastError: z.string().nullable(),
});

// ------------------------------------------------------------------ helpers

function iso(d: Date): string {
  return d.toISOString();
}

function toMs(instant: string): number {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid instant: ${instant}`);
  return ms;
}

function fail<T>(reason: "not_found" | "stale_revision" | "invalid_state" | "conflict", detail?: string): ConditionalResult<T> {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function changes(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function statusList(statuses: SessionStatus[]): SessionStatus[] {
  return [...new Set(statuses.map((s) => SessionStatus.parse(s)))];
}

function rowToAppointment(r: Row): Appointment {
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
    canceled: Number(r.canceled) === 1,
  });
}

function rowToSession(r: Row): SessionRecord {
  return SessionRecord.parse({
    id: r.id,
    providerId: r.provider_id,
    appointmentId: r.appointment_id,
    occurrenceId: r.occurrence_id,
    status: r.status,
    processingRevision: Number(r.processing_revision),
    currentBundleRevision: Number(r.current_bundle_revision),
    workflowId: r.workflow_id ?? null,
    statusReason: r.status_reason ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function rowToApproval(r: Row): ApprovalRecord {
  return ApprovalRecord.parse({
    id: r.id,
    sessionId: r.session_id,
    bundleRevision: Number(r.bundle_revision),
    approverProviderId: r.approver_provider_id,
    approvedAt: r.approved_at,
    idempotencyKey: r.idempotency_key,
    requestFingerprint: r.request_fingerprint,
    finalizationStatus: r.finalization_status,
  });
}

function parseBundleJson(json: unknown): SessionBundle {
  return SessionBundle.parse(JSON.parse(String(json)));
}

function rowToFinal(r: Row): FinalBundle {
  return FinalBundle.parse({
    sessionId: r.session_id,
    bundleRevision: Number(r.bundle_revision),
    approvalId: r.approval_id,
    finalizedAt: r.finalized_at,
    bundle: JSON.parse(String(r.bundle_json)),
  });
}

function rowToDelivery(r: Row): PendingDelivery {
  return PendingDeliverySchema.parse({
    deliveryKey: r.delivery_key,
    operation: r.operation,
    sessionId: r.session_id,
    revision: Number(r.revision),
    payload: JSON.parse(String(r.payload_json)),
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at,
    status: r.status,
    lastError: r.last_error ?? null,
  });
}

function encodeCursor(startMs: number, id: string): string {
  return btoa(JSON.stringify([startMs, id]));
}

function decodeCursor(cursor: string): { startMs: number; id: string } {
  try {
    const v: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && typeof v[1] === "string") {
      return { startMs: v[0] as number, id: v[1] };
    }
  } catch {
    // fall through
  }
  throw new RangeError("invalid cursor");
}

/** Backoff after a failed attempt: 30s · 2^attempts, capped at 1h. */
export function backoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 0), 30);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

// ------------------------------------------------------------------ factory

export function createRepository(db: D1Database): Repository {
  const SESSION_COLS =
    "id, provider_id, appointment_id, occurrence_id, status, processing_revision, current_bundle_revision, workflow_id, status_reason, created_at, updated_at";

  async function readSession(sessionId: string): Promise<SessionRecord | null> {
    const r = await db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).bind(sessionId).first<Row>();
    return r ? rowToSession(r) : null;
  }

  async function readBundle(sessionId: string, revision: number): Promise<SessionBundle | null> {
    const r = await db
      .prepare("SELECT bundle_json FROM bundles WHERE session_id = ? AND revision = ?")
      .bind(sessionId, revision)
      .first<Row>();
    return r ? parseBundleJson(r.bundle_json) : null;
  }

  async function readApprovalByKey(key: string): Promise<ApprovalRecord | null> {
    const r = await db.prepare("SELECT * FROM approvals WHERE idempotency_key = ?").bind(key).first<Row>();
    return r ? rowToApproval(r) : null;
  }

  async function readFinal(sessionId: string): Promise<FinalBundle | null> {
    const r = await db.prepare("SELECT * FROM final_bundles WHERE session_id = ?").bind(sessionId).first<Row>();
    return r ? rowToFinal(r) : null;
  }

  async function readDelivery(key: string): Promise<PendingDelivery | null> {
    const r = await db.prepare("SELECT * FROM pending_deliveries WHERE delivery_key = ?").bind(key).first<Row>();
    return r ? rowToDelivery(r) : null;
  }

  /** Bundle insert guarded by an arbitrary session precondition (shared with the companion UPDATE). */
  function insertBundleGuarded(bundle: SessionBundle, now: Date, guardSql: string, guardParams: unknown[]): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO bundles (session_id, revision, processing_revision, bundle_json, can_approve, amount_cents, evidence_mode, extraction_mode, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM sessions WHERE ${guardSql})`,
      )
      .bind(
        bundle.sessionId,
        bundle.bundleRevision,
        bundle.processingRevision,
        JSON.stringify(bundle),
        bundle.checks.canApprove ? 1 : 0,
        bundle.billing.amountCents,
        bundle.provenance.evidenceMode,
        bundle.provenance.extractionMode,
        iso(now),
        ...guardParams,
      );
  }

  const repo: Repository = {
    // ------------------------------------------------ providers & configuration
    async upsertProvider(providerId, identity) {
      const now = iso(new Date());
      await db
        .prepare(
          `INSERT INTO providers (id, identity, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET identity = excluded.identity, updated_at = excluded.updated_at`,
        )
        .bind(providerId, identity, now, now)
        .run();
    },

    async findProviderByIdentity(identity) {
      const r = await db.prepare("SELECT id FROM providers WHERE identity = ?").bind(identity).first<Row>();
      return r ? String(r.id) : null;
    },

    async upsertServiceConfig(serviceCode, config) {
      const c = ServiceConfig.parse(config);
      await db
        .prepare(
          `INSERT INTO service_configs (plan_version, rule_version, rate_version, service_code, config_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(plan_version, rule_version, rate_version)
           DO UPDATE SET service_code = excluded.service_code, config_json = excluded.config_json, updated_at = excluded.updated_at`,
        )
        .bind(c.plan.planVersion, c.rules.ruleVersion, c.rate.rateVersion, serviceCode, JSON.stringify(c), iso(new Date()))
        .run();
    },

    async getServiceConfig(planVersion, ruleVersion, rateVersion) {
      const r = await db
        .prepare("SELECT config_json FROM service_configs WHERE plan_version = ? AND rule_version = ? AND rate_version = ?")
        .bind(planVersion, ruleVersion, rateVersion)
        .first<Row>();
      return r ? ServiceConfig.parse(JSON.parse(String(r.config_json))) : null;
    },

    // ------------------------------------------------ appointments
    async upsertAppointment(appointment) {
      const a = Appointment.parse(appointment);
      await db
        .prepare(
          `INSERT INTO appointments (id, occurrence_id, provider_id, client_ref, start_at, end_at, start_ms, end_ms, timezone,
             service_code, plan_version, rule_version, rate_version, canceled, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             client_ref = excluded.client_ref, start_at = excluded.start_at, end_at = excluded.end_at,
             start_ms = excluded.start_ms, end_ms = excluded.end_ms, timezone = excluded.timezone,
             service_code = excluded.service_code, plan_version = excluded.plan_version,
             rule_version = excluded.rule_version, rate_version = excluded.rate_version,
             canceled = excluded.canceled, updated_at = excluded.updated_at`,
        )
        .bind(
          a.id,
          a.occurrenceId,
          a.providerId,
          a.clientRef,
          a.startAt,
          a.endAt,
          toMs(a.startAt),
          toMs(a.endAt),
          a.timezone,
          a.serviceCode,
          a.planVersion,
          a.ruleVersion,
          a.rateVersion,
          a.canceled ? 1 : 0,
          iso(new Date()),
        )
        .run();
    },

    async getAppointment(appointmentId) {
      const r = await db.prepare("SELECT * FROM appointments WHERE id = ?").bind(appointmentId).first<Row>();
      return r ? rowToAppointment(r) : null;
    },

    async listDiscoverableAppointments(now, lookbackMinutes, limit) {
      const nowMs = now.getTime();
      const { results } = await db
        .prepare(
          `SELECT * FROM appointments
           WHERE canceled = 0 AND end_ms <= ? AND end_ms >= ?
           ORDER BY end_ms ASC, id ASC LIMIT ?`,
        )
        .bind(nowMs, nowMs - Math.max(0, lookbackMinutes) * 60_000, Math.max(0, Math.floor(limit)))
        .all<Row>();
      return results.map(rowToAppointment);
    },

    async listProviderAppointmentsOverlapping(providerId, from, to) {
      const { results } = await db
        .prepare(
          `SELECT * FROM appointments
           WHERE provider_id = ? AND canceled = 0 AND start_ms < ? AND end_ms > ?
           ORDER BY start_ms ASC, id ASC`,
        )
        .bind(providerId, toMs(to), toMs(from))
        .all<Row>();
      return results.map(rowToAppointment);
    },

    // ------------------------------------------------ sessions
    async ensureSession(appointment, sessionId, now) {
      const a = Appointment.parse(appointment);
      const t = iso(now);
      // Appointment row must exist for list joins; never overwrite an existing one here.
      const [, ins] = await db.batch([
        db
          .prepare(
            `INSERT INTO appointments (id, occurrence_id, provider_id, client_ref, start_at, end_at, start_ms, end_ms, timezone,
               service_code, plan_version, rule_version, rate_version, canceled, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            a.id, a.occurrenceId, a.providerId, a.clientRef, a.startAt, a.endAt, toMs(a.startAt), toMs(a.endAt),
            a.timezone, a.serviceCode, a.planVersion, a.ruleVersion, a.rateVersion, a.canceled ? 1 : 0, t,
          ),
        db
          .prepare(
            `INSERT INTO sessions (id, provider_id, appointment_id, occurrence_id, status, processing_revision,
               current_bundle_revision, workflow_id, status_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'WAITING_FOR_EVIDENCE', 0, 0, NULL, NULL, ?, ?)
             ON CONFLICT(provider_id, occurrence_id) DO NOTHING`,
          )
          .bind(sessionId, a.providerId, a.id, a.occurrenceId, t, t),
      ]);
      const r = await db
        .prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE provider_id = ? AND occurrence_id = ?`)
        .bind(a.providerId, a.occurrenceId)
        .first<Row>();
      if (!r) throw new Error("ensureSession: session row missing after insert");
      return { session: rowToSession(r), created: changes(ins) === 1 };
    },

    getSession: readSession,

    async getSessionForProvider(providerId, sessionId) {
      const r = await db
        .prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ? AND provider_id = ?`)
        .bind(sessionId, providerId)
        .first<Row>();
      return r ? rowToSession(r) : null;
    },

    async listSessionsForProvider(providerId, limit, cursor) {
      const pageSize = Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_PAGE_SIZE);
      const c = cursor ? decodeCursor(cursor) : null;
      const sql = `
        SELECT s.id, s.status, s.current_bundle_revision, s.status_reason,
               a.client_ref, a.service_code, a.start_at, a.end_at, a.start_ms, a.timezone,
               b.evidence_mode, b.extraction_mode, b.can_approve, b.amount_cents, b.revision AS bundle_rev
        FROM sessions s
        JOIN appointments a ON a.id = s.appointment_id
        LEFT JOIN bundles b ON b.session_id = s.id AND b.revision = s.current_bundle_revision
        WHERE s.provider_id = ? ${c ? "AND (a.start_ms < ? OR (a.start_ms = ? AND s.id < ?))" : ""}
        ORDER BY a.start_ms DESC, s.id DESC
        LIMIT ?`;
      const params: unknown[] = c ? [providerId, c.startMs, c.startMs, c.id, pageSize + 1] : [providerId, pageSize + 1];
      const { results } = await db.prepare(sql).bind(...params).all<Row>();
      const page = results.slice(0, pageSize);
      const sessions = page.map((r) => {
        const hasBundle = r.bundle_rev !== null && r.bundle_rev !== undefined;
        return SessionSummary.parse({
          id: r.id,
          status: r.status,
          clientRef: r.client_ref,
          serviceCode: r.service_code,
          startAt: r.start_at,
          endAt: r.end_at,
          timezone: r.timezone,
          currentBundleRevision: Number(r.current_bundle_revision),
          statusReason: r.status_reason ?? null,
          evidenceMode: hasBundle ? r.evidence_mode : null,
          extractionMode: hasBundle ? r.extraction_mode : null,
          canApprove: hasBundle ? Number(r.can_approve) === 1 : null,
          amountCents: hasBundle && r.amount_cents !== null ? Number(r.amount_cents) : null,
        });
      });
      const last = page[page.length - 1];
      const nextCursor = results.length > pageSize && last ? encodeCursor(Number(last.start_ms), String(last.id)) : null;
      return { sessions, nextCursor };
    },

    async transitionSession(sessionId, from, to, reason, now) {
      const target = SessionStatus.parse(to);
      const allowed = statusList(from);
      if (allowed.length === 0) return fail("invalid_state", "empty from-set");
      const r = await db
        .prepare(
          `UPDATE sessions SET status = ?, status_reason = ?, updated_at = ?
           WHERE id = ? AND status IN (${placeholders(allowed.length)})
           RETURNING ${SESSION_COLS}`,
        )
        .bind(target, reason, iso(now), sessionId, ...allowed)
        .first<Row>();
      if (r) return { ok: true, value: rowToSession(r) };
      const current = await readSession(sessionId);
      if (!current) return fail("not_found");
      return fail("invalid_state", `status is ${current.status}`);
    },

    async enqueueProcessing(sessionId, allowedFrom, now) {
      const allowed = statusList(allowedFrom);
      if (allowed.length === 0) return fail("invalid_state", "empty from-set");
      const t = iso(now);
      const guard = `id = ? AND status IN (${placeholders(allowed.length)})`;
      try {
        // Both statements share the same guard, evaluated against the same
        // pre-batch state: either both apply or neither does.
        const [, upd] = await db.batch([
          db
            .prepare(
              `INSERT INTO pending_deliveries (delivery_key, operation, session_id, revision, payload_json, attempts,
                 next_attempt_at, status, last_error, created_at, updated_at)
               SELECT 'process_session:' || id || ':' || (processing_revision + 1), 'process_session', id,
                      processing_revision + 1,
                      json_object('schemaVersion', '1', 'sessionId', id, 'processingRevision', processing_revision + 1),
                      0, ?, 'pending', NULL, ?, ?
               FROM sessions WHERE ${guard}`,
            )
            .bind(t, t, t, sessionId, ...allowed),
          db
            .prepare(
              `UPDATE sessions SET processing_revision = processing_revision + 1, status = 'QUEUED',
                 status_reason = NULL, workflow_id = NULL, updated_at = ?
               WHERE ${guard}
               RETURNING processing_revision`,
            )
            .bind(t, sessionId, ...allowed),
        ]);
        const row = (upd?.results as Row[] | undefined)?.[0];
        if (changes(upd) === 1 && row) {
          const rev = Number(row.processing_revision);
          return { ok: true, value: { processingRevision: rev, deliveryKey: makeDeliveryKey("process_session", sessionId, rev) } };
        }
      } catch (err) {
        if (isUniqueViolation(err)) return fail("conflict", "delivery for next revision already exists");
        throw err;
      }
      const current = await readSession(sessionId);
      if (!current) return fail("not_found");
      return fail("invalid_state", `status is ${current.status}`);
    },

    async setWorkflowId(sessionId, processingRevision, workflowId) {
      await db
        .prepare("UPDATE sessions SET workflow_id = ?, updated_at = ? WHERE id = ? AND processing_revision = ?")
        .bind(workflowId, iso(new Date()), sessionId, processingRevision)
        .run();
    },

    // ------------------------------------------------ evidence
    async replaceEvidence(sessionId, processingRevision, items) {
      const parsed = items.map((i) => EvidenceItem.parse(i));
      const guard = "EXISTS (SELECT 1 FROM sessions WHERE id = ? AND processing_revision = ?)";
      const stmts: D1PreparedStatement[] = [
        db.prepare(`DELETE FROM evidence WHERE session_id = ? AND ${guard}`).bind(sessionId, sessionId, processingRevision),
      ];
      parsed.forEach((e, idx) => {
        stmts.push(
          db
            .prepare(
              `INSERT INTO evidence (session_id, id, processing_revision, ordinal, source_id, source_mode, observed_from,
                 observed_to, speaker, excerpt, retrieved_at, citation_url)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
            )
            .bind(
              sessionId, e.id, processingRevision, idx, e.sourceId, e.sourceMode, e.observedFrom, e.observedTo,
              e.speaker, e.excerpt, e.retrievedAt, e.citationUrl ?? null, sessionId, processingRevision,
            ),
        );
      });
      await db.batch(stmts);
    },

    // ------------------------------------------------ bundles
    async saveDraft(bundleIn, now) {
      const bundle = SessionBundle.parse(bundleIn);
      const existing = await readBundle(bundle.sessionId, bundle.bundleRevision);
      if (existing) {
        if (existing.processingRevision !== bundle.processingRevision) {
          return fail("conflict", "bundle revision exists for a different processing revision");
        }
        return { ok: true, value: existing };
      }
      const guardSql =
        "id = ? AND processing_revision = ? AND status = 'PROCESSING' AND current_bundle_revision < ?";
      const guardParams = [bundle.sessionId, bundle.processingRevision, bundle.bundleRevision];
      let applied = false;
      try {
        const [, upd] = await db.batch([
          insertBundleGuarded(bundle, now, guardSql, guardParams),
          db
            .prepare(
              `UPDATE sessions SET status = 'NEEDS_REVIEW', current_bundle_revision = ?, status_reason = NULL, updated_at = ?
               WHERE ${guardSql}`,
            )
            .bind(bundle.bundleRevision, iso(now), ...guardParams),
        ]);
        applied = changes(upd) === 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent identical draft write won the race: treat as replay.
        const raced = await readBundle(bundle.sessionId, bundle.bundleRevision);
        if (raced && raced.processingRevision === bundle.processingRevision) return { ok: true, value: raced };
        return fail("conflict", "bundle revision already exists");
      }
      if (applied) return { ok: true, value: bundle };
      const s = await readSession(bundle.sessionId);
      if (!s) return fail("not_found");
      if (s.processingRevision !== bundle.processingRevision) return fail("stale_revision", "processing revision changed");
      if (s.status !== "PROCESSING") return fail("invalid_state", `status is ${s.status}`);
      return fail("stale_revision", "bundle revision not newer than current");
    },

    getBundle: readBundle,

    async getCurrentBundle(sessionId) {
      const r = await db
        .prepare(
          `SELECT b.bundle_json FROM bundles b JOIN sessions s ON s.id = b.session_id AND b.revision = s.current_bundle_revision
           WHERE s.id = ?`,
        )
        .bind(sessionId)
        .first<Row>();
      return r ? parseBundleJson(r.bundle_json) : null;
    },

    async saveReviewRevision(sessionId, expectedRevision, bundleIn, now) {
      const bundle = SessionBundle.parse(bundleIn);
      if (bundle.sessionId !== sessionId) return fail("conflict", "bundle belongs to another session");
      if (bundle.bundleRevision !== expectedRevision + 1) {
        return fail("conflict", `bundle revision must be ${expectedRevision + 1}`);
      }
      const guardSql = "id = ? AND current_bundle_revision = ? AND status = 'NEEDS_REVIEW'";
      const guardParams = [sessionId, expectedRevision];
      let applied = false;
      try {
        const [, upd] = await db.batch([
          insertBundleGuarded(bundle, now, guardSql, guardParams),
          db
            .prepare(`UPDATE sessions SET current_bundle_revision = ?, updated_at = ? WHERE ${guardSql}`)
            .bind(bundle.bundleRevision, iso(now), ...guardParams),
        ]);
        applied = changes(upd) === 1;
      } catch (err) {
        if (isUniqueViolation(err)) return fail("stale_revision", "revision already exists");
        throw err;
      }
      if (applied) return { ok: true, value: bundle };
      const s = await readSession(sessionId);
      if (!s) return fail("not_found");
      if (s.currentBundleRevision !== expectedRevision) {
        return fail("stale_revision", `current revision is ${s.currentBundleRevision}`);
      }
      return fail("invalid_state", `status is ${s.status}`);
    },

    // ------------------------------------------------ approvals
    async persistApproval(write, now) {
      const approval = ApprovalRecord.parse(write.approval);
      const expected = write.expectedBundleRevision;
      if (approval.bundleRevision !== expected) return fail("conflict", "approval revision != expected revision");

      const classifyExisting = (existing: ApprovalRecord): ConditionalResult<{ approval: ApprovalRecord; replayed: boolean }> =>
        existing.requestFingerprint === approval.requestFingerprint &&
        existing.sessionId === approval.sessionId &&
        existing.bundleRevision === approval.bundleRevision
          ? { ok: true, value: { approval: existing, replayed: true } }
          : fail("conflict", "idempotency key reused with different request");

      const byKey = await readApprovalByKey(approval.idempotencyKey);
      if (byKey) return classifyExisting(byKey);

      const t = iso(now);
      const guardSql = "id = ? AND current_bundle_revision = ? AND status = 'NEEDS_REVIEW'";
      const guardParams = [approval.sessionId, expected];
      const dKey = makeDeliveryKey("approval_notification", approval.sessionId, expected);
      let applied = false;
      try {
        const [, , upd] = await db.batch([
          db
            .prepare(
              `INSERT INTO approvals (id, session_id, bundle_revision, approver_provider_id, approved_at, idempotency_key,
                 request_fingerprint, finalization_status)
               SELECT ?, ?, ?, ?, ?, ?, ?, 'pending' WHERE EXISTS (SELECT 1 FROM sessions WHERE ${guardSql})`,
            )
            .bind(
              approval.id, approval.sessionId, approval.bundleRevision, approval.approverProviderId, approval.approvedAt,
              approval.idempotencyKey, approval.requestFingerprint, ...guardParams,
            ),
          db
            .prepare(
              `INSERT INTO pending_deliveries (delivery_key, operation, session_id, revision, payload_json, attempts,
                 next_attempt_at, status, last_error, created_at, updated_at)
               SELECT ?, 'approval_notification', ?, ?, ?, 0, ?, 'pending', NULL, ?, ?
               WHERE EXISTS (SELECT 1 FROM sessions WHERE ${guardSql})`,
            )
            .bind(dKey, approval.sessionId, expected, JSON.stringify(write.notificationPayload ?? {}), t, t, t, ...guardParams),
          db
            .prepare(`UPDATE sessions SET status = 'APPROVED', status_reason = NULL, updated_at = ? WHERE ${guardSql}`)
            .bind(t, ...guardParams),
        ]);
        applied = changes(upd) === 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Whole batch rolled back. Re-classify against what won.
        const raced = await readApprovalByKey(approval.idempotencyKey);
        if (raced) return classifyExisting(raced);
        return fail("conflict", "revision already approved under a different request");
      }
      if (applied) return { ok: true, value: { approval: { ...approval, finalizationStatus: "pending" }, replayed: false } };

      const s = await readSession(approval.sessionId);
      if (!s) return fail("not_found");
      const forRevision = await db
        .prepare("SELECT id FROM approvals WHERE session_id = ? AND bundle_revision = ?")
        .bind(approval.sessionId, expected)
        .first<Row>();
      if (forRevision) return fail("conflict", "revision already approved under a different request");
      if (s.currentBundleRevision !== expected) return fail("stale_revision", `current revision is ${s.currentBundleRevision}`);
      return fail("invalid_state", `status is ${s.status}`);
    },

    async getApprovalForSession(sessionId) {
      const r = await db
        .prepare("SELECT * FROM approvals WHERE session_id = ? ORDER BY bundle_revision DESC LIMIT 1")
        .bind(sessionId)
        .first<Row>();
      return r ? rowToApproval(r) : null;
    },

    getApprovalByKey: readApprovalByKey,

    // ------------------------------------------------ finalization
    async finalizeApproved(sessionId, approvalId, bundleRevision, now) {
      const matches = (f: FinalBundle) => f.approvalId === approvalId && f.bundleRevision === bundleRevision;
      const existing = await readFinal(sessionId);
      if (existing) return matches(existing) ? { ok: true, value: existing } : fail("conflict", "session finalized with another approval");

      const t = iso(now);
      // Shared guard: session APPROVED at the approved revision with a pending approval.
      const guard = `EXISTS (SELECT 1 FROM sessions s JOIN approvals a ON a.session_id = s.id
                       WHERE s.id = ? AND s.status = 'APPROVED' AND s.current_bundle_revision = ?
                         AND a.id = ? AND a.bundle_revision = ? AND a.finalization_status = 'pending')`;
      const g = [sessionId, bundleRevision, approvalId, bundleRevision];
      let applied = false;
      try {
        const [ins] = await db.batch([
          db
            .prepare(
              `INSERT INTO final_bundles (session_id, bundle_revision, approval_id, finalized_at, bundle_json)
               SELECT b.session_id, b.revision, ?, ?, b.bundle_json FROM bundles b
               WHERE b.session_id = ? AND b.revision = ? AND ${guard}`,
            )
            .bind(approvalId, t, sessionId, bundleRevision, ...g),
          // Each later write checks the same guard AND that the final row now exists.
          db
            .prepare(
              `UPDATE sessions SET status = 'COMPLETED', status_reason = NULL, updated_at = ?
               WHERE id = ? AND ${guard}
                 AND EXISTS (SELECT 1 FROM final_bundles f WHERE f.session_id = ? AND f.approval_id = ?)`,
            )
            .bind(t, sessionId, ...g, sessionId, approvalId),
          db
            .prepare(
              `UPDATE approvals SET finalization_status = 'finalized'
               WHERE id = ? AND session_id = ? AND bundle_revision = ? AND finalization_status = 'pending'
                 AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = ? AND s.status = 'COMPLETED')
                 AND EXISTS (SELECT 1 FROM final_bundles f WHERE f.session_id = ? AND f.approval_id = ? AND f.finalized_at = ?)`,
            )
            .bind(approvalId, sessionId, bundleRevision, sessionId, sessionId, approvalId, t),
        ]);
        applied = changes(ins) === 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const raced = await readFinal(sessionId);
        if (raced && matches(raced)) return { ok: true, value: raced };
        return fail("conflict", "final record already exists");
      }
      if (applied) {
        const f = await readFinal(sessionId);
        if (f) return { ok: true, value: f };
      }
      const s = await readSession(sessionId);
      if (!s) return fail("not_found");
      const a = await db.prepare("SELECT * FROM approvals WHERE id = ?").bind(approvalId).first<Row>();
      if (!a || String(a.session_id) !== sessionId) return fail("not_found", "approval not found");
      if (Number(a.bundle_revision) !== bundleRevision) return fail("conflict", "approval is for another revision");
      if (s.status !== "APPROVED") return fail("invalid_state", `status is ${s.status}`);
      if (s.currentBundleRevision !== bundleRevision) return fail("stale_revision", `current revision is ${s.currentBundleRevision}`);
      return fail("not_found", "approved bundle missing");
    },

    getFinalBundle: readFinal,

    async listApprovedUnfinalized(limit) {
      const { results } = await db
        .prepare(
          `SELECT a.* FROM approvals a JOIN sessions s ON s.id = a.session_id
           WHERE s.status = 'APPROVED' AND a.finalization_status = 'pending' AND a.bundle_revision = s.current_bundle_revision
           ORDER BY a.approved_at ASC, a.id ASC LIMIT ?`,
        )
        .bind(Math.max(0, Math.floor(limit)))
        .all<Row>();
      return results.map(rowToApproval);
    },

    // ------------------------------------------------ pending deliveries
    async claimDueDeliveries(now, limit) {
      const t = iso(now);
      const lease = iso(new Date(now.getTime() + CLAIM_LEASE_MS));
      // Single statement: select-and-bump is atomic, so concurrent claimers
      // cannot both claim the same row (the lease moves it out of "due").
      const { results } = await db
        .prepare(
          `UPDATE pending_deliveries SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
           WHERE delivery_key IN (
             SELECT delivery_key FROM pending_deliveries
             WHERE status = 'pending' AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC, delivery_key ASC LIMIT ?)
           RETURNING *`,
        )
        .bind(lease, t, t, Math.max(0, Math.floor(limit)))
        .all<Row>();
      return results.map(rowToDelivery).sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.deliveryKey.localeCompare(b.deliveryKey));
    },

    async completeDelivery(deliveryKey, now) {
      await db
        .prepare("UPDATE pending_deliveries SET status = 'done', last_error = NULL, updated_at = ? WHERE delivery_key = ?")
        .bind(iso(now), deliveryKey)
        .run();
    },

    async failDelivery(deliveryKey, error, now, maxAttempts) {
      const msg = error.slice(0, MAX_ERROR_LEN);
      const t = iso(now);
      // Optimistic compare-and-set on (status, attempts) so a concurrent claim
      // or completion is never overwritten; retried a few times on contention.
      for (let i = 0; i < 5; i++) {
        const current = await readDelivery(deliveryKey);
        if (!current) throw new Error(`failDelivery: unknown delivery ${deliveryKey}`);
        if (current.status !== "pending") return current.status;
        const exhausted = current.attempts >= maxAttempts;
        const status: PendingDelivery["status"] = exhausted ? "exhausted" : "pending";
        const next = exhausted ? current.nextAttemptAt : iso(new Date(now.getTime() + backoffMs(current.attempts)));
        const res = await db
          .prepare(
            `UPDATE pending_deliveries SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
             WHERE delivery_key = ? AND status = 'pending' AND attempts = ?`,
          )
          .bind(status, next, msg, t, deliveryKey, current.attempts)
          .run();
        if (changes(res) === 1) return status;
      }
      throw new Error(`failDelivery: contention on ${deliveryKey}`);
    },

    getDelivery: readDelivery,
  };
  return repo;
}

