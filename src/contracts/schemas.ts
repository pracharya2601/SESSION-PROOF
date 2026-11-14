/**
 * Shared domain contracts (Agent 02 scope). FROZEN — change only via the
 * integration lead. Every module imports types from `src/contracts`; never
 * redeclare these shapes locally.
 *
 * Conventions (handoff §8.1):
 *  - IDs are opaque strings; never derive authorization from a prefix.
 *  - Instants are UTC ISO-8601 strings. Appointment keeps its IANA timezone.
 *  - Durations are integer minutes. Money is integer cents (USD).
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1";

// ---------------------------------------------------------------- primitives
const Id = z.string().min(1).max(128);
const Instant = z.string().datetime({ offset: true });
const ShortText = z.string().max(2000);

export const SourceMode = z.enum(["live", "fixture"]);
export type SourceMode = z.infer<typeof SourceMode>;

export const RuntimeMode = z.enum(["local", "deployed"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export const SessionStatus = z.enum([
  "SCHEDULED",
  "WAITING_FOR_EVIDENCE",
  "QUEUED",
  "PROCESSING",
  "NEEDS_REVIEW",
  "APPROVED",
  "COMPLETED",
  "NO_EVIDENCE",
  "AMBIGUOUS_MATCH",
  "INCOMPLETE",
  "FAILED",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ---------------------------------------------------------------- config
export const Appointment = z.object({
  id: Id,
  occurrenceId: Id,
  providerId: Id,
  clientRef: Id,
  startAt: Instant,
  endAt: Instant,
  timezone: z.string().min(1).max(64),
  serviceCode: Id,
  planVersion: Id,
  ruleVersion: Id,
  rateVersion: Id,
  canceled: z.boolean().default(false),
});
export type Appointment = z.infer<typeof Appointment>;

export const PlanGoal = z.object({ goalId: Id, objective: ShortText });
export const Plan = z.object({
  planVersion: Id,
  serviceCode: Id,
  serviceDescription: ShortText,
  goals: z.array(PlanGoal).min(1).max(20),
});
export type Plan = z.infer<typeof Plan>;
export type PlanGoal = z.infer<typeof PlanGoal>;

/** Required-field identifiers understood by the rules engine (Agent 12). */
export const RequiredField = z.enum([
  "service_date",
  "provider_identity",
  "client_reference",
  "service_description",
  "goal_addressed",
  "progress_statement",
  "confirmed_duration",
]);
export type RequiredField = z.infer<typeof RequiredField>;

export const RuleSet = z.object({
  ruleVersion: Id,
  serviceCode: Id,
  required: z.array(RequiredField),
  /** Whether a provider attestation may satisfy progress_statement. */
  allowProviderProgressAttestation: z.boolean(),
});
export type RuleSet = z.infer<typeof RuleSet>;

export const RateRule = z.object({
  rateVersion: Id,
  currency: z.literal("USD"),
  hourlyRateCents: z.number().int().nonnegative().max(10_000_000),
  /** Declared maximum confirmed duration (minutes). */
  maxMinutes: z.number().int().positive().max(24 * 60),
});
export type RateRule = z.infer<typeof RateRule>;

/** Frozen per-bundle configuration snapshot. */
export const ServiceConfig = z.object({ plan: Plan, rules: RuleSet, rate: RateRule });
export type ServiceConfig = z.infer<typeof ServiceConfig>;

// ---------------------------------------------------------------- evidence
export const EvidenceItem = z.object({
  id: Id,
  sourceId: Id.nullable(),
  sourceMode: SourceMode,
  observedFrom: Instant.nullable(),
  observedTo: Instant.nullable(),
  /** Speaker label exactly as upstream supplied it; null when absent. Never invented. */
  speaker: z.string().max(64).nullable().default(null),
  excerpt: z.string().max(4000),
  retrievedAt: Instant,
  citationUrl: z.string().url().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const EvidenceResult = z.object({
  items: z.array(EvidenceItem).max(500),
  completeness: z.enum(["complete", "partial", "unknown"]),
  unavailableSourceIds: z.array(Id),
  warnings: z.array(ShortText),
});
export type EvidenceResult = z.infer<typeof EvidenceResult>;

export const MatchResult = z.object({
  outcome: z.enum(["matched", "ambiguous", "no_evidence"]),
  /** Evidence eligible for THIS appointment (empty unless matched). */
  evidence: z.array(EvidenceItem),
  competingAppointmentIds: z.array(Id),
  window: z.object({ from: Instant, to: Instant }),
  /** Observed range of matched evidence — informational only, never billable. */
  evidenceWindow: z.object({ from: Instant, to: Instant }).nullable(),
  reasons: z.array(ShortText),
  warnings: z.array(ShortText),
});
export type MatchResult = z.infer<typeof MatchResult>;

// ---------------------------------------------------------------- facts
export const FactClaim = z.object({
  id: Id,
  text: ShortText,
  evidenceIds: z.array(Id).max(50),
  support: z.enum(["supported", "uncertain", "provider_confirmed"]),
  providerAttestationId: Id.optional(),
});
export type FactClaim = z.infer<typeof FactClaim>;

export const GoalFact = z.object({
  goalId: Id,
  status: z.enum(["addressed", "partially_addressed", "unknown"]),
  claims: z.array(FactClaim).max(50),
});
export type GoalFact = z.infer<typeof GoalFact>;

export const SessionFacts = z.object({
  activities: z.array(FactClaim).max(50),
  observations: z.array(FactClaim).max(50),
  goals: z.array(GoalFact).max(20),
  progress: z.array(FactClaim).max(50),
  followUps: z.array(FactClaim).max(50),
  missingInformation: z.array(ShortText).max(50),
});
export type SessionFacts = z.infer<typeof SessionFacts>;

export const ProviderAttestation = z.object({
  id: Id,
  /** v3 adds participant_direction (text = "yes"/"no" + optional choices, see ReviewEdits). */
  field: z.enum(["progress", "duration", "participant_direction", "participant_choices", "amendment_reason"]),
  text: ShortText,
  actorProviderId: Id,
  attestedAt: Instant,
  bundleRevision: z.number().int().positive(),
});
export type ProviderAttestation = z.infer<typeof ProviderAttestation>;

// ---------------------------------------------------------------- documents
/** One rendered line with provenance back to claims/evidence/attestations. */
export const DocumentLine = z.object({
  text: ShortText,
  claimIds: z.array(Id),
  evidenceIds: z.array(Id),
  attestationIds: z.array(Id),
  origin: z.enum(["extracted", "provider_attestation", "system_notice", "configuration"]),
});
export type DocumentLine = z.infer<typeof DocumentLine>;

export const DocumentSection = z.object({
  key: z.enum([
    "session_note",
    "progress_record",
    "plan_coverage",
    "follow_ups",
    "missing_information",
    "time_summary",
  ]),
  title: z.string().max(200),
  lines: z.array(DocumentLine).max(200),
});
export type DocumentSection = z.infer<typeof DocumentSection>;

export const PlanCoverageEntry = z.object({
  goalId: Id,
  objective: ShortText,
  status: z.enum(["addressed", "partially_addressed", "unknown"]),
  claimIds: z.array(Id),
});
export type PlanCoverageEntry = z.infer<typeof PlanCoverageEntry>;

export const TimeSummary = z.object({
  scheduledFrom: Instant,
  scheduledTo: Instant,
  scheduledMinutes: z.number().int().nonnegative(),
  evidenceWindowFrom: Instant.nullable(),
  evidenceWindowTo: Instant.nullable(),
  /** Informational only. Never substituted for confirmed duration. */
  evidenceWindowMinutes: z.number().int().nonnegative().nullable(),
  confirmedMinutes: z.number().int().positive().nullable(),
  timezone: z.string(),
});
export type TimeSummary = z.infer<typeof TimeSummary>;

export const Documents = z.object({
  sections: z.array(DocumentSection),
  planCoverage: z.array(PlanCoverageEntry),
  timeSummary: TimeSummary,
});
export type Documents = z.infer<typeof Documents>;

// ---------------------------------------------------------------- checks
export const DocumentationIssue = z.object({
  code: z.string().max(64),
  field: z.string().max(64),
  message: ShortText,
  blocking: z.boolean(),
});
export type DocumentationIssue = z.infer<typeof DocumentationIssue>;

export const DocumentationChecks = z.object({
  ruleVersion: Id,
  issues: z.array(DocumentationIssue),
  canApprove: z.boolean(),
});
export type DocumentationChecks = z.infer<typeof DocumentationChecks>;

// ---------------------------------------------------------------- billing
export const BillingDraft = z.object({
  currency: z.literal("USD"),
  hourlyRateCents: z.number().int().nonnegative(),
  scheduledMinutes: z.number().int().nonnegative(),
  confirmedMinutes: z.number().int().positive().nullable(),
  amountCents: z.number().int().nonnegative().nullable(),
  estimateAmountCents: z.number().int().nonnegative().nullable(),
  isEstimate: z.boolean(),
  rateVersion: Id,
  rounding: z.literal("half_up_to_cent"),
  breakdown: z.string().max(500),
});
export type BillingDraft = z.infer<typeof BillingDraft>;

// ---------------------------------------------------------------- bundle
export const BundleProvenance = z.object({
  evidenceMode: SourceMode,
  extractionMode: SourceMode,
  runtimeMode: RuntimeMode,
  schemaVersion: z.string(),
  promptVersion: z.string(),
  model: z.string().nullable(),
  evidenceCompleteness: z.enum(["complete", "partial", "unknown"]),
  evidenceWarnings: z.array(ShortText),
  /** v2: which inference provider produced the facts (null for fixture). */
  aiProvider: z.string().max(32).nullable().optional(),
  /** v2: PII scrubbing applied before inference. Counts only — never the values. */
  privacy: z
    .object({ scrubbed: z.boolean(), findings: z.record(z.string(), z.number().int().nonnegative()) })
    .optional(),
});
export type BundleProvenance = z.infer<typeof BundleProvenance>;

export const SessionBundle = z.object({
  sessionId: Id,
  bundleRevision: z.number().int().positive(),
  processingRevision: z.number().int().positive(),
  appointment: Appointment,
  config: ServiceConfig,
  evidence: z.array(EvidenceItem),
  evidenceWindow: z.object({ from: Instant, to: Instant }).nullable(),
  /** Facts exactly as extracted (no attestations). Re-assembly starts from this. */
  extractedFacts: SessionFacts,
  /** Display view: extracted facts + provider attestations as provider_confirmed claims. */
  facts: SessionFacts,
  attestations: z.array(ProviderAttestation),
  documents: Documents,
  checks: DocumentationChecks,
  billing: BillingDraft,
  provenance: BundleProvenance,
  createdAt: Instant,
});
export type SessionBundle = z.infer<typeof SessionBundle>;

// ---------------------------------------------------------------- review/approval
export const MAX_CONFIRMED_MINUTES = 12 * 60;

/** Allowlisted provider edits — NOT an arbitrary patch. */
export const ReviewEdits = z
  .object({
    confirmedMinutes: z.number().int().positive().max(MAX_CONFIRMED_MINUTES).optional(),
    progressConfirmation: z.string().trim().min(1).max(2000).optional(),
    /** v3 self-determination: did the participant direct the activity? */
    participantDirected: z.boolean().optional(),
    /** v3: participant's own choices / preferences, in the provider's words. */
    participantChoices: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((e) => Object.values(e).some((v) => v !== undefined), {
    message: "At least one allowed edit is required",
  });
export type ReviewEdits = z.infer<typeof ReviewEdits>;

export const ReviewRequest = z
  .object({ expectedRevision: z.number().int().positive(), edits: ReviewEdits })
  .strict();
export type ReviewRequest = z.infer<typeof ReviewRequest>;

export const ApprovalRequest = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ApprovalRecord = z.object({
  id: Id,
  sessionId: Id,
  bundleRevision: z.number().int().positive(),
  approverProviderId: Id,
  approvedAt: Instant,
  idempotencyKey: z.string(),
  requestFingerprint: z.string(),
  finalizationStatus: z.enum(["pending", "finalized"]),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

export const FinalBundle = z.object({
  sessionId: Id,
  bundleRevision: z.number().int().positive(),
  approvalId: Id,
  finalizedAt: Instant,
  bundle: SessionBundle,
});
export type FinalBundle = z.infer<typeof FinalBundle>;

// ---------------------------------------------------------------- session views
export const SessionRecord = z.object({
  id: Id,
  providerId: Id,
  appointmentId: Id,
  occurrenceId: Id,
  status: SessionStatus,
  processingRevision: z.number().int().nonnegative(),
  currentBundleRevision: z.number().int().nonnegative(),
  workflowId: z.string().nullable(),
  statusReason: ShortText.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export const SessionSummary = z.object({
  id: Id,
  status: SessionStatus,
  clientRef: Id,
  serviceCode: Id,
  startAt: Instant,
  endAt: Instant,
  timezone: z.string(),
  currentBundleRevision: z.number().int().nonnegative(),
  statusReason: ShortText.nullable(),
  evidenceMode: SourceMode.nullable(),
  extractionMode: SourceMode.nullable(),
  canApprove: z.boolean().nullable(),
  amountCents: z.number().int().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionDetail = z.object({
  session: SessionRecord,
  appointment: Appointment,
  bundle: SessionBundle.nullable(),
  approval: ApprovalRecord.nullable(),
  finalized: z.boolean(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

// ---------------------------------------------------------------- envelopes
export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  correlationId: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;
export type ApiSuccess<T> = { data: T; correlationId: string };
export type ApiFailure = { error: ApiError };

export const HealthResponse = z.object({
  ok: z.boolean(),
  schemaVersion: z.string(),
  evidenceMode: SourceMode,
  extractionMode: SourceMode,
  runtimeMode: RuntimeMode,
  authMode: z.enum(["dev", "access"]),
  bindings: z.object({ db: z.boolean(), queue: z.boolean(), workflow: z.boolean() }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ListSessionsResponse = z.object({
  sessions: z.array(SessionSummary),
  nextCursor: z.string().nullable(),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;

export const ApproveResponse = z.object({
  approval: ApprovalRecord,
  /** "pending" => 202 (durable approval exists, finalization not yet done). */
  finalization: z.enum(["pending", "finalized"]),
});
export type ApproveResponse = z.infer<typeof ApproveResponse>;

// ---------------------------------------------------------------- jobs
export const QueuePayload = z
  .object({
    schemaVersion: z.literal("1"),
    sessionId: Id,
    processingRevision: z.number().int().positive(),
  })
  .strict();
export type QueuePayload = z.infer<typeof QueuePayload>;

export const APPROVAL_EVENT_TYPE = "provider-approved" as const;
export const ApprovalNotification = z.object({
  type: z.literal(APPROVAL_EVENT_TYPE),
  payload: z.object({ approvalId: Id, sessionId: Id, bundleRevision: z.number().int().positive() }),
});
export type ApprovalNotification = z.infer<typeof ApprovalNotification>;

/** Params passed when creating a SessionWorkflow instance. */
export const WorkflowParams = QueuePayload;
export type WorkflowParams = QueuePayload;

export const DiscoverySummary = z.object({
  examined: z.number().int(),
  created: z.number().int(),
  enqueued: z.number().int(),
  skipped: z.number().int(),
});
export type DiscoverySummary = z.infer<typeof DiscoverySummary>;

export const DispatchSummary = z.object({
  attempted: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  exhausted: z.number().int(),
});
export type DispatchSummary = z.infer<typeof DispatchSummary>;

// ---------------------------------------------------------------- sync schedule
/**
 * Provider-controlled automatic sync schedule. Cloudflare cron triggers are
 * fixed at deploy time, so the Worker runs a fixed heartbeat (every 5 min) and
 * runs discovery for a provider only when their own interval is due.
 */
export const SYNC_HEARTBEAT_MINUTES = 5;
export const SYNC_INTERVAL_OPTIONS = [5, 15, 30, 60, 120, 240, 720, 1440] as const;
export const SyncSettings = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z
      .number()
      .int()
      .refine((n) => (SYNC_INTERVAL_OPTIONS as readonly number[]).includes(n), {
        message: `intervalMinutes must be one of ${SYNC_INTERVAL_OPTIONS.join(", ")}`,
      }),
    lookbackDays: z.number().int().min(1).max(30),
  })
  .strict();
export type SyncSettings = z.infer<typeof SyncSettings>;
export const DEFAULT_SYNC_SETTINGS: SyncSettings = { enabled: true, intervalMinutes: 15, lookbackDays: 7 };

export const SyncSettingsView = z.object({
  settings: SyncSettings,
  lastRunAt: Instant.nullable(),
  nextRunAt: Instant.nullable(),
  heartbeatMinutes: z.number().int(),
});
export type SyncSettingsView = z.infer<typeof SyncSettingsView>;
