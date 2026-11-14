/**
 * Valid and invalid example payloads for the shared contracts (Agent 02).
 * Built by hand from the canonical fixture (fixtures/scenario.ts) — does NOT
 * import src/domain. Consumers (tests, QA, UI mocks) may import these; they
 * are not re-exported from src/contracts/index.ts to keep the worker bundle lean.
 *
 * Every `valid*` value parses with its schema; every `invalid*` entry fails.
 */
import {
  DEMO_PROVIDER_ID,
  EXPECTED,
  OTHER_PROVIDER_ID,
  demoAppointment,
  demoConfig,
  demoEvidence,
  demoFacts,
} from "../../fixtures/scenario";
import type {
  ApiError,
  ApprovalNotification,
  ApprovalRequest,
  QueuePayload,
  ReviewRequest,
  SessionBundle,
  SessionFacts,
} from "./schemas";

export interface InvalidExample {
  /** Why it must fail validation. */
  name: string;
  value: unknown;
}

const DEMO_SESSION_ID = "sess_demo_001";
const long = (n: number) => "x".repeat(n);

// ---------------------------------------------------------------- ReviewRequest (§9.3)
export const validReviewRequests: ReviewRequest[] = [
  {
    expectedRevision: 2,
    edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation },
  },
  { expectedRevision: 1, edits: { confirmedMinutes: 60 } },
  { expectedRevision: 1, edits: { progressConfirmation: EXPECTED.demoProgressConfirmation } },
  { expectedRevision: 1, edits: { confirmedMinutes: 720 } },
  { expectedRevision: 1, edits: { confirmedMinutes: 1 } },
];

export const invalidReviewRequests: InvalidExample[] = [
  { name: "amountCents in edits", value: { expectedRevision: 2, edits: { confirmedMinutes: 90, amountCents: 1 } } },
  { name: "hourlyRateCents in edits", value: { expectedRevision: 2, edits: { hourlyRateCents: 1 } } },
  { name: "facts patch in edits", value: { expectedRevision: 2, edits: { facts: demoFacts } } },
  { name: "empty edits", value: { expectedRevision: 2, edits: {} } },
  { name: "NaN minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: Number.NaN } } },
  { name: "Infinity minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: Number.POSITIVE_INFINITY } } },
  { name: "zero minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: 0 } } },
  { name: "negative minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: -30 } } },
  { name: "fractional minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: 90.5 } } },
  { name: "over-max minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: 721 } } },
  { name: "string minutes", value: { expectedRevision: 2, edits: { confirmedMinutes: "90" } } },
  { name: "whitespace-only progress", value: { expectedRevision: 2, edits: { progressConfirmation: "   " } } },
  { name: "oversized progress", value: { expectedRevision: 2, edits: { progressConfirmation: long(2001) } } },
  { name: "missing expectedRevision", value: { edits: { confirmedMinutes: 90 } } },
  { name: "zero expectedRevision", value: { expectedRevision: 0, edits: { confirmedMinutes: 90 } } },
  { name: "fractional expectedRevision", value: { expectedRevision: 1.5, edits: { confirmedMinutes: 90 } } },
  { name: "client providerId at top level", value: { expectedRevision: 2, providerId: DEMO_PROVIDER_ID, edits: { confirmedMinutes: 90 } } },
  { name: "edits is an array (JSON patch)", value: { expectedRevision: 2, edits: [{ op: "replace", path: "/billing/amountCents", value: 1 }] } },
  { name: "null body", value: null },
];

// ---------------------------------------------------------------- ApprovalRequest (§9.4)
export const validApprovalRequests: ApprovalRequest[] = [
  { expectedRevision: 3, idempotencyKey: EXPECTED.demoApprovalKey },
  { expectedRevision: 1, idempotencyKey: "abcdefgh" },
  { expectedRevision: 1, idempotencyKey: "A.b_c:d-e" + long(119) },
];

export const invalidApprovalRequests: InvalidExample[] = [
  { name: "client-supplied providerId", value: { expectedRevision: 3, idempotencyKey: EXPECTED.demoApprovalKey, providerId: DEMO_PROVIDER_ID } },
  { name: "client-supplied approverProviderId", value: { expectedRevision: 3, idempotencyKey: EXPECTED.demoApprovalKey, approverProviderId: OTHER_PROVIDER_ID } },
  { name: "client-supplied amountCents", value: { expectedRevision: 3, idempotencyKey: EXPECTED.demoApprovalKey, amountCents: 11250 } },
  { name: "key too short", value: { expectedRevision: 3, idempotencyKey: "short" } },
  { name: "key too long", value: { expectedRevision: 3, idempotencyKey: long(129) } },
  { name: "key with disallowed chars", value: { expectedRevision: 3, idempotencyKey: "demo key <script>" } },
  { name: "missing key", value: { expectedRevision: 3 } },
  { name: "zero revision", value: { expectedRevision: 0, idempotencyKey: EXPECTED.demoApprovalKey } },
  { name: "string revision", value: { expectedRevision: "3", idempotencyKey: EXPECTED.demoApprovalKey } },
];

// ---------------------------------------------------------------- QueuePayload (§9.6)
export const validQueuePayloads: QueuePayload[] = [
  { schemaVersion: "1", sessionId: DEMO_SESSION_ID, processingRevision: 1 },
  { schemaVersion: "1", sessionId: "sess_0123456789abcdef01234567", processingRevision: 7 },
];

export const invalidQueuePayloads: InvalidExample[] = [
  { name: "transcript field", value: { schemaVersion: "1", sessionId: DEMO_SESSION_ID, processingRevision: 1, transcript: demoEvidence } },
  { name: "credentials field", value: { schemaVersion: "1", sessionId: DEMO_SESSION_ID, processingRevision: 1, accessToken: "tok" } },
  { name: "browser-provided rate", value: { schemaVersion: "1", sessionId: DEMO_SESSION_ID, processingRevision: 1, hourlyRateCents: 1 } },
  { name: "ownership assertion", value: { schemaVersion: "1", sessionId: DEMO_SESSION_ID, processingRevision: 1, providerId: DEMO_PROVIDER_ID } },
  { name: "wrong schemaVersion", value: { schemaVersion: "2", sessionId: DEMO_SESSION_ID, processingRevision: 1 } },
  { name: "numeric schemaVersion", value: { schemaVersion: 1, sessionId: DEMO_SESSION_ID, processingRevision: 1 } },
  { name: "empty sessionId", value: { schemaVersion: "1", sessionId: "", processingRevision: 1 } },
  { name: "oversized sessionId", value: { schemaVersion: "1", sessionId: long(129), processingRevision: 1 } },
  { name: "zero processingRevision", value: { schemaVersion: "1", sessionId: DEMO_SESSION_ID, processingRevision: 0 } },
];

// ---------------------------------------------------------------- ApprovalNotification (§9.7)
export const validApprovalNotifications: ApprovalNotification[] = [
  { type: "provider-approved", payload: { approvalId: "approval_demo_001", sessionId: DEMO_SESSION_ID, bundleRevision: 3 } },
];

export const invalidApprovalNotifications: InvalidExample[] = [
  { name: "wrong event type", value: { type: "provider_approved", payload: { approvalId: "approval_demo_001", sessionId: DEMO_SESSION_ID, bundleRevision: 3 } } },
  { name: "other event type", value: { type: "approval-timeout", payload: { approvalId: "approval_demo_001", sessionId: DEMO_SESSION_ID, bundleRevision: 3 } } },
  { name: "missing approvalId", value: { type: "provider-approved", payload: { sessionId: DEMO_SESSION_ID, bundleRevision: 3 } } },
  { name: "zero bundleRevision", value: { type: "provider-approved", payload: { approvalId: "approval_demo_001", sessionId: DEMO_SESSION_ID, bundleRevision: 0 } } },
  { name: "missing payload", value: { type: "provider-approved" } },
];

// ---------------------------------------------------------------- ApiError (§9.5)
export const validApiErrors: ApiError[] = [
  { code: "stale_revision", message: "The session changed. Reload and review again.", retryable: false, correlationId: "corr_demo_001" },
  { code: "dependency_unavailable", message: "Evidence source temporarily unavailable.", retryable: true, correlationId: "corr_demo_002" },
];

export const invalidApiErrors: InvalidExample[] = [
  { name: "missing correlationId", value: { code: "x", message: "y", retryable: false } },
  { name: "string retryable", value: { code: "x", message: "y", retryable: "false", correlationId: "c" } },
  { name: "missing code", value: { message: "y", retryable: false, correlationId: "c" } },
];

// ---------------------------------------------------------------- SessionBundle
const scheduledFrom = demoAppointment.startAt;
const scheduledTo = demoAppointment.endAt;
const evidenceWindow = { from: "2026-11-13T18:05:00.000Z", to: "2026-11-13T18:53:00.000Z" };

const draftDocuments: SessionBundle["documents"] = {
  sections: [
    {
      key: "session_note",
      title: "Session note",
      lines: [
        { text: "Practiced planning a bus route to the library, including identifying a transfer stop.", claimIds: ["fact_act_1"], evidenceIds: ["ev_001", "ev_002"], attestationIds: [], origin: "extracted" },
        { text: "Reviewed the weekly food budget together.", claimIds: ["fact_act_2"], evidenceIds: ["ev_003"], attestationIds: [], origin: "extracted" },
        { text: "Participant located the route and the transfer stop on a map.", claimIds: ["fact_obs_1"], evidenceIds: ["ev_002"], attestationIds: [], origin: "extracted" },
      ],
    },
    {
      key: "progress_record",
      title: "Progress record",
      lines: [{ text: "Progress not established by the evidence; provider confirmation required.", claimIds: [], evidenceIds: [], attestationIds: [], origin: "system_notice" }],
    },
    {
      key: "plan_coverage",
      title: "Plan coverage",
      lines: [
        { text: "Practice transportation planning: addressed.", claimIds: ["fact_goal_1"], evidenceIds: ["ev_001", "ev_002"], attestationIds: [], origin: "extracted" },
        { text: "Practice budgeting: partially addressed.", claimIds: ["fact_goal_2"], evidenceIds: ["ev_003"], attestationIds: [], origin: "extracted" },
        { text: "Practice community interaction: unknown.", claimIds: [], evidenceIds: [], attestationIds: [], origin: "configuration" },
      ],
    },
    {
      key: "follow_ups",
      title: "Follow-ups",
      lines: [{ text: "Provider to bring another route-planning worksheet next session.", claimIds: ["fact_fu_1"], evidenceIds: ["ev_004"], attestationIds: [], origin: "extracted" }],
    },
    {
      key: "missing_information",
      title: "Missing information",
      lines: demoFacts.missingInformation.map((text) => ({ text, claimIds: [], evidenceIds: [], attestationIds: [], origin: "system_notice" as const })),
    },
    {
      key: "time_summary",
      title: "Time summary",
      lines: [
        { text: "Scheduled 10:00–11:00 America/Los_Angeles (60 minutes).", claimIds: [], evidenceIds: [], attestationIds: [], origin: "configuration" },
        { text: "Evidence observed 10:05–10:53 (informational only, not billable).", claimIds: [], evidenceIds: ["ev_001", "ev_005"], attestationIds: [], origin: "system_notice" },
        { text: "Confirmed duration: not yet confirmed by provider.", claimIds: [], evidenceIds: [], attestationIds: [], origin: "system_notice" },
      ],
    },
  ],
  planCoverage: [
    { goalId: "goal_transport", objective: "Practice transportation planning.", status: "addressed", claimIds: ["fact_goal_1"] },
    { goalId: "goal_budget", objective: "Practice budgeting.", status: "partially_addressed", claimIds: ["fact_goal_2"] },
    { goalId: "goal_community", objective: "Practice community interaction.", status: "unknown", claimIds: [] },
  ],
  timeSummary: {
    scheduledFrom,
    scheduledTo,
    scheduledMinutes: EXPECTED.scheduledMinutes,
    evidenceWindowFrom: evidenceWindow.from,
    evidenceWindowTo: evidenceWindow.to,
    evidenceWindowMinutes: 48,
    confirmedMinutes: null,
    timezone: demoAppointment.timezone,
  },
};

/** Initial Workflow draft: no confirmation, estimate only, approval blocked. */
export const validDraftBundle: SessionBundle = {
  sessionId: DEMO_SESSION_ID,
  bundleRevision: 2,
  processingRevision: 1,
  appointment: demoAppointment,
  config: demoConfig,
  evidence: demoEvidence,
  evidenceWindow,
  extractedFacts: demoFacts,
  facts: demoFacts,
  attestations: [],
  documents: draftDocuments,
  checks: {
    ruleVersion: "rules_demo_v1",
    issues: [
      { code: "missing_progress_statement", field: "progress_statement", message: "Progress statement required.", blocking: true },
      { code: "missing_confirmed_duration", field: "confirmed_duration", message: "Confirmed duration required.", blocking: true },
    ],
    canApprove: false,
  },
  billing: {
    currency: "USD",
    hourlyRateCents: 7500,
    scheduledMinutes: 60,
    confirmedMinutes: null,
    amountCents: null,
    estimateAmountCents: EXPECTED.estimateCents60,
    isEstimate: true,
    rateVersion: "rate_demo_v1",
    rounding: "half_up_to_cent",
    breakdown: "Estimate: 7500 cents/hour × 60 scheduled minutes / 60 = 7500 cents.",
  },
  provenance: {
    evidenceMode: "fixture",
    extractionMode: "fixture",
    runtimeMode: "local",
    schemaVersion: "1",
    promptVersion: "fixture-v1",
    model: null,
    evidenceCompleteness: "complete",
    evidenceWarnings: [],
  },
  createdAt: "2026-11-13T19:31:00.000Z",
};

const ATTESTED_AT = "2026-11-13T19:45:00.000Z";
const reviewedAttestations: SessionBundle["attestations"] = [
  { id: "att_progress_r3", field: "progress", text: EXPECTED.demoProgressConfirmation, actorProviderId: DEMO_PROVIDER_ID, attestedAt: ATTESTED_AT, bundleRevision: 3 },
  { id: "att_duration_r3", field: "duration", text: "90", actorProviderId: DEMO_PROVIDER_ID, attestedAt: ATTESTED_AT, bundleRevision: 3 },
];
const reviewedFacts: SessionFacts = {
  ...demoFacts,
  progress: [
    { id: "claim_att_progress_r3", text: EXPECTED.demoProgressConfirmation, evidenceIds: [], support: "provider_confirmed", providerAttestationId: "att_progress_r3" },
  ],
};

/** After the §9.3 review (90 minutes + progress): revision 3, 11250 cents, approvable. */
export const validReviewedBundle: SessionBundle = {
  ...validDraftBundle,
  bundleRevision: 3,
  facts: reviewedFacts,
  attestations: reviewedAttestations,
  documents: {
    ...draftDocuments,
    sections: draftDocuments.sections.map((s) =>
      s.key === "progress_record"
        ? { ...s, lines: [{ text: EXPECTED.demoProgressConfirmation, claimIds: ["claim_att_progress_r3"], evidenceIds: [], attestationIds: ["att_progress_r3"], origin: "provider_attestation" as const }] }
        : s,
    ),
    timeSummary: { ...draftDocuments.timeSummary, confirmedMinutes: 90 },
  },
  checks: { ruleVersion: "rules_demo_v1", issues: [], canApprove: true },
  billing: {
    ...validDraftBundle.billing,
    confirmedMinutes: 90,
    amountCents: EXPECTED.amountCents90,
    isEstimate: false,
    breakdown: "7500 cents/hour × 90 confirmed minutes / 60 = 11250 cents.",
  },
  createdAt: ATTESTED_AT,
};

export const validSessionBundles: SessionBundle[] = [validDraftBundle, validReviewedBundle];

export const invalidSessionBundles: InvalidExample[] = [
  { name: "zero bundleRevision", value: { ...validDraftBundle, bundleRevision: 0 } },
  { name: "fractional amountCents", value: { ...validReviewedBundle, billing: { ...validReviewedBundle.billing, amountCents: 11250.5 } } },
  { name: "non-USD currency", value: { ...validReviewedBundle, billing: { ...validReviewedBundle.billing, currency: "EUR" } } },
  { name: "zero confirmedMinutes in billing", value: { ...validReviewedBundle, billing: { ...validReviewedBundle.billing, confirmedMinutes: 0 } } },
  { name: "oversized evidence excerpt", value: { ...validDraftBundle, evidence: [{ ...demoEvidence[0], excerpt: long(4001) }] } },
  { name: "oversized claim text", value: { ...validDraftBundle, facts: { ...demoFacts, activities: [{ id: "c1", text: long(2001), evidenceIds: [], support: "supported" }] } } },
  { name: "oversized id", value: { ...validDraftBundle, sessionId: long(129) } },
  { name: "too many claims", value: { ...validDraftBundle, extractedFacts: { ...demoFacts, activities: Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, text: "t", evidenceIds: [], support: "supported" })) } } },
  { name: "unknown claim support", value: { ...validDraftBundle, facts: { ...demoFacts, progress: [{ id: "c1", text: "t", evidenceIds: [], support: "achieved" }] } } },
  { name: "non-ISO createdAt", value: { ...validDraftBundle, createdAt: "13/11/2026" } },
  { name: "unknown section key", value: { ...validDraftBundle, documents: { ...draftDocuments, sections: [{ key: "invoice", title: "x", lines: [] }] } } },
  { name: "missing billing", value: (() => { const { billing: _b, ...rest } = validDraftBundle; return rest; })() },
];

// ---------------------------------------------------------------- SessionFacts (model output)
export const validSessionFacts: SessionFacts[] = [demoFacts, reviewedFacts, { activities: [], observations: [], goals: [], progress: [], followUps: [], missingInformation: [] }];

export const invalidSessionFacts: InvalidExample[] = [
  { name: "missing missingInformation", value: (() => { const { missingInformation: _m, ...rest } = demoFacts; return rest; })() },
  { name: "bad goal status", value: { ...demoFacts, goals: [{ goalId: "goal_transport", status: "achieved", claims: [] }] } },
  { name: "empty claim id", value: { ...demoFacts, activities: [{ id: "", text: "t", evidenceIds: [], support: "supported" }] } },
  { name: "oversized missingInformation entry", value: { ...demoFacts, missingInformation: [long(2001)] } },
  { name: "too many goals", value: { ...demoFacts, goals: Array.from({ length: 21 }, (_, i) => ({ goalId: `g${i}`, status: "unknown", claims: [] })) } },
  { name: "evidenceIds not array", value: { ...demoFacts, progress: [{ id: "c1", text: "t", evidenceIds: "ev_001", support: "supported" }] } },
];
