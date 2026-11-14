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
  AiSettings,
  ConnectionProvider,
  EmailSettings,
  FileDelivery,
  OAuthPending,
  StorageSettings,
  StoredConnection,
  ClientInput,
  ClientRecord,
  ClientSnapshot,
  ClientStats,
  DocumentTemplate,
  RunEvent,
  RunSummary,
  TemplateInput,
} from "../contracts";

/** v2 adds "file_delivery": an auto drive upload after completion (payload: { deliveryId }). */
export type PendingOperation = "process_session" | "approval_notification" | "file_delivery";

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

  // ================================================================ v2
  // ---- per-provider settings (defaults from DEFAULT_*_SETTINGS when unset)
  getStorageSettings(providerId: string): Promise<StorageSettings>;
  saveStorageSettings(providerId: string, settings: StorageSettings, now: Date): Promise<void>;
  getEmailSettings(providerId: string): Promise<EmailSettings>;
  saveEmailSettings(providerId: string, settings: EmailSettings, now: Date): Promise<void>;
  /** Default when unset: DEFAULT_AI_SETTINGS, with provider overridden by env.AI_PROVIDER at the call site. */
  getAiSettings(providerId: string): Promise<AiSettings | null>;
  saveAiSettings(providerId: string, settings: AiSettings, now: Date): Promise<void>;
  /** Identity for a provider id (for email templates). */
  getProviderIdentity(providerId: string): Promise<string | null>;

  // ---- cloud connections (tokens stay encrypted; callers encrypt/decrypt)
  getConnection(providerId: string, provider: ConnectionProvider): Promise<StoredConnection | null>;
  listConnections(providerId: string): Promise<StoredConnection[]>;
  saveConnection(conn: StoredConnection): Promise<void>;
  deleteConnection(providerId: string, provider: ConnectionProvider): Promise<void>;
  /** One-time OAuth state (PKCE verifier + return path). */
  saveOAuthPending(p: OAuthPending): Promise<void>;
  /** Atomically deletes and returns the row if present and not expired; else null. */
  consumeOAuthPending(nonce: string, now: Date): Promise<OAuthPending | null>;

  // ---- file deliveries (drive uploads, email drafts)
  createFileDelivery(d: FileDelivery): Promise<void>;
  updateFileDelivery(
    id: string,
    patch: Partial<Pick<FileDelivery, "status" | "externalId" | "webUrl" | "error">>,
    now: Date,
  ): Promise<void>;
  getFileDelivery(id: string): Promise<FileDelivery | null>;
  listFileDeliveries(sessionId: string): Promise<FileDelivery[]>;
  /** COMPLETED sessions for a provider, newest service first, with their final bundles. Cursor pagination ≤50. */
  listCompletedForProvider(
    providerId: string,
    limit: number,
    cursor: string | null,
  ): Promise<{ items: { session: SessionRecord; final: FinalBundle; approval: ApprovalRecord }[]; nextCursor: string | null }>;
  /** Generic pending delivery insert (used for "file_delivery"). Idempotent per deliveryKey. */
  enqueuePendingDelivery(d: { deliveryKey: string; operation: PendingOperation; sessionId: string; revision: number; payload: Record<string, unknown> }, now: Date): Promise<void>;

  // ================================================================ v3
  // ---- clients (provider-scoped; clientRef unique per provider)
  listClients(providerId: string, opts: { includeInactive: boolean; search?: string; limit: number }): Promise<{ client: ClientRecord; stats: ClientStats }[]>;
  getClient(providerId: string, clientRef: string): Promise<ClientRecord | null>;
  /** Insert or update. rateVersion starts at 1 and is bumped iff hourlyRateCents changes. */
  upsertClient(providerId: string, input: ClientInput, now: Date): Promise<ClientRecord>;
  /** Snapshot frozen for a finalized revision (idempotent per session+revision). */
  saveClientSnapshot(sessionId: string, bundleRevision: number, snapshot: ClientSnapshot): Promise<void>;
  getClientSnapshot(sessionId: string, bundleRevision: number): Promise<ClientSnapshot | null>;

  // ---- document templates (provider-scoped; built-ins are NOT stored — callers merge them)
  listTemplates(providerId: string, kind?: string): Promise<DocumentTemplate[]>;
  getTemplate(providerId: string, id: string): Promise<DocumentTemplate | null>;
  createTemplate(providerId: string, id: string, input: TemplateInput, now: Date): Promise<DocumentTemplate>;
  updateTemplate(providerId: string, id: string, input: TemplateInput, now: Date): Promise<DocumentTemplate | null>;
  deleteTemplate(providerId: string, id: string): Promise<boolean>;
  /** Default template id per kind (may be a builtin id); null = builtin default. */
  getDefaultTemplateId(providerId: string, kind: string): Promise<string | null>;
  setDefaultTemplateId(providerId: string, kind: string, id: string | null, now: Date): Promise<void>;

  // ---- run history
  /** INSERT OR IGNORE by id (retried steps don't duplicate). */
  appendRunEvent(e: RunEvent): Promise<void>;
  listRunEvents(runId: string, providerId: string): Promise<RunEvent[]>;
  /** Runs aggregated from events, newest first; status filter optional; cursor pagination ≤50. */
  listRuns(providerId: string, opts: { status?: RunSummary["status"]; sessionId?: string; limit: number; cursor: string | null }): Promise<{ runs: RunSummary[]; nextCursor: string | null }>;
}
