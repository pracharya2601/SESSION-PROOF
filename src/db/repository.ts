/**
 * Repository interface (Agent 04 scope). FROZEN signatures — implementation
 * in src/db/d1.ts (`createRepository(db: D1Database): Repository`).
 *
 * Every provider-facing read is scoped by providerId. Conditional writes
 * return discriminated results instead of throwing on expected conflicts.
 */
import type {
  Appointment,
  ApprovalRecord,
  EvidenceItem,
  FinalBundle,
  ServiceConfig,
  SessionBundle,
  SessionRecord,
  SessionStatus,
  SessionSummary,
  SyncSettings,
} from "../contracts";

export type PendingOperation = "process_session" | "approval_notification";

export interface PendingDelivery {
  deliveryKey: string;
  operation: PendingOperation;
  sessionId: string;
  revision: number;
  /** Reference payload only (IDs/revisions) — never transcripts or credentials. */
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
  status: "pending" | "done" | "exhausted";
  lastError: string | null;
}

export type ConditionalResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "stale_revision" | "invalid_state" | "conflict"; detail?: string };

export interface ApprovalWrite {
  approval: ApprovalRecord;
  expectedBundleRevision: number;
  notificationPayload: Record<string, unknown>;
}

export interface Repository {
  // ---- providers & configuration
  upsertProvider(providerId: string, identity: string): Promise<void>;
  /** Maps an authenticated identity (e.g. Access email) to a provider id. */
  findProviderByIdentity(identity: string): Promise<string | null>;
  upsertServiceConfig(serviceCode: string, config: ServiceConfig): Promise<void>;
  getServiceConfig(planVersion: string, ruleVersion: string, rateVersion: string): Promise<ServiceConfig | null>;

  // ---- appointments (seeded; no calendar OAuth)
  upsertAppointment(appointment: Appointment): Promise<void>;
  getAppointment(appointmentId: string): Promise<Appointment | null>;
  /**
   * Completed (endAt <= now), not canceled, endAt >= now - lookbackMinutes.
   * When providerId is given, only that provider's appointments.
   */
  listDiscoverableAppointments(now: Date, lookbackMinutes: number, limit: number, providerId?: string): Promise<Appointment[]>;

  // ---- provider sync schedule (user-controlled)
  /** Stored settings, or DEFAULT_SYNC_SETTINGS when the provider has none. */
  getSyncSettings(providerId: string): Promise<{ settings: SyncSettings; lastRunAt: string | null }>;
  saveSyncSettings(providerId: string, settings: SyncSettings, now: Date): Promise<void>;
  /** Providers with auto-sync enabled whose lastRunAt + interval <= now (never-run = due). */
  listProvidersDueForSync(now: Date, limit: number): Promise<{ providerId: string; settings: SyncSettings }[]>;
  markSyncRun(providerId: string, now: Date): Promise<void>;
  /** Same-provider appointments overlapping [from, to) — candidates for ambiguity. */
  listProviderAppointmentsOverlapping(providerId: string, from: string, to: string): Promise<Appointment[]>;

  // ---- sessions
  /**
   * Idempotent: creates the logical session for (providerId, occurrenceId) once.
   * Returns the existing row on repeat. `created` tells which happened.
   */
  ensureSession(appointment: Appointment, sessionId: string, now: Date): Promise<{ session: SessionRecord; created: boolean }>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  /** Scoped read — returns null when the session is not the provider's. */
  getSessionForProvider(providerId: string, sessionId: string): Promise<SessionRecord | null>;
  listSessionsForProvider(providerId: string, limit: number, cursor: string | null): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }>;
  /** Conditional transition: only applies when current status ∈ from. */
  transitionSession(sessionId: string, from: SessionStatus[], to: SessionStatus, reason: string | null, now: Date): Promise<ConditionalResult<SessionRecord>>;
  /**
   * Atomically (D1 batch): bump processing revision (only if status ∈ allowedFrom),
   * set status QUEUED, and record a process_session pending delivery.
   * Idempotent per (sessionId, newRevision).
   */
  enqueueProcessing(sessionId: string, allowedFrom: SessionStatus[], now: Date): Promise<ConditionalResult<{ processingRevision: number; deliveryKey: string }>>;
  setWorkflowId(sessionId: string, processingRevision: number, workflowId: string): Promise<void>;

  // ---- evidence (excerpts only)
  replaceEvidence(sessionId: string, processingRevision: number, items: EvidenceItem[]): Promise<void>;

  // ---- bundles
  /**
   * Idempotent draft write for a processing revision: inserts bundle revision
   * `bundle.bundleRevision` and sets session status NEEDS_REVIEW + current revision,
   * only if session.processingRevision === bundle.processingRevision and status is PROCESSING.
   * Re-running with an identical (sessionId, bundleRevision) returns the stored bundle.
   */
  saveDraft(bundle: SessionBundle, now: Date): Promise<ConditionalResult<SessionBundle>>;
  getBundle(sessionId: string, bundleRevision: number): Promise<SessionBundle | null>;
  getCurrentBundle(sessionId: string): Promise<SessionBundle | null>;
  /**
   * Review write: inserts `bundle` as revision expectedRevision+1 only if the
   * session's current revision === expectedRevision AND status is NEEDS_REVIEW.
   */
  saveReviewRevision(sessionId: string, expectedRevision: number, bundle: SessionBundle, now: Date): Promise<ConditionalResult<SessionBundle>>;

  // ---- approvals
  /**
   * Atomically: insert approval (unique per session+revision and per idempotencyKey),
   * transition NEEDS_REVIEW -> APPROVED guarded by current revision, and insert the
   * approval_notification pending delivery. All-or-nothing.
   * - Same idempotencyKey + same fingerprint  -> ok with the EXISTING approval.
   * - Same idempotencyKey + different fingerprint -> conflict.
   * - Stale revision / wrong state -> stale_revision / invalid_state, nothing written.
   */
  persistApproval(write: ApprovalWrite, now: Date): Promise<ConditionalResult<{ approval: ApprovalRecord; replayed: boolean }>>;
  getApprovalForSession(sessionId: string): Promise<ApprovalRecord | null>;
  getApprovalByKey(idempotencyKey: string): Promise<ApprovalRecord | null>;

  // ---- finalization
  /**
   * Idempotent: inserts the unique final record for the approved revision,
   * marks the approval finalized and transitions APPROVED -> COMPLETED.
   * Repeat calls return the existing final record.
   */
  finalizeApproved(sessionId: string, approvalId: string, bundleRevision: number, now: Date): Promise<ConditionalResult<FinalBundle>>;
  getFinalBundle(sessionId: string): Promise<FinalBundle | null>;
  /** Sessions in APPROVED status whose approval is still pending finalization. */
  listApprovedUnfinalized(limit: number): Promise<ApprovalRecord[]>;

  // ---- pending deliveries
  /** Claims up to `limit` due deliveries (status pending, nextAttemptAt <= now), bumping attempts. */
  claimDueDeliveries(now: Date, limit: number): Promise<PendingDelivery[]>;
  completeDelivery(deliveryKey: string, now: Date): Promise<void>;
  /** Records a failure; schedules retry with backoff, or marks exhausted at maxAttempts. */
  failDelivery(deliveryKey: string, error: string, now: Date, maxAttempts: number): Promise<PendingDelivery["status"]>;
  getDelivery(deliveryKey: string): Promise<PendingDelivery | null>;
}
