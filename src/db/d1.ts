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
  SyncSettings,
  DEFAULT_SYNC_SETTINGS,
  SupersededRevision,
  AiSettings,
  ConnectionProvider,
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  EmailSettings,
  FileDelivery,
  StorageSettings,
  type OAuthPending,
  type StoredConnection,
  ClientInput,
  ClientRecord,
  ClientSnapshot,
  ClientStats,
  CustomField,
  DocumentTemplate,
  RunEvent,
  RunSummary,
  TemplateInput,
  TemplateSection,
  TemplateText,
  TemplateTheme,
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
  operation: z.enum(["process_session", "approval_notification", "file_delivery"]),
  sessionId: z.string(),
  revision: z.number().int(),
  payload: z.record(z.unknown()),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string(),
  status: z.enum(["pending", "done", "exhausted"]),
  lastError: z.string().nullable(),
});

const StoredConnectionSchema = z.object({
  providerId: z.string().min(1),
  provider: ConnectionProvider,
  accountEmail: z.string().nullable(),
  scopes: z.array(z.string()),
  encryptedTokens: z.string().min(1),
  accessTokenExpiresAt: z.string().nullable(),
  status: z.enum(["connected", "error"]),
  lastError: z.string().nullable(),
  connectedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const OAuthPendingSchema = z.object({
  nonce: z.string().min(1),
  providerId: z.string().min(1),
  provider: ConnectionProvider,
  codeVerifier: z.string().min(1),
  returnTo: z.string(),
  expiresAt: z.string().min(1),
});

type SettingsKind = "storage" | "email" | "ai";

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

function rowToSyncSettings(r: Row): SyncSettings {
  return SyncSettings.parse({
    enabled: Number(r.enabled) === 1,
    intervalMinutes: Number(r.interval_minutes),
    lookbackDays: Number(r.lookback_days),
  });
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

function rowToConnection(r: Row): StoredConnection {
  return StoredConnectionSchema.parse({
    providerId: r.provider_id,
    provider: r.provider,
    accountEmail: r.account_email ?? null,
    scopes: JSON.parse(String(r.scopes_json)),
    encryptedTokens: r.encrypted_tokens,
    accessTokenExpiresAt: r.access_token_expires_at ?? null,
    status: r.status,
    lastError: r.last_error ?? null,
    connectedAt: r.connected_at,
    updatedAt: r.updated_at,
  });
}

function rowToOAuthPending(r: Row): OAuthPending {
  return OAuthPendingSchema.parse({
    nonce: r.nonce,
    providerId: r.provider_id,
    provider: r.provider,
    codeVerifier: r.code_verifier,
    returnTo: r.return_to,
    expiresAt: r.expires_at,
  });
}

function rowToFileDelivery(r: Row): FileDelivery {
  return FileDelivery.parse({
    id: r.id,
    sessionId: r.session_id,
    bundleRevision: Number(r.bundle_revision),
    target: r.target,
    provider: r.provider,
    files: JSON.parse(String(r.files_json)),
    status: r.status,
    externalId: r.external_id ?? null,
    webUrl: r.web_url ?? null,
    recipients: JSON.parse(String(r.recipients_json)),
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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

// ------------------------------------------------------------------ v3 helpers

const CLIENT_LIST_MAX = 500;
const TEMPLATE_KINDS = ["session_note", "invoice", "approval_record"] as const;

const ClientTemplatesSchema = ClientInput.shape.templates;
const TemplateConfigSchema = z.object({
  theme: TemplateTheme,
  sections: z.array(TemplateSection),
  text: TemplateText,
});
const RunMetaSchema = RunEvent.shape.meta;

function nullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToClient(r: Row): ClientRecord {
  return ClientRecord.parse({
    providerId: r.provider_id,
    clientRef: r.client_ref,
    displayName: r.display_name ?? null,
    preferredName: r.preferred_name ?? null,
    hourlyRateCents: nullableNumber(r.hourly_rate_cents),
    fundingSource: r.funding_source ?? null,
    authorizationNumber: r.authorization_number ?? null,
    fiscalIntermediary: r.fiscal_intermediary ?? null,
    authorizedHours: nullableNumber(r.authorized_hours),
    caseManager: r.case_manager ?? null,
    customFields: z.array(CustomField).parse(JSON.parse(String(r.custom_fields_json))),
    templates: ClientTemplatesSchema.parse(JSON.parse(String(r.templates_json))),
    notes: r.notes ?? null,
    active: Number(r.active) === 1,
    rateVersion: Number(r.rate_version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function rowToClientStats(r: Row): ClientStats {
  const lastMs = nullableNumber(r.st_last_ms);
  return ClientStats.parse({
    sessions: Number(r.st_sessions ?? 0),
    completed: Number(r.st_completed ?? 0),
    needsReview: Number(r.st_needs_review ?? 0),
    billedCents: Number(r.st_billed_cents ?? 0),
    billedMinutes: Number(r.st_billed_minutes ?? 0),
    lastServiceAt: lastMs === null ? null : new Date(lastMs).toISOString(),
  });
}

function rowToTemplate(r: Row): DocumentTemplate {
  const cfg = TemplateConfigSchema.parse(JSON.parse(String(r.config_json)));
  return DocumentTemplate.parse({
    id: r.id,
    kind: r.kind,
    name: r.name,
    theme: cfg.theme,
    sections: cfg.sections,
    text: cfg.text,
    builtin: false,
    isDefault: r.default_kind !== null && r.default_kind !== undefined,
    updatedAt: r.updated_at,
  });
}

function rowToRunEvent(r: Row): RunEvent {
  return RunEvent.parse({
    id: r.id,
    runId: r.run_id,
    runKind: r.run_kind,
    sessionId: r.session_id,
    providerId: r.provider_id,
    stage: r.stage,
    status: r.status,
    label: r.label,
    detail: r.detail ?? null,
    meta: RunMetaSchema.parse(JSON.parse(String(r.meta_json))),
    at: r.at,
  });
}

/** LIKE pattern for a case-insensitive substring match, with %, _ and \ escaped (ESCAPE '\'). */
function likeContains(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function encodeRunCursor(startedMs: number, runId: string): string {
  return btoa(JSON.stringify(["run", startedMs, runId]));
}

function decodeRunCursor(cursor: string): { startedMs: number; runId: string } {
  try {
    const v: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(v) && v.length === 3 && v[0] === "run" && Number.isSafeInteger(v[1]) && typeof v[2] === "string") {
      return { startedMs: v[1] as number, runId: v[2] };
    }
  } catch {
    // fall through
  }
  throw new RangeError("invalid cursor");
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

  async function readSettings(providerId: string, kind: SettingsKind): Promise<unknown | null> {
    const r = await db
      .prepare("SELECT value_json FROM provider_settings WHERE provider_id = ? AND kind = ?")
      .bind(providerId, kind)
      .first<Row>();
    return r ? (JSON.parse(String(r.value_json)) as unknown) : null;
  }

  async function writeSettings(providerId: string, kind: SettingsKind, value: unknown, now: Date): Promise<void> {
    await db
      .prepare(
        `INSERT INTO provider_settings (provider_id, kind, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id, kind) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(providerId, kind, JSON.stringify(value), iso(now))
      .run();
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

    async listDiscoverableAppointments(now, lookbackMinutes, limit, providerId) {
      const nowMs = now.getTime();
      const { results } = await db
        .prepare(
          `SELECT * FROM appointments
           WHERE canceled = 0 AND end_ms <= ?1 AND end_ms >= ?2
             AND (?4 IS NULL OR provider_id = ?4)
           ORDER BY end_ms ASC, id ASC LIMIT ?3`,
        )
        .bind(nowMs, nowMs - Math.max(0, lookbackMinutes) * 60_000, Math.max(0, Math.floor(limit)), providerId ?? null)
        .all<Row>();
      return results.map(rowToAppointment);
    },

    async getSyncSettings(providerId) {
      const row = await db
        .prepare(`SELECT * FROM provider_sync_settings WHERE provider_id = ?`)
        .bind(providerId)
        .first<Row>();
      if (!row) return { settings: { ...DEFAULT_SYNC_SETTINGS }, lastRunAt: null };
      return { settings: rowToSyncSettings(row), lastRunAt: (row.last_run_at as string | null) ?? null };
    },

    async saveSyncSettings(providerId, settings, now) {
      const s = SyncSettings.parse(settings);
      await db
        .prepare(
          `INSERT INTO provider_sync_settings (provider_id, enabled, interval_minutes, lookback_days, last_run_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, NULL, ?5)
           ON CONFLICT(provider_id) DO UPDATE SET
             enabled = excluded.enabled,
             interval_minutes = excluded.interval_minutes,
             lookback_days = excluded.lookback_days,
             updated_at = excluded.updated_at`,
        )
        .bind(providerId, s.enabled ? 1 : 0, s.intervalMinutes, s.lookbackDays, now.toISOString())
        .run();
    },

    async listProvidersDueForSync(now, limit) {
      // Providers without a row use DEFAULT_SYNC_SETTINGS (enabled).
      const { results } = await db
        .prepare(
          `SELECT p.id AS provider_id,
                  COALESCE(s.enabled, ?1) AS enabled,
                  COALESCE(s.interval_minutes, ?2) AS interval_minutes,
                  COALESCE(s.lookback_days, ?3) AS lookback_days,
                  s.last_run_at AS last_run_at
           FROM providers p LEFT JOIN provider_sync_settings s ON s.provider_id = p.id
           ORDER BY p.id LIMIT ?4`,
        )
        .bind(
          DEFAULT_SYNC_SETTINGS.enabled ? 1 : 0,
          DEFAULT_SYNC_SETTINGS.intervalMinutes,
          DEFAULT_SYNC_SETTINGS.lookbackDays,
          Math.max(0, Math.floor(limit)),
        )
        .all<Row>();
      const nowMs = now.getTime();
      return results
        .map((r) => ({ providerId: r.provider_id as string, settings: rowToSyncSettings(r), lastRunAt: r.last_run_at as string | null }))
        .filter((r) => {
          if (!r.settings.enabled) return false;
          if (!r.lastRunAt) return true;
          // Small tolerance so a 5-minute interval isn't skipped by heartbeat jitter.
          return Date.parse(r.lastRunAt) + r.settings.intervalMinutes * 60_000 - 30_000 <= nowMs;
        })
        .map(({ providerId, settings }) => ({ providerId, settings }));
    },

    async markSyncRun(providerId, now) {
      const iso = now.toISOString();
      await db
        .prepare(
          `INSERT INTO provider_sync_settings (provider_id, enabled, interval_minutes, lookback_days, last_run_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT(provider_id) DO UPDATE SET last_run_at = excluded.last_run_at`,
        )
        .bind(
          providerId,
          DEFAULT_SYNC_SETTINGS.enabled ? 1 : 0,
          DEFAULT_SYNC_SETTINGS.intervalMinutes,
          DEFAULT_SYNC_SETTINGS.lookbackDays,
          iso,
        )
        .run();
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

    // ------------------------------------------------ amendments
    async amendSession(sessionId, expectedRevision, bundleIn, reason, actorProviderId, now) {
      const bundle = SessionBundle.parse(bundleIn);
      if (bundle.sessionId !== sessionId) return fail("conflict", "bundle belongs to another session");
      if (bundle.bundleRevision !== expectedRevision + 1) {
        return fail("conflict", `bundle revision must be ${expectedRevision + 1}`);
      }
      const t = iso(now);
      // Every write shares this guard; the session update runs LAST so the guard holds for all.
      const guardSql = "id = ? AND current_bundle_revision = ? AND status = 'COMPLETED'";
      const guardParams = [sessionId, expectedRevision];
      const sessionGuard = `EXISTS (SELECT 1 FROM sessions WHERE ${guardSql})`;
      let applied = false;
      try {
        const results = await db.batch([
          db
            .prepare(
              `INSERT INTO superseded_finals (session_id, bundle_revision, approval_id, finalized_at, bundle_json,
                                              superseded_at, superseded_by_revision, reason, actor_provider_id)
               SELECT f.session_id, f.bundle_revision, f.approval_id, f.finalized_at, f.bundle_json, ?, ?, ?, ?
               FROM final_bundles f WHERE f.session_id = ? AND f.bundle_revision = ? AND ${sessionGuard}`,
            )
            .bind(t, bundle.bundleRevision, reason, actorProviderId, sessionId, expectedRevision, ...guardParams),
          insertBundleGuarded(bundle, now, guardSql, guardParams),
          db
            .prepare(
              `DELETE FROM final_bundles WHERE session_id = ? AND bundle_revision = ? AND ${sessionGuard}
                 AND EXISTS (SELECT 1 FROM superseded_finals x
                             WHERE x.session_id = ? AND x.bundle_revision = ? AND x.superseded_at = ?)`,
            )
            .bind(sessionId, expectedRevision, ...guardParams, sessionId, expectedRevision, t),
          db
            .prepare(
              `UPDATE sessions SET status = 'NEEDS_REVIEW', current_bundle_revision = ?, status_reason = ?, updated_at = ?
               WHERE ${guardSql}
                 AND NOT EXISTS (SELECT 1 FROM final_bundles f WHERE f.session_id = ?)
                 AND EXISTS (SELECT 1 FROM bundles b WHERE b.session_id = ? AND b.revision = ?)`,
            )
            .bind(bundle.bundleRevision, `Amending approved revision ${expectedRevision}`, t, ...guardParams, sessionId, sessionId, bundle.bundleRevision),
        ]);
        applied = changes(results[3]) === 1;
        if (!applied && changes(results[0]) === 1) {
          // Partial application is impossible by construction; fail loudly if it ever happens.
          throw new Error("amendSession: inconsistent batch result");
        }
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

    async listSupersededRevisions(sessionId) {
      const { results } = await db
        .prepare("SELECT * FROM superseded_finals WHERE session_id = ? ORDER BY bundle_revision DESC")
        .bind(sessionId)
        .all<Row>();
      return results.map((r) => {
        const b = parseBundleJson(r.bundle_json);
        return SupersededRevision.parse({
          sessionId: r.session_id,
          bundleRevision: Number(r.bundle_revision),
          approvalId: r.approval_id,
          finalizedAt: r.finalized_at,
          supersededAt: r.superseded_at,
          supersededByRevision: Number(r.superseded_by_revision),
          reason: r.reason,
          actorProviderId: r.actor_provider_id,
          amountCents: b.billing.amountCents,
        });
      });
    },

    async devResetSession(sessionId) {
      const tables: [string, string][] = [
        ["evidence", "session_id"],
        ["bundles", "session_id"],
        ["approvals", "session_id"],
        ["final_bundles", "session_id"],
        ["superseded_finals", "session_id"],
        ["pending_deliveries", "session_id"],
        ["file_deliveries", "session_id"],
        ["client_snapshots", "session_id"],
        ["run_events", "session_id"],
      ];
      // Keep the session row and its processing_revision: workflow instance ids
      // (session + processing revision) persist in the Workflows runtime, so the next
      // sync must start a NEW processing revision rather than reuse an old id.
      await db.batch([
        ...tables.map(([t, col]) => db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).bind(sessionId)),
        db
          .prepare(
            `UPDATE sessions SET status = 'WAITING_FOR_EVIDENCE', current_bundle_revision = 0, workflow_id = NULL,
               status_reason = 'Reset (dev)', updated_at = ? WHERE id = ?`,
          )
          .bind(new Date().toISOString(), sessionId),
      ]);
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

    // ================================================ v2
    // ------------------------------------------------ per-provider settings
    async getStorageSettings(providerId) {
      const v = await readSettings(providerId, "storage");
      return v === null ? StorageSettings.parse(DEFAULT_STORAGE_SETTINGS) : StorageSettings.parse(v);
    },
    async saveStorageSettings(providerId, settings, now) {
      await writeSettings(providerId, "storage", StorageSettings.parse(settings), now);
    },
    async getEmailSettings(providerId) {
      const v = await readSettings(providerId, "email");
      return v === null ? EmailSettings.parse(DEFAULT_EMAIL_SETTINGS) : EmailSettings.parse(v);
    },
    async saveEmailSettings(providerId, settings, now) {
      await writeSettings(providerId, "email", EmailSettings.parse(settings), now);
    },
    async getAiSettings(providerId) {
      const v = await readSettings(providerId, "ai");
      return v === null ? null : AiSettings.parse(v);
    },
    async saveAiSettings(providerId, settings, now) {
      await writeSettings(providerId, "ai", AiSettings.parse(settings), now);
    },
    async getProviderIdentity(providerId) {
      const r = await db.prepare("SELECT identity FROM providers WHERE id = ?").bind(providerId).first<Row>();
      return r ? String(r.identity) : null;
    },

    // ------------------------------------------------ cloud connections
    async getConnection(providerId, provider) {
      const r = await db
        .prepare("SELECT * FROM connections WHERE provider_id = ? AND provider = ?")
        .bind(providerId, ConnectionProvider.parse(provider))
        .first<Row>();
      return r ? rowToConnection(r) : null;
    },
    async listConnections(providerId) {
      const { results } = await db
        .prepare("SELECT * FROM connections WHERE provider_id = ? ORDER BY provider ASC")
        .bind(providerId)
        .all<Row>();
      return results.map(rowToConnection);
    },
    async saveConnection(conn) {
      const c = StoredConnectionSchema.parse(conn);
      await db
        .prepare(
          `INSERT INTO connections (provider_id, provider, account_email, scopes_json, encrypted_tokens,
             access_token_expires_at, status, last_error, connected_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, provider) DO UPDATE SET
             account_email = excluded.account_email, scopes_json = excluded.scopes_json,
             encrypted_tokens = excluded.encrypted_tokens, access_token_expires_at = excluded.access_token_expires_at,
             status = excluded.status, last_error = excluded.last_error,
             connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
        )
        .bind(
          c.providerId, c.provider, c.accountEmail, JSON.stringify(c.scopes), c.encryptedTokens,
          c.accessTokenExpiresAt, c.status, c.lastError === null ? null : c.lastError.slice(0, MAX_ERROR_LEN),
          c.connectedAt, c.updatedAt,
        )
        .run();
    },
    async deleteConnection(providerId, provider) {
      await db
        .prepare("DELETE FROM connections WHERE provider_id = ? AND provider = ?")
        .bind(providerId, ConnectionProvider.parse(provider))
        .run();
    },
    async saveOAuthPending(p) {
      const v = OAuthPendingSchema.parse(p);
      toMs(v.expiresAt);
      await db
        .prepare(
          `INSERT INTO oauth_pending (nonce, provider_id, provider, code_verifier, return_to, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(v.nonce, v.providerId, v.provider, v.codeVerifier, v.returnTo, v.expiresAt)
        .run();
    },
    async consumeOAuthPending(nonce, now) {
      // Single DELETE ... RETURNING: at most one caller ever gets the row.
      // Expired rows are deleted too, but yield null.
      const r = await db.prepare("DELETE FROM oauth_pending WHERE nonce = ? RETURNING *").bind(nonce).first<Row>();
      if (!r) return null;
      const p = rowToOAuthPending(r);
      const exp = Date.parse(p.expiresAt);
      if (!Number.isFinite(exp) || exp <= now.getTime()) return null;
      return p;
    },

    // ------------------------------------------------ file deliveries
    async createFileDelivery(d) {
      const v = FileDelivery.parse(d);
      await db
        .prepare(
          `INSERT INTO file_deliveries (id, session_id, bundle_revision, target, provider, files_json, status,
             external_id, web_url, recipients_json, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          v.id, v.sessionId, v.bundleRevision, v.target, v.provider, JSON.stringify(v.files), v.status,
          v.externalId, v.webUrl, JSON.stringify(v.recipients), v.error, v.createdAt, v.updatedAt,
        )
        .run();
    },
    async updateFileDelivery(id, patch, now) {
      const p = FileDelivery.pick({ status: true, externalId: true, webUrl: true, error: true })
        .partial()
        .parse(typeof patch.error === "string" ? { ...patch, error: patch.error.slice(0, MAX_ERROR_LEN) } : patch);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (p.status !== undefined) { sets.push("status = ?"); params.push(p.status); }
      if (p.externalId !== undefined) { sets.push("external_id = ?"); params.push(p.externalId); }
      if (p.webUrl !== undefined) { sets.push("web_url = ?"); params.push(p.webUrl); }
      if (p.error !== undefined) { sets.push("error = ?"); params.push(p.error); }
      sets.push("updated_at = ?");
      params.push(iso(now));
      await db
        .prepare(`UPDATE file_deliveries SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...params, id)
        .run();
    },
    async getFileDelivery(id) {
      const r = await db.prepare("SELECT * FROM file_deliveries WHERE id = ?").bind(id).first<Row>();
      return r ? rowToFileDelivery(r) : null;
    },
    async listFileDeliveries(sessionId) {
      const { results } = await db
        .prepare("SELECT * FROM file_deliveries WHERE session_id = ? ORDER BY created_at DESC, id DESC")
        .bind(sessionId)
        .all<Row>();
      return results.map(rowToFileDelivery);
    },
    async listCompletedForProvider(providerId, limit, cursor) {
      const pageSize = Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_PAGE_SIZE);
      const c = cursor ? decodeCursor(cursor) : null;
      const sql = `
        SELECT s.id, s.provider_id, s.appointment_id, s.occurrence_id, s.status, s.processing_revision,
               s.current_bundle_revision, s.workflow_id, s.status_reason, s.created_at, s.updated_at,
               a.start_ms AS appt_start_ms,
               f.bundle_revision AS f_bundle_revision, f.approval_id AS f_approval_id,
               f.finalized_at AS f_finalized_at, f.bundle_json AS f_bundle_json,
               ap.id AS ap_id, ap.session_id AS ap_session_id, ap.bundle_revision AS ap_bundle_revision,
               ap.approver_provider_id AS ap_approver_provider_id, ap.approved_at AS ap_approved_at,
               ap.idempotency_key AS ap_idempotency_key, ap.request_fingerprint AS ap_request_fingerprint,
               ap.finalization_status AS ap_finalization_status
        FROM sessions s
        JOIN appointments a ON a.id = s.appointment_id
        JOIN final_bundles f ON f.session_id = s.id
        JOIN approvals ap ON ap.id = f.approval_id
        WHERE s.provider_id = ? AND s.status = 'COMPLETED'
          ${c ? "AND (a.start_ms < ? OR (a.start_ms = ? AND s.id < ?))" : ""}
        ORDER BY a.start_ms DESC, s.id DESC
        LIMIT ?`;
      const params: unknown[] = c ? [providerId, c.startMs, c.startMs, c.id, pageSize + 1] : [providerId, pageSize + 1];
      const { results } = await db.prepare(sql).bind(...params).all<Row>();
      const page = results.slice(0, pageSize);
      const items = page.map((r) => ({
        session: rowToSession(r),
        final: rowToFinal({
          session_id: r.id,
          bundle_revision: r.f_bundle_revision,
          approval_id: r.f_approval_id,
          finalized_at: r.f_finalized_at,
          bundle_json: r.f_bundle_json,
        }),
        approval: rowToApproval({
          id: r.ap_id,
          session_id: r.ap_session_id,
          bundle_revision: r.ap_bundle_revision,
          approver_provider_id: r.ap_approver_provider_id,
          approved_at: r.ap_approved_at,
          idempotency_key: r.ap_idempotency_key,
          request_fingerprint: r.ap_request_fingerprint,
          finalization_status: r.ap_finalization_status,
        }),
      }));
      const last = page[page.length - 1];
      const nextCursor = results.length > pageSize && last ? encodeCursor(Number(last.appt_start_ms), String(last.id)) : null;
      return { items, nextCursor };
    },
    async enqueuePendingDelivery(d, now) {
      const v = z
        .object({
          deliveryKey: z.string().min(1),
          operation: PendingDeliverySchema.shape.operation,
          sessionId: z.string().min(1),
          revision: z.number().int(),
          payload: z.record(z.unknown()),
        })
        .parse(d);
      const t = iso(now);
      await db
        .prepare(
          `INSERT OR IGNORE INTO pending_deliveries (delivery_key, operation, session_id, revision, payload_json, attempts,
             next_attempt_at, status, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', NULL, ?, ?)`,
        )
        .bind(v.deliveryKey, v.operation, v.sessionId, v.revision, JSON.stringify(v.payload), t, t, t)
        .run();
    },

    // ================================================================ v3
    // ---------------------------------------------------------------- clients
    async listClients(providerId, opts) {
      const limit = Math.min(Math.max(Math.floor(opts.limit) || 1, 1), CLIENT_LIST_MAX);
      const search = opts.search?.trim() ?? "";
      const where: string[] = ["c.provider_id = ?"];
      const params: unknown[] = [providerId, providerId];
      if (!opts.includeInactive) where.push("c.active = 1");
      if (search) {
        const pat = likeContains(search);
        where.push(
          "(LOWER(c.client_ref) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.display_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.preferred_name, '')) LIKE ? ESCAPE '\\')",
        );
        params.push(pat, pat, pat);
      }
      params.push(limit);
      // params order: stats subquery providerId, then c.provider_id, then search, then limit
      const sql = `
        SELECT c.*,
               st.sessions AS st_sessions, st.completed AS st_completed, st.needs_review AS st_needs_review,
               st.billed_cents AS st_billed_cents, st.billed_minutes AS st_billed_minutes, st.last_ms AS st_last_ms
        FROM clients c
        LEFT JOIN (
          SELECT a.client_ref AS client_ref,
                 COUNT(*) AS sessions,
                 SUM(CASE WHEN s.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
                 SUM(CASE WHEN s.status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END) AS needs_review,
                 SUM(CASE WHEN f.session_id IS NOT NULL THEN COALESCE(json_extract(f.bundle_json, '$.billing.amountCents'), 0) ELSE 0 END) AS billed_cents,
                 SUM(CASE WHEN f.session_id IS NOT NULL THEN COALESCE(json_extract(f.bundle_json, '$.billing.confirmedMinutes'), 0) ELSE 0 END) AS billed_minutes,
                 MAX(a.start_ms) AS last_ms
          FROM sessions s
          JOIN appointments a ON a.id = s.appointment_id AND a.provider_id = s.provider_id
          LEFT JOIN final_bundles f ON f.session_id = s.id
          WHERE s.provider_id = ?
          GROUP BY a.client_ref
        ) st ON st.client_ref = c.client_ref
        WHERE ${where.join(" AND ")}
        ORDER BY (st.last_ms IS NULL), st.last_ms DESC, c.client_ref ASC
        LIMIT ?`;
      const { results } = await db.prepare(sql).bind(...params).all<Row>();
      return results.map((r) => ({ client: rowToClient(r), stats: rowToClientStats(r) }));
    },
    async getClient(providerId, clientRef) {
      const r = await db
        .prepare("SELECT * FROM clients WHERE provider_id = ? AND client_ref = ?")
        .bind(providerId, clientRef)
        .first<Row>();
      return r ? rowToClient(r) : null;
    },
    async upsertClient(providerId, inputIn, now) {
      const input = ClientInput.parse(inputIn);
      const t = iso(now);
      // rate_version: 1 on insert; +1 on update iff hourly_rate_cents changes (IS handles NULLs).
      const r = await db
        .prepare(
          `INSERT INTO clients (provider_id, client_ref, display_name, preferred_name, hourly_rate_cents, funding_source,
             authorization_number, fiscal_intermediary, authorized_hours, case_manager, custom_fields_json, templates_json,
             notes, active, rate_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(provider_id, client_ref) DO UPDATE SET
             display_name = excluded.display_name,
             preferred_name = excluded.preferred_name,
             hourly_rate_cents = excluded.hourly_rate_cents,
             funding_source = excluded.funding_source,
             authorization_number = excluded.authorization_number,
             fiscal_intermediary = excluded.fiscal_intermediary,
             authorized_hours = excluded.authorized_hours,
             case_manager = excluded.case_manager,
             custom_fields_json = excluded.custom_fields_json,
             templates_json = excluded.templates_json,
             notes = excluded.notes,
             active = excluded.active,
             rate_version = CASE WHEN clients.hourly_rate_cents IS excluded.hourly_rate_cents
                                 THEN clients.rate_version ELSE clients.rate_version + 1 END,
             updated_at = excluded.updated_at
           RETURNING *`,
        )
        .bind(
          providerId,
          input.clientRef,
          input.displayName,
          input.preferredName,
          input.hourlyRateCents,
          input.fundingSource,
          input.authorizationNumber,
          input.fiscalIntermediary,
          input.authorizedHours,
          input.caseManager,
          JSON.stringify(input.customFields),
          JSON.stringify(input.templates),
          input.notes,
          input.active ? 1 : 0,
          t,
          t,
        )
        .first<Row>();
      if (r) return rowToClient(r);
      const stored = await repo.getClient(providerId, input.clientRef);
      if (!stored) throw new Error("client upsert failed");
      return stored;
    },
    async saveClientSnapshot(sessionId, bundleRevision, snapshotIn) {
      const snapshot = ClientSnapshot.parse(snapshotIn);
      await db
        .prepare(
          "INSERT OR IGNORE INTO client_snapshots (session_id, bundle_revision, snapshot_json, captured_at) VALUES (?, ?, ?, ?)",
        )
        .bind(sessionId, bundleRevision, JSON.stringify(snapshot), snapshot.capturedAt)
        .run();
    },
    async getClientSnapshot(sessionId, bundleRevision) {
      const r = await db
        .prepare("SELECT snapshot_json FROM client_snapshots WHERE session_id = ? AND bundle_revision = ?")
        .bind(sessionId, bundleRevision)
        .first<Row>();
      return r ? ClientSnapshot.parse(JSON.parse(String(r.snapshot_json))) : null;
    },

    // ---------------------------------------------------------------- templates
    async listTemplates(providerId, kind) {
      const sql = `
        SELECT t.*, d.kind AS default_kind
        FROM document_templates t
        LEFT JOIN default_templates d ON d.provider_id = t.provider_id AND d.kind = t.kind AND d.template_id = t.id
        WHERE t.provider_id = ? ${kind ? "AND t.kind = ?" : ""}
        ORDER BY t.kind ASC, t.name COLLATE NOCASE ASC, t.id ASC`;
      const { results } = await db
        .prepare(sql)
        .bind(...(kind ? [providerId, kind] : [providerId]))
        .all<Row>();
      return results.map(rowToTemplate);
    },
    async getTemplate(providerId, id) {
      const r = await db
        .prepare(
          `SELECT t.*, d.kind AS default_kind
           FROM document_templates t
           LEFT JOIN default_templates d ON d.provider_id = t.provider_id AND d.kind = t.kind AND d.template_id = t.id
           WHERE t.provider_id = ? AND t.id = ?`,
        )
        .bind(providerId, id)
        .first<Row>();
      return r ? rowToTemplate(r) : null;
    },
    async createTemplate(providerId, id, inputIn, now) {
      const input = TemplateInput.parse(inputIn);
      const t = iso(now);
      await db
        .prepare(
          `INSERT INTO document_templates (id, provider_id, kind, name, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, providerId, input.kind, input.name, JSON.stringify({ theme: input.theme, sections: input.sections, text: input.text }), t, t)
        .run();
      const stored = await repo.getTemplate(providerId, id);
      if (!stored) throw new Error("template create failed");
      return stored;
    },
    async updateTemplate(providerId, id, inputIn, now) {
      const input = TemplateInput.parse(inputIn);
      const results = await db.batch([
        db
          .prepare(
            `UPDATE document_templates SET kind = ?, name = ?, config_json = ?, updated_at = ?
             WHERE provider_id = ? AND id = ?`,
          )
          .bind(
            input.kind,
            input.name,
            JSON.stringify({ theme: input.theme, sections: input.sections, text: input.text }),
            iso(now),
            providerId,
            id,
          ),
        // A kind change invalidates a default set for the previous kind.
        db
          .prepare("DELETE FROM default_templates WHERE provider_id = ? AND template_id = ? AND kind <> ?")
          .bind(providerId, id, input.kind),
      ]);
      if (changes(results[0]) === 0) return null;
      return repo.getTemplate(providerId, id);
    },
    async deleteTemplate(providerId, id) {
      const results = await db.batch([
        db.prepare("DELETE FROM document_templates WHERE provider_id = ? AND id = ?").bind(providerId, id),
        db.prepare("DELETE FROM default_templates WHERE provider_id = ? AND template_id = ?").bind(providerId, id),
      ]);
      return changes(results[0]) > 0;
    },
    async getDefaultTemplateId(providerId, kind) {
      const r = await db
        .prepare("SELECT template_id FROM default_templates WHERE provider_id = ? AND kind = ?")
        .bind(providerId, kind)
        .first<Row>();
      return r ? String(r.template_id) : null;
    },
    async setDefaultTemplateId(providerId, kind, id, now) {
      const k = z.enum(TEMPLATE_KINDS).parse(kind);
      if (id === null) {
        await db.prepare("DELETE FROM default_templates WHERE provider_id = ? AND kind = ?").bind(providerId, k).run();
        return;
      }
      await db
        .prepare(
          `INSERT INTO default_templates (provider_id, kind, template_id, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(provider_id, kind) DO UPDATE SET template_id = excluded.template_id, updated_at = excluded.updated_at`,
        )
        .bind(providerId, k, z.string().min(1).max(128).parse(id), iso(now))
        .run();
    },

    // ---------------------------------------------------------------- run history
    async appendRunEvent(eIn) {
      const e = RunEvent.parse(eIn);
      await db
        .prepare(
          `INSERT OR IGNORE INTO run_events (id, run_id, run_kind, session_id, provider_id, stage, status, label, detail, meta_json, at, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(e.id, e.runId, e.runKind, e.sessionId, e.providerId, e.stage, e.status, e.label, e.detail, JSON.stringify(e.meta), e.at, toMs(e.at))
        .run();
    },
    async listRunEvents(runId, providerId) {
      const { results } = await db
        .prepare("SELECT * FROM run_events WHERE run_id = ? AND provider_id = ? ORDER BY at_ms ASC, id ASC")
        .bind(runId, providerId)
        .all<Row>();
      return results.map(rowToRunEvent);
    },
    async listRuns(providerId, opts) {
      const pageSize = Math.min(Math.max(Math.floor(opts.limit) || 1, 1), MAX_PAGE_SIZE);
      const c = opts.cursor ? decodeRunCursor(opts.cursor) : null;
      const status = opts.status ? RunSummary.shape.status.parse(opts.status) : null;
      // Aggregation + status classification happen in SQL so status filtering
      // and keyset pagination stay consistent. Status rule (first match wins):
      //   failed    — some event has status 'failed' and no terminal success at/after the latest failure
      //   succeeded — a terminal success exists: stage 'completed' succeeded, or a delivery_drive /
      //               delivery_email event succeeded
      //   waiting   — the latest event's status is 'waiting'
      //   running   — otherwise
      const sql = `
        WITH agg AS (
          SELECT run_id,
                 MIN(at_ms) AS started_ms,
                 MAX(at_ms) AS last_ms,
                 COUNT(*) AS event_count,
                 MAX(CASE WHEN status = 'failed' THEN at_ms END) AS fail_ms,
                 MAX(CASE WHEN status = 'succeeded' AND stage IN ('completed', 'delivery_drive', 'delivery_email') THEN at_ms END) AS success_ms
          FROM run_events
          WHERE provider_id = ? ${opts.sessionId ? "AND session_id = ?" : ""}
          GROUP BY run_id
        ),
        latest AS (
          SELECT agg.*,
                 (SELECT e.id FROM run_events e WHERE e.run_id = agg.run_id AND e.provider_id = ?
                  ORDER BY e.at_ms DESC, e.id DESC LIMIT 1) AS last_id
          FROM agg
        ),
        classified AS (
          SELECT latest.*, le.stage AS current_stage, le.run_kind AS run_kind, le.session_id AS session_id,
                 CASE
                   WHEN fail_ms IS NOT NULL AND (success_ms IS NULL OR success_ms < fail_ms) THEN 'failed'
                   WHEN success_ms IS NOT NULL THEN 'succeeded'
                   WHEN le.status = 'waiting' THEN 'waiting'
                   ELSE 'running'
                 END AS run_status
          FROM latest JOIN run_events le ON le.id = latest.last_id
        )
        SELECT cl.*,
               (SELECT a.client_ref FROM sessions s JOIN appointments a ON a.id = s.appointment_id
                WHERE s.id = cl.session_id AND s.provider_id = ?) AS client_ref,
               (SELECT json_extract(x.meta_json, '$.aiProvider') FROM run_events x
                WHERE x.run_id = cl.run_id AND x.provider_id = ? AND x.stage = 'extraction'
                  AND json_extract(x.meta_json, '$.aiProvider') IS NOT NULL
                ORDER BY x.at_ms DESC, x.id DESC LIMIT 1) AS ai_provider,
               (SELECT json_extract(x.meta_json, '$.model') FROM run_events x
                WHERE x.run_id = cl.run_id AND x.provider_id = ? AND x.stage = 'extraction'
                  AND json_extract(x.meta_json, '$.model') IS NOT NULL
                ORDER BY x.at_ms DESC, x.id DESC LIMIT 1) AS model
        FROM classified cl
        WHERE 1 = 1
          ${status ? "AND cl.run_status = ?" : ""}
          ${c ? "AND (cl.started_ms < ? OR (cl.started_ms = ? AND cl.run_id < ?))" : ""}
        ORDER BY cl.started_ms DESC, cl.run_id DESC
        LIMIT ?`;
      const params: unknown[] = [providerId];
      if (opts.sessionId) params.push(opts.sessionId);
      params.push(providerId, providerId, providerId, providerId);
      if (status) params.push(status);
      if (c) params.push(c.startedMs, c.startedMs, c.runId);
      params.push(pageSize + 1);
      const { results } = await db.prepare(sql).bind(...params).all<Row>();
      const page = results.slice(0, pageSize);
      const runs = page.map((r) => {
        const startedMs = Number(r.started_ms);
        const terminal = r.run_status === "failed" || r.run_status === "succeeded";
        const endedMs = terminal ? Number(r.last_ms) : null;
        return RunSummary.parse({
          runId: r.run_id,
          runKind: r.run_kind,
          sessionId: r.session_id,
          clientRef: r.client_ref ?? null,
          status: r.run_status,
          currentStage: r.current_stage,
          startedAt: new Date(startedMs).toISOString(),
          endedAt: endedMs === null ? null : new Date(endedMs).toISOString(),
          durationMs: endedMs === null ? null : Math.max(0, endedMs - startedMs),
          eventCount: Number(r.event_count),
          aiProvider: r.ai_provider === null || r.ai_provider === undefined ? null : String(r.ai_provider),
          model: r.model === null || r.model === undefined ? null : String(r.model),
        });
      });
      const last = page[page.length - 1];
      const nextCursor = results.length > pageSize && last ? encodeRunCursor(Number(last.started_ms), String(last.run_id)) : null;
      return { runs, nextCursor };
    },
  };
  return repo;
}
