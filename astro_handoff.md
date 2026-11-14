VEXO FIELD ASSISTANT
COMPREHENSIVE 20-AGENT EXECUTION PLAN
==================================

DELIVERABLE
Architecture validation, implementation specification, parallel task
assignments, integration schedule, acceptance criteria, and agent prompts
in one document.

PLANNING BASELINE
The supplied “Vexo Field Assistant — Complete Product + Technical
Architecture.”

DOCUMENT STATUS
Implementation plan. Application code, live account access, deployment,
and acceptance tests have not been executed as part of preparing this plan.

TEAM SIZE
20 agents total, including one integration lead.

SPRINT TARGET
A demonstrable administrative-bundle workflow within a 20-minute
implementation window, subject to the readiness conditions below.

The deadline is a target, not a completion guarantee.

CORE PRINCIPLE
AI proposes.
Evidence supports.
Rules validate.
A human approves.


CONTENTS
========

1. Executive decision and feasibility
2. Product definition and demonstration
3. Architecture validation and corrections
4. Scope, priorities, and exclusions
5. Readiness checklist and timer rules
6. Target architecture and repository
7. Team coordination and ownership
8. Shared domain contracts
9. API and integration contracts
10. Persistence, idempotency, and approval
11. Twenty-minute schedule and decision gates
12. Dependency graph and handoffs
13. Detailed assignments for all 20 agents
14. Shared fixture specification
15. Acceptance and failure-test matrix
16. Security and data-handling requirements
17. Integration, build, and deployment runbook
18. Demo script and completion evidence
19. Master orchestrator prompt and handoff templates
20. Risk register and fallback decisions
21. Post-sprint product backlog
22. Final definition of done
23. Reference sources and validation limits


1. EXECUTIVE DECISION AND FEASIBILITY
===================================

The proposed stack is appropriate for the hackathon objective:

TypeScript
+ React/Vite
+ Hono
+ one Cloudflare Worker
+ one Queue
+ one Workflow definition
+ D1
+ one AI model.

Keep that stack.

The principal risks are:

- Integration readiness.
- Account authorization.
- Evidence availability.
- Shared interface drift.
- Approval correctness.
- Insufficient integration and testing time.

Changing languages or adding services does not address those risks.


1.1 WHAT THE 20-MINUTE TARGET MEANS

The target is one bounded end-to-end demonstration:

1. A fictional appointment exists.
2. Evidence is retrieved from a live authorized source or an explicitly
   selected synthetic fixture.
3. Evidence is matched to the appointment.
4. One extraction creates structured facts with provenance.
5. Deterministic code prepares documents, checks, and billing.
6. The provider reviews missing information and confirms duration.
7. The provider approves the displayed revision.
8. The Workflow finalizes the approved bundle once.
9. The completed bundle can be downloaded or printed.

The target does not mean:

- Every component is production-ready.
- Every external integration is live.
- Every possible failure mode has been exhaustively verified.
- Legal or payer compliance has been certified.
- Actual claims or payments can be submitted safely.


1.2 WHY 20 AGENTS DO NOT GUARANTEE COMPLETION IN 20 MINUTES

Twenty agents working for 20 minutes provide at most 400 agent-minutes
of effort before coordination overhead.

They cannot parallelize:

- An OAuth consent interaction.
- An upstream transcript delay.
- Missing account access.
- A deployment outage.
- A dependency that has not been specified.
- A final integration check that requires completed components.

The timing assumes:

- A working starter.
- Installed dependencies.
- Prepared fixtures.
- Configured infrastructure.
- Frozen shared contracts.
- An available test harness.

If those are absent, preparation is additional work.

If the entire effort must fit into 20 minutes from an empty workspace,
the appropriate goal is an integration spike or a smaller fixture
prototype.

Agent deadlines in this plan are delivery cutoffs. Missing a cutoff
changes the declared outcome. It does not justify reporting unfinished
work as complete.


1.3 OUTCOME LABELS

OUTCOME: LIVE DEPLOYED DEMO

Required evidence:
- Real Vexo retrieval.
- Real AI extraction.
- Deployed Cloudflare processing.
- Tested review and approval.
- Finalized export.

Allowed claim:
“The live demonstration completed.”


OUTCOME: MIXED DEPLOYED DEMO

Required evidence:
- Deployed processing and approval work.
- One or more adapters use fixtures.
- Fixture use is clearly disclosed.

Allowed claim:
“The deployed demonstration uses the following fixtures…”


OUTCOME: LOCAL FIXTURE DEMO

Required evidence:
- Synthetic data.
- Local runtime.
- Complete review, approval, and export path.

Allowed claim:
“The local fixture workflow completed.”


OUTCOME: PARTIAL PROTOTYPE

Condition:
- End-to-end acceptance or required infrastructure is incomplete.

Allowed claim:
“These components work; these gates remain open.”


Record three dimensions separately:

1. Evidence mode: live or fixture.
2. Extraction mode: live or fixture.
3. Runtime: local or deployed.

A single “live” badge is insufficient if only one dependency is live.


1.4 AGENT CAPACITY

The assignments assume a runner with 20 concurrent slots.

The chat environment in which this plan was prepared exposed seven
slots, including the primary agent.

A seven-slot execution must use waves or consolidate roles and must
be re-estimated. It cannot honestly be described as 20 agents working
simultaneously.

This document does not launch implementation agents.


2. PRODUCT DEFINITION AND DEMONSTRATION
======================================

2.1 PRODUCT PROMISE

Vexo captures an authorized field interaction.

The application associates evidence with a scheduled service and
prepares the administrative work that normally follows the visit.

The provider does not need to operate the application while delivering
the service.

The application is primarily a review and approval tool after the
session.


2.2 USER AND SERVICE FOR THIS SPRINT

- One authenticated demonstration provider.
- One fictional client reference, such as C-104.
- One scheduled appointment occurrence.
- One demonstration service: independent living skills.
- One plan with three goals.
- One illustrative documentation rule set.
- One rate: USD 75 per hour.
- No payer submission.
- No payment collection.
- No real-client billing.

The example rate and rule set are demonstration inputs. They are not
claims about a real payer or regulated service.


2.3 REQUIRED BUNDLE CONTENTS

SESSION NOTE

Describe supported activities and observations.


PROGRESS RECORD

Separate evidence of progress from an activity merely being discussed.


PLAN COVERAGE

Show supported, partially supported, and unknown goals.


FOLLOW-UPS

Capture supported commitments without executing them.


MISSING-INFORMATION REPORT

Explain absent or uncertain required information.


DOCUMENTATION CHECKS

Apply the versioned demonstration rules deterministically.


TIME SUMMARY

Distinguish:

- Scheduled duration.
- Evidence window.
- Provider-confirmed actual duration.


DRAFT INVOICE

Calculate from the configured rate and confirmed duration.


APPROVAL RECORD

Identify:

- Authenticated approver.
- Approved revision.
- Approval time.
- Idempotency identity.


EXPORT

Match the finalized approved bundle.


2.4 DEMONSTRATION SUCCESS STORY

A 60-minute appointment contains evidence for transportation planning
and budgeting.

Community interaction remains unknown.

A follow-up is captured.

Progress wording needs provider confirmation.

The provider:

1. Supplies the missing confirmation.
2. Changes actual duration to 90 minutes.
3. Saves the changes.
4. Reviews the resulting USD 112.50 amount.
5. Approves that exact revision.

The system:

1. Persists the approval.
2. Resumes processing.
3. Finalizes one bundle.
4. Exports that same approved revision.


3. ARCHITECTURE VALIDATION AND CORRECTIONS
=========================================

3.1 RETAIN THESE DECISIONS

- One language across frontend, backend, and integration code.
- One deployment containing API and static frontend assets.
- One Queue for the administrative processing handoff.
- One Workflow definition, instantiated for each processing revision.
- D1 for application records and durable approval state.
- One normalized facts representation shared by downstream outputs.
- Deterministic documentation checks.
- Deterministic financial calculations.
- Provider confirmation before finalization.
- HTML/JSON exports initially.
- R2 and PDF generation later.


3.2 CORRECTIONS REQUIRED BEFORE CODING

CORRECTION 1: WORKFLOW APPROVAL EVENT SYNTAX

Problem:
The supplied example uses “event” in waitForEvent options.

Required correction:
Use the published “type” property.

Example:
step.waitForEvent("await provider approval", {
  type: "provider-approved",
  timeout: "1 hour"
});

The sendEvent call must use the same type.

Owners:
Agents 14 and 16.


CORRECTION 2: DUPLICATE PREVENTION

Problem:
A unique session row is treated as complete duplicate prevention.

Why insufficient:
Queue messages can repeat.
Workflow steps can retry.
Approval requests can repeat.
Finalization can retry.

Required correction:
Apply stable IDs, conditional writes, and idempotency at every boundary.

Owners:
Agents 04, 09, 14, and 16.


CORRECTION 3: APPOINTMENT MATCHING

Problem:
Calendar timing appears to prove participant identity.

Required correction:
Time overlap identifies candidates. It does not prove who was present.

Return explicit ambiguity and block automatic attribution when more
than one appointment is eligible.

Owner:
Agent 08.


CORRECTION 4: UPSTREAM RESPONSE SHAPES

Problem:
Transcript responses are assumed to have a particular object shape.

Required correction:
Inspect live tool schemas and normalize upstream responses at the
adapter boundary.

Owner:
Agent 07.


CORRECTION 5: DURATION AND BILLING

Problem:
Scheduled duration may appear to be billable duration.

Required correction:
Require provider confirmation.
Label scheduled-time calculations as estimates.
Never silently substitute recorded speech length for actual duration.

Owners:
Agents 13 and 18.


CORRECTION 6: COMPLIANCE TERMINOLOGY

Problem:
Required field presence is called compliance.

Required correction:
Use “documentation checks” in the product.

Field completion alone does not establish legal, clinical, or payer
compliance.

Owners:
Agents 12 and 18.


CORRECTION 7: MODEL CONFIDENCE

Problem:
Confidence values can appear statistically authoritative.

Required correction:
Keep uncertainty explicit.
Do not use a model confidence number as the sole approval gate.

Owners:
Agents 02, 10, and 12.


CORRECTION 8: TRANSCRIPT RETENTION

Problem:
Only database transcript storage is considered.

Required correction:
Also inspect:

- Workflow step results.
- Request traces.
- AI Gateway logs.
- Model request/response logs.
- Caches.
- Export content.

Owners:
Agents 10, 14, and 19.


CORRECTION 9: APPROVAL NOTIFICATION

Problem:
The Workflow event is treated as the only durable approval signal.

Required correction:
Persist approval and delivery intent first.
Reconcile failed notifications.
Treat the notification as a wake-up signal.

Owners:
Agents 04, 09, and 16.


CORRECTION 10: APPROVING A CHANGED AMOUNT

Problem:
The duration could change during approval without an updated review.

Required correction:
Save edits.
Recalculate.
Display the new revision and amount.
Approve that exact revision.

Owners:
Agents 13, 16, and 18.


CORRECTION 11: STATUS VOCABULARY

Problem:
Different sections use different names for similar states.

Required correction:
Adopt the shared state vocabulary in Section 8.

Owners:
Agents 02, 14, and 17.


CORRECTION 12: LATE EVIDENCE AND REPROCESSING

Problem:
A transcript processed once may be treated as final forever.

Required correction:
Preserve processing revisions.
Do not silently mutate approved records when new evidence arrives.

Owners:
Agents 04 and 09.


3.3 DOCUMENTED CAPABILITIES VERSUS UNVERIFIED BEHAVIOR

The published Vexo interface supports the proposed OAuth/MCP evidence
integration.

Still unverified for this project:

- Actual account connection.
- Captured sample quality.
- Speaker coverage.
- Exact timestamp granularity.
- Capture-to-retrieval latency.
- Account-specific deletion behavior.
- Runtime compatibility of the selected MCP library.

Cloudflare documentation supports:

- The selected hosting model.
- Retryable Workflows.
- Approval events.
- At-least-once Queue delivery.
- Transactional D1 batches.

Those capabilities do not automatically make application-level effects
exactly once.


4. SCOPE, PRIORITIES, AND EXCLUSIONS
===================================

4.1 PRIORITY DEFINITIONS

P0 — DEMO CORE

Required for a complete fixture demonstration.
Failure means the demonstration is incomplete.


P1 — LIVE OR DEPLOYED TARGET

Required to claim the corresponding live integration or deployment.

A fixture or local result must disclose its absence.


P2 — FOLLOW-UP

Deliberately outside the 20-minute build.


4.2 SCOPE MATRIX IN PLAIN TEXT

CAPABILITY:
Shared schemas and fixture dataset.

PRIORITY:
P0.

IMPLEMENTATION:
Runtime-validated contracts and one canonical dataset.


CAPABILITY:
Appointment source.

PRIORITY:
P0.

IMPLEMENTATION:
Seeded D1 record. No calendar OAuth.


CAPABILITY:
Evidence adapter interface.

PRIORITY:
P0.

IMPLEMENTATION:
Synthetic adapter always available.


CAPABILITY:
Live Vexo OAuth/MCP.

PRIORITY:
P1.

IMPLEMENTATION:
Prepared account and prior consented mock recording.


CAPABILITY:
Structured extraction.

PRIORITY:
P0 interface; P1 live model.

IMPLEMENTATION:
Live adapter plus explicitly selected fixture extractor.


CAPABILITY:
Matching.

PRIORITY:
P0.

IMPLEMENTATION:
Deterministic time-window and ownership checks, plus ambiguity rejection.


CAPABILITY:
Documents, progress, coverage, follow-ups.

PRIORITY:
P0.

IMPLEMENTATION:
Templates over validated facts.


CAPABILITY:
Required documentation checks.

PRIORITY:
P0.

IMPLEMENTATION:
One versioned rule set.


CAPABILITY:
Duration and billing.

PRIORITY:
P0.

IMPLEMENTATION:
One hourly rate and explicit rounding.


CAPABILITY:
Review and approval.

PRIORITY:
P0.

IMPLEMENTATION:
D1 persistence, revision checks, and idempotent finalization.


CAPABILITY:
Queue and Workflow behavior.

PRIORITY:
P0.

IMPLEMENTATION:
Tested in the available runtime. Disclose local emulation.


CAPABILITY:
Deployed Cloudflare runtime.

PRIORITY:
P1.

IMPLEMENTATION:
Conditional on credentials and release gates.


CAPABILITY:
Automatic discovery handler.

PRIORITY:
P0.

IMPLEMENTATION:
Same discovery function as manual sync.


CAPABILITY:
Actual Cron firing during the sprint.

PRIORITY:
P1 evidence only.

IMPLEMENTATION:
Do not assume schedule propagation completes within the timer.


CAPABILITY:
JSON or printable HTML export.

PRIORITY:
P0.

IMPLEMENTATION:
Approved revision only.


CAPABILITY:
PDF/R2, payments, actual calendar integration.

PRIORITY:
P2.

IMPLEMENTATION:
Deferred.


CAPABILITY:
Sensor or well-being extension.

PRIORITY:
P2.

IMPLEMENTATION:
Requires separately verified API access.


CAPABILITY:
Production security and compliance program.

PRIORITY:
P2.

IMPLEMENTATION:
Required before real sensitive-client deployment.


4.3 EXPLICIT EXCLUSIONS

Do not add:

- Custom audio recording.
- Custom retranscription.
- Vector search.
- Autonomous billing.
- Multiple model vendors.
- A mobile application.
- Multiple microservices.
- Multiple workflow orchestration frameworks.
- A complex rule editor.
- Agency integrations.
- Health diagnosis.
- External follow-up execution.

Follow-up suggestions must not become sent messages or external actions.


5. READINESS CHECKLIST AND TIMER RULES
======================================

5.1 PREPARATION CHECKLIST

[ ] Working repository and known baseline commit.
[ ] Dependencies installed with one package manager and lockfile.
[ ] React/Worker starter builds successfully.
[ ] Local test runner starts successfully.
[ ] Cloudflare account credentials available through the environment.
[ ] D1, Queue, and Workflow bindings can be provisioned or already exist.
[ ] Stable Vexo callback URL available.
[ ] AI credentials and optional Gateway configuration ready.
[ ] Previously captured, consented mock interaction available.
[ ] Synthetic fixtures independent of all external services.
[ ] Application access-control choice established.
[ ] All agents receive the same plan and repository baseline.
[ ] Sufficient concurrency for the selected execution model.


5.2 TIMER RULES

T0 is when implementation agents start against the prepared baseline.

Preparation duration must be reported separately.

If the deadline includes initial setup, preparation must be included
inside the window and scope reduced accordingly.

The timer is not paused for integration failures.

Unready accounts or missing resources change the result category.

Never collect a new recording at T0 and assume it will be retrievable
before the deadline.

Use a prior mock recording for the live target.
Measure new-capture latency separately.


5.3 READINESS REPORT TEMPLATE

Baseline commit:
Build status:
Test-runner status:
Cloudflare resources:
Vexo connection/sample availability:
AI provider availability:
Application access control:
Agent slots:
Selected target:
Preparation time:
Implementation timer starts:


6. TARGET ARCHITECTURE AND REPOSITORY
=====================================

6.1 RUNTIME ARCHITECTURE

Vexo account or fixture evidence
          |
          v
Evidence adapter
          |
          v
Discovery and matching <--- Cron or manual sync
          |
          v
D1 records and pending delivery
          |
          v
One processing Queue
          |
          v
Session Workflow
          |
          v
Structured extraction
          |
          v
Documents + checks + billing
          |
          v
D1 draft bundle
          |
          v
React review interface
          |
          v
Authenticated approval API
          |
          v
D1 approval and notification intent
          |
          v
Recoverable approval notification
          |
          v
Workflow reloads durable approval
          |
          v
Finalize approved revision
          |
          v
D1 final bundle
          |
          v
JSON or printable HTML export


These are application responsibilities, not separate services.

The Worker contains:

- HTTP handlers.
- Scheduled handler.
- Queue handler.
- Exported Workflow class.


6.2 REPOSITORY OWNERSHIP

src/
  index.ts
    Agent 01: composition root only

  contracts/
    Agent 02

  db/
    Agent 04

  calendar/
    Agent 05

  auth/vexo/
    Agent 06

  integrations/vexo/
    Agent 07

  domain/matching/
    Agent 08

  jobs/
    Agent 09

  ai/
    Agent 10

  domain/documents/
    Agent 11

  domain/rules/
    Agent 12

  domain/billing/
    Agent 13

  workflow/
    Agent 14

  api/health.ts
    Agent 15

  api/sessions.ts
    Agent 15

  api/sync.ts
    Agent 15

  api/review.ts
    Agent 16

  services/approval/
    Agent 16

  export/
    Agent 16

  security/
    Agent 19

  ui/App.tsx
    Agent 17

  ui/api.ts
    Agent 17

  ui/pages/Today.tsx
    Agent 17

  ui/styles/
    Agent 17

  ui/pages/Review.tsx
    Agent 18

  ui/components/review/
    Agent 18

migrations/
  Agent 04

fixtures/
  Agent 05

scripts/platform/
  Agent 03

scripts/seed/
  Agent 05, using Agent 04 APIs/schema

tests/integration/
  Agent 20

tests/e2e/
  Agent 20

docs/demo.md
  Agent 20

docs/integration-status.md
  Agent 01

package.json and lockfile
  Agent 03

wrangler.jsonc and Vite configuration
  Agent 03

TypeScript and test-runner configuration
  Agent 03


Each implementation owner may add focused tests beside owned modules.

Agent 20 owns shared integration tests.

Generated files are regenerated through the designated owner rather
than edited by competing agents.


6.3 ENVIRONMENT CONTRACT

Agent 03 freezes binding names before implementation.

DB
Type: D1 binding.
Purpose: Application persistence.

SESSION_QUEUE
Type: Queue binding.
Purpose: Session processing handoff.

SESSION_WORKFLOW
Type: Workflow binding.
Purpose: Create or retrieve processing instances.

ASSETS
Type: Static asset binding, if required by the starter.
Purpose: React assets.

EVIDENCE_MODE
Type: Non-secret configuration.
Values: live or fixture.

EXTRACTION_MODE
Type: Non-secret configuration.
Values: live or fixture.

AI_MODEL
Type: Non-secret configuration.
Purpose: Selected model identifier.

AI_GATEWAY_URL
Type: Optional non-secret configuration.
Purpose: Configured provider routing.

AI_API_KEY
Type: Secret.
Purpose: Server-side model authentication.

TOKEN_ENCRYPTION_KEY
Type: Secret.
Purpose: Protect stored OAuth credentials.

APP_ORIGIN
Type: Non-secret configuration.
Purpose: Origin and callback validation.


Use the installed SDK and starter's supported configuration.

Do not invent:

- Credentials.
- Account IDs.
- Binding IDs.

No secret belongs in frontend bundles or committed configuration.


7. TEAM COORDINATION AND OWNERSHIP
==================================

7.1 OPERATING RULES

1. One file area has one owner.

2. Only Agent 02 changes shared public contracts.

3. Only Agent 03 changes package dependencies and tool configuration.

4. Only Agent 04 changes migrations and repository primitives.

5. Only Agent 01 changes the composition root.

6. Build against public stubs instead of waiting for complete
   implementations.

7. Do not create alternative fixtures or local copies of shared types.

8. Report a blocker after 60 seconds and continue independent work.

9. Do not silently replace failed live requests with fixture data.

10. Stop new feature work at minute 12.

11. Use bounded retries. Do not create loops that can consume the sprint.

12. Preserve evidence of what was actually tested.


7.2 EXECUTION MODEL

Choose one model at T0.


MODEL A: SHARED FILESYSTEM

- Agents edit only their owned paths.
- Only the integrator performs repository-wide Git operations.
- Avoid resets and broad staging.
- Avoid dependency installs by multiple agents.
- Do not clean up another agent's files.


MODEL B: ISOLATED WORKTREES

- All agents branch from the same baseline.
- Hand off small commits.
- Integrator cherry-picks early.
- Contract changes are propagated explicitly.
- Worktree preparation counts as setup unless already available.


Do not accidentally mix models.

A commit visible to one agent does not prove another worktree has it.


7.3 UPDATE CADENCE

Report at:

- Minute 2.
- Minute 5.
- Minute 8.
- Minute 12.
- Minute 16.

Also report immediately when blocked.

Status template:

Agent:
State: implementing / ready / blocked
Owned files:
Exports available:
Checks passed:
Dependency needed:
Blocker and next action:
Expected handoff minute:


7.4 CHANGE REQUESTS

A downstream agent requesting a contract change provides:

- Reason.
- Smallest proposed change.
- Affected consumers.
- Whether work can continue with a stub.

Agent 02 and Agent 01 decide.

After minute 5, prefer adapters inside owned modules over broad schema
changes unless the existing contract is incorrect.


8. SHARED DOMAIN CONTRACTS
==========================

Agent 02 turns this specification into runtime schemas and TypeScript
types.

The following examples define intent. They are not a complete
application implementation.


8.1 IDENTITY, TIME, MONEY, AND VERSIONS

- IDs are opaque strings.
- Never derive authorization from an ID prefix.
- Provider identity comes from authenticated server context.
- Store instants as UTC ISO 8601 values.
- Retain the appointment's IANA timezone.
- Use an explicit occurrence ID for recurring appointments.
- Use integer minutes for confirmed-duration input.
- Use integer cents for USD amounts.
- Never store floating-point dollars as money.
- Freeze the rate, plan, and rule versions used for each bundle.
- Distinguish processing revision from editable bundle revision.
- Preserve the actual semantics of upstream source IDs and pagination.


8.2 MINIMUM TYPES

type SourceMode = "live" | "fixture";
type RuntimeMode = "local" | "deployed";

type SessionStatus =
  | "SCHEDULED"
  | "WAITING_FOR_EVIDENCE"
  | "QUEUED"
  | "PROCESSING"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "COMPLETED"
  | "NO_EVIDENCE"
  | "AMBIGUOUS_MATCH"
  | "INCOMPLETE"
  | "FAILED";

interface Appointment {
  id: string;
  occurrenceId: string;
  providerId: string;
  clientRef: string;
  startAt: string;
  endAt: string;
  timezone: string;
  serviceCode: string;
  planVersion: string;
  ruleVersion: string;
  rateVersion: string;
}

interface EvidenceItem {
  id: string;
  sourceId: string | null;
  sourceMode: SourceMode;
  observedFrom: string | null;
  observedTo: string | null;
  excerpt: string;
  retrievedAt: string;
  citationUrl?: string;
}

interface EvidenceResult {
  items: EvidenceItem[];
  completeness: "complete" | "partial" | "unknown";
  unavailableSourceIds: string[];
  warnings: string[];
}

interface FactClaim {
  id: string;
  text: string;
  evidenceIds: string[];
  support: "supported" | "uncertain" | "provider_confirmed";
  providerAttestationId?: string;
}

interface GoalFact {
  goalId: string;
  status: "addressed" | "partially_addressed" | "unknown";
  claims: FactClaim[];
}

interface SessionFacts {
  activities: FactClaim[];
  observations: FactClaim[];
  goals: GoalFact[];
  progress: FactClaim[];
  followUps: FactClaim[];
  missingInformation: string[];
}

interface DocumentationIssue {
  code: string;
  field: string;
  message: string;
  blocking: boolean;
}

interface DocumentationChecks {
  ruleVersion: string;
  issues: DocumentationIssue[];
  canApprove: boolean;
}

interface BillingDraft {
  currency: "USD";
  hourlyRateCents: number;
  scheduledMinutes: number;
  confirmedMinutes: number | null;
  amountCents: number | null;
  estimateAmountCents: number | null;
  isEstimate: boolean;
  rateVersion: string;
}

interface BundleProvenance {
  evidenceMode: SourceMode;
  extractionMode: SourceMode;
  schemaVersion: string;
  promptVersion: string;
  model: string | null;
}

interface ApprovalRequest {
  expectedRevision: number;
  idempotencyKey: string;
}

interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  correlationId: string;
}


Agent 02 must additionally define:

- SessionBundle.
- Documents.
- ReviewEdits.
- ApprovalRecord.
- RateRule.
- MatchResult.
- Route envelopes.

A SessionBundle includes:

- Session ID.
- Bundle revision.
- Processing revision.
- Facts.
- Documents.
- Checks.
- Billing.
- Provenance.

ReviewEdits is an allowlisted shape, not an arbitrary JSON patch.


8.3 EVIDENCE RULES

1. A supported AI claim must reference evidence present in the normalized
   evidence set.

2. An unknown source reference is an extraction validation failure.

3. A valid reference is necessary but does not prove the interpretation
   is correct. The review interface must expose relevant excerpts.

4. Missing timestamp precision remains missing.

5. Do not invent seconds, speakers, or evidence boundaries.

6. “Discussed a goal” and “achieved a goal” are different claims.

7. Provider additions are attestations with actor and time.

8. Provider additions must not be rewritten as transcript-derived facts.

9. Partial retrieval is visible.

10. Required evidence gaps block approval according to the rule set.

11. Lack of recorded speech does not establish absence of service.


8.4 STATE TRANSITIONS

Normal path:

SCHEDULED
  -> WAITING_FOR_EVIDENCE
  -> QUEUED
  -> PROCESSING
  -> NEEDS_REVIEW
  -> APPROVED
  -> COMPLETED

Other paths:

WAITING_FOR_EVIDENCE
  -> NO_EVIDENCE
  -> WAITING_FOR_EVIDENCE

PROCESSING
  -> AMBIGUOUS_MATCH

PROCESSING
  -> INCOMPLETE

PROCESSING
  -> FAILED


NO_EVIDENCE:
Retryable within the configured lookback policy.

An upstream outage is a failure, not proof of no evidence.

AMBIGUOUS_MATCH:
Requires intervention.
Cannot be approved through the ordinary sprint flow.

NEEDS_REVIEW:
May include editable missing requirements.

INCOMPLETE:
A safe reviewable bundle could not be prepared because extraction or
evidence validation failed.

APPROVED:
The approved revision is immutable.

A later amendment requires a separate revision workflow outside the
initial sprint scope.


9. API AND INTEGRATION CONTRACTS
================================

9.1 MODULE SIGNATURES

retrieveEvidence(appointment):
  Promise<EvidenceResult>

matchEvidence(appointment, evidence, competingAppointments):
  MatchResult

extractFacts(appointment, matchedEvidence):
  Promise<SessionFacts>

generateDocuments(appointment, facts):
  Documents

validateRequirements(appointment, bundle, providerEdits):
  DocumentationChecks

calculateBilling(rateRule, scheduledMinutes, confirmedMinutes):
  BillingDraft

saveDraft(sessionId, expectedRevision, bundle):
  Promise<SessionBundle>

saveReview(actor, sessionId, expectedRevision, edits):
  Promise<SessionBundle>

approveSession(actor, sessionId, request):
  Promise<ApprovalRecord>

discoverSessions(now):
  Promise<DiscoverySummary>

dispatchPendingDeliveries(now):
  Promise<DispatchSummary>


Pass dependencies explicitly or through one agreed service context.

Pure domain functions must not query the database or call external
services.


9.2 HTTP ENDPOINTS

GET /api/health
Owner: Agent 15.
Returns safe readiness metadata.
No secrets or personal data.

GET /api/sessions
Owner: Agent 15.
Returns the authenticated provider's sessions.
Use bounded pagination.

GET /api/sessions/:id
Owner: Agent 15.
Returns the current bundle, revision, status, and mode metadata.

POST /api/sync
Owner: Agent 15.
Invokes shared discovery/dispatch.
Returns 202 and a safe summary.

PATCH /api/sessions/:id/review
Owner: Agent 16.
Validates allowed edits and expectedRevision.
Returns a recalculated bundle.

POST /api/sessions/:id/approve
Owner: Agent 16.
Approves the exact revision using an idempotency key.

GET /api/sessions/:id/export
Owner: Agent 16.
Returns finalized approved JSON or printable HTML.

GET /auth/vexo
Owner: Agent 06.
Begins the authorized connection flow.

GET /auth/vexo/callback
Owner: Agent 06.
Validates the callback and persists protected credentials.


9.3 EXAMPLE REVIEW REQUEST

{
  "expectedRevision": 2,
  "edits": {
    "confirmedMinutes": 90,
    "progressConfirmation":
      "The participant completed the planning task with verbal prompts."
  }
}

The response contains:

- Revision 3.
- Recalculated amount: 11250 cents.
- Updated documentation checks.
- Updated documents.
- Provider-attestation provenance.

The interface displays that response before approval.


9.4 EXAMPLE APPROVAL REQUEST

{
  "expectedRevision": 3,
  "idempotencyKey": "demo-session-approval-request-001"
}

The server derives the approver from authenticated context.

It ignores or rejects a client-supplied provider ID.


9.5 HTTP ERRORS

400
Malformed request.

401
Missing or invalid application authentication.

403
Forbidden operation or rejected request origin.

404
Session absent or not visible to the current provider.

409
Stale revision, incompatible state, or conflicting idempotency reuse.

422
Invalid allowed input or unresolved documentation blockers.

429
Application rate limit.

503
Dependency temporarily unavailable.


Return 202 when durable approval exists but finalization is pending.

A repeated matching approval request may return the existing result.

It must not create another approval or invoice.


9.6 QUEUE PAYLOAD

{
  "schemaVersion": "1",
  "sessionId": "sess_demo_001",
  "processingRevision": 1
}

The consumer loads ownership and appointment details from trusted
persistence.

Queue messages must not contain:

- Full transcripts.
- Credentials.
- Browser-provided authoritative rates.
- Browser-provided ownership assertions.


9.7 APPROVAL NOTIFICATION

{
  "type": "provider-approved",
  "payload": {
    "approvalId": "approval_demo_001",
    "sessionId": "sess_demo_001",
    "bundleRevision": 3
  }
}

The notification is a wake-up hint.

The Workflow loads the durable approval and validates the revision
before finalizing.


9.8 WORKFLOW EVENT API

Conceptual usage:

const event = await step.waitForEvent("await provider approval", {
  type: "provider-approved",
  timeout: "1 hour"
});

await instance.sendEvent({
  type: "provider-approved",
  payload: {
    approvalId,
    sessionId,
    bundleRevision
  }
});


Agent 14 must verify exact:

- Imports.
- Generics.
- Return shapes.
- Timeout behavior.
- SDK compatibility.

A timeout never grants approval.

Explicitly test:

- Notification before waiting.
- Notification during wait registration.
- Duplicate notification.
- Delayed notification.


10. PERSISTENCE, IDEMPOTENCY, AND APPROVAL
=========================================

10.1 MINIMUM LOGICAL TABLES

PROVIDERS

Fields:
- ID.
- Application identity mapping.


APPOINTMENTS

Fields:
- Occurrence ID.
- Provider ID.
- Start/end times.
- Timezone.
- Client reference.
- Versioned configuration references.


SERVICE_CONFIGS

Fields:
- Versioned plan.
- Versioned documentation rules.
- Versioned rate snapshot.


SESSIONS

Fields:
- Stable ID.
- Appointment occurrence.
- Provider.
- Status.
- Processing revision.
- Workflow ID.
- Current bundle revision.


EVIDENCE

Fields:
- Session association.
- Necessary excerpt.
- Source reference.
- Observed times.
- Retrieval provenance.


BUNDLES

Fields:
- Session ID.
- Revision.
- Facts snapshot.
- Documents snapshot.
- Checks snapshot.
- Billing snapshot.
- Provenance snapshot.

Constraint:
Unique session_id + revision.


APPROVALS

Fields:
- Approved revision.
- Authenticated actor.
- Timestamp.
- Request key.
- Request fingerprint.

Constraints:
- Approved-revision uniqueness.
- Consistent idempotency semantics.


OAUTH_CONNECTIONS

Fields:
- Provider/account mapping.
- Encrypted tokens.
- Expiry metadata.


PENDING_DELIVERIES

Fields:
- Unique delivery key.
- Operation type.
- Reference payload.
- Attempts.
- Next retry.
- Completion status.


Logical tables may be consolidated where appropriate.

Preserve:

- Uniqueness.
- Ownership.
- Revision semantics.
- Durable delivery intent.

Do not add an ORM or a second database merely for this sprint.


10.2 IDENTIFIER RULES

Session identity:
Provider + immutable appointment occurrence.

Workflow identity:
Session identity + processing revision.

Bundle identity:
Session identity + bundle revision.

Approval identity:
Session identity + approved bundle revision.

Delivery identity:
Operation type + target identity/revision.


Do not use only a service date as an occurrence key.

Rescheduling an appointment must not accidentally create a second
billable occurrence.


10.3 IDEMPOTENCY BOUNDARIES

BOUNDARY:
Repeated discovery.

PROTECTION:
Unique logical session occurrence.


BOUNDARY:
Database write followed by Queue send.

PROTECTION:
Durable pending-delivery intent.


BOUNDARY:
Queue delivered twice.

PROTECTION:
Same deterministic Workflow instance ID.


BOUNDARY:
Workflow step retried.

PROTECTION:
Idempotent draft and final writes.


BOUNDARY:
Review saved from stale tab.

PROTECTION:
Conditional update by expected revision.


BOUNDARY:
Approval button clicked twice.

PROTECTION:
Stable request key and approved-revision uniqueness.


BOUNDARY:
Approval key reused with different content.

PROTECTION:
Reject as conflict.


BOUNDARY:
Approval persisted but event send failed.

PROTECTION:
Durable notification intent and reconciliation.


BOUNDARY:
Finalization retried.

PROTECTION:
Conditional transition and unique final record.


10.4 ATOMICITY REQUIREMENT

D1 transactional batches can group related SQL operations.

Agent 04 must design conditional SQL and inspect operation results.

A transaction alone does not make a stale revision update valid.

For a multi-write approval operation:

- Guard all dependent writes consistently.
- Or abort when the required precondition fails.

Do not assume a generic ORM-style transaction callback is supported.

Use actual D1 capabilities and test the chosen approach.


10.5 APPROVAL PROTOCOL

1. Authenticate and authorize the provider.

2. Load the current session and immutable configuration versions.

3. Save allowlisted provider edits using expected bundle revision.

4. Rebuild documents, checks, and billing.

5. Return the new revision.

6. Display that exact revision and amount to the provider.

7. Receive approval for the displayed revision.

8. Reject:
   - Unresolved blocking issues.
   - Missing confirmed duration.
   - Stale revision.
   - Inaccessible session.
   - Conflicting idempotency reuse.

9. Atomically:
   - Persist approval.
   - Transition state.
   - Record notification intent.

10. Attempt notification.

11. Retain recoverable intent if delivery fails.

12. Workflow reloads persisted approval and approved bundle.

13. Finalize exactly that revision using an idempotent write.

14. Mark the session completed.

15. Make the finalized export available.


Do not make the notification payload the sole source of truth.

Do not accept edits after approval in this sprint.


10.6 NOTIFICATION RECOVERY AND RACE HANDLING

Agent 09 reconciles pending notifications until:

- The session reaches a terminal outcome.
- Or a configured retry limit requires intervention.

A successful send is not proof that business finalization occurred.

Agent 14 checks durable approval:

- Before waiting.
- After relevant wake-ups.
- After relevant timeouts.

Use fresh reads where required.

Do not rely forever on a memoized pre-approval read.

Use distinct Workflow step identities when the design needs a new
durable read.

The implementation must handle approval arriving around the wait
boundary without silently waiting forever.

If the behavior cannot be verified within the sprint, mark the gate
incomplete and do not claim reliable approval recovery.


10.7 BILLING RULE

Demo currency:
USD.

Hourly rate:
7500 cents.

Calculation:
amountCents =
  round_half_up(hourlyRateCents × confirmedMinutes / 60)


Validate:

- Nonnegative configured rate.
- Positive whole confirmed minutes.
- Finite numeric input.
- Declared maximum duration.
- Arithmetic within safe integer bounds.

Included:
One hourly rate.

Excluded:
- Taxes.
- Discounts.
- Payer units.
- Eligibility inference.
- Payment submission.


Before confirmation:

- Optionally show an estimate based on scheduled minutes.
- Label it as an estimate.
- Keep amountCents null.
- Keep confirmedMinutes null.

Evidence-window duration is informational only.

It must not silently replace provider-confirmed duration.


11. TWENTY-MINUTE SCHEDULE AND DECISION GATES
============================================

MINUTES 0–2

Activities:
- Publish contracts.
- Publish stubs.
- Confirm ownership.
- Establish compiling baseline.

Exit gate:
- Importable modules exist.
- Baseline build passes.


MINUTES 2–5

Activities:
- Implement independently.
- Publish shared fixtures.
- Probe live dependencies.

Exit gate:
- Shared fixtures ready.
- Live blockers known.


MINUTES 5–8

Activities:
- Connect repositories.
- Connect adapters.
- Complete pure domain logic.
- Build fixture UI.

Exit gate:
- Core module checks pass.
- Evidence and extraction modes selected.


MINUTES 8–12

Activities:
- Wire Queue and Workflow.
- Mount HTTP routes.
- Connect review interface.
- Integrate approval and export.

Exit gate:
- First complete fixture session reaches COMPLETED.


MINUTES 12–16

Activities:
- Freeze features.
- Run integration tests.
- Run failure tests.
- Apply targeted fixes.

Exit gate:
- Release-blocking checks pass or are reported accurately.


MINUTES 16–18

Activities:
- Build.
- Deploy if ready.
- Run deployed smoke test.

Exit gate:
- Deployment verified.
- Or local-only status declared.


MINUTES 18–20

Activities:
- Rehearse demonstration.
- Execute demonstration.
- Record outcome.

Exit gate:
- Accurate completion report.
- Demo evidence.


11.1 HARD DECISIONS

M3:
If cloud resources are unavailable, select local fixture execution as
the baseline.

M5:
If Vexo authorization is unresolved, remove it from the core demo's
critical path.

M8:
Freeze evidence and extraction modes.

A later live success may be reported separately. Do not destabilize
the demonstration.

M12:
Stop adding features.

The first end-to-end pass must happen now, not at minute 18.

M16:
Failures in access control, revision integrity, money, or duplicate
finalization block completion claims.

M18:
Stop deployment troubleshooting if it threatens the demonstration.
Use a verified local result.

M20:
Report passed, failed, and unrun gates exactly.


11.2 COORDINATION BUDGET

Agent 01 should spend most time composing working exports and resolving
boundaries.

Do not allocate Agent 01 a large feature implementation.

Agent 20 starts the harness early instead of waiting for the complete
product.


12. DEPENDENCIES AND HANDOFFS
=============================

12.1 DEPENDENCY MAP

02 Contracts
  -> 04 Database
  -> 05 Fixtures
  -> 06 OAuth
  -> all other consumers

06 OAuth
  -> 07 Evidence adapter

05 Fixtures
  -> 07 Evidence adapter
  -> 08 Matching
  -> 10 Extraction
  -> 11 Documents
  -> 12 Rules
  -> 13 Billing
  -> 17 Dashboard
  -> 18 Review UI
  -> 20 QA

07 Evidence adapter
  -> 08 Matching
  -> 10 Extraction
  -> 14 Workflow

08 Matching
  -> 10 Extraction
  -> 14 Workflow

10 Extraction
  -> 11 Documents
  -> 12 Rules
  -> 14 Workflow

11 Documents
12 Rules
13 Billing
  -> 14 Workflow
  -> 16 Review and approval API

04 Database
  -> 09 Jobs
  -> 14 Workflow
  -> 15 Read API
  -> 16 Review and approval API

14 Workflow
  -> 09 Queue dispatch/consumer integration
  -> 01 Integration

15 Read API
  -> 17 Dashboard

16 Review and approval API
  -> 18 Review UI

19 Security
  -> 06 OAuth helpers
  -> 15 Read API
  -> 16 Review and approval API

03 Platform
17 Dashboard
18 Review UI
  -> 01 Integration

01 Integrated application
  -> 20 QA


These are interface dependencies.

They do not require waiting for the complete upstream implementation.

Use frozen stubs and fixtures.


12.2 MANDATORY EARLY HANDOFFS

FROM:
Agent 02.

TO:
Everyone.

ARTIFACT:
Types, runtime schemas, states, and signatures.

DEADLINE:
M2.


FROM:
Agent 03.

TO:
Agents 01, 04, 14, 20.

ARTIFACT:
Runtime configuration and binding names.

DEADLINE:
M2.


FROM:
Agent 04.

TO:
Agents 05, 09, 14, 15, 16.

ARTIFACT:
Repository interfaces.

DEADLINE:
M2.


FROM:
Agent 05.

TO:
Agents 07, 08, 10–13, 17, 18, 20.

ARTIFACT:
Canonical fixtures.

DEADLINE:
M3.


FROM:
Agent 19.

TO:
Agents 06, 15, 16.

ARTIFACT:
Actor context and security helper interfaces.

DEADLINE:
M3.


FROM:
Agent 06.

TO:
Agent 07.

ARTIFACT:
Token-provider interface and live status.

DEADLINE:
M5.


FROM:
Agent 07.

TO:
Agents 08, 10, 14.

ARTIFACT:
Normalized evidence.

DEADLINE:
M4 fixture; M8 live decision.


FROM:
Agents 11, 12, 13.

TO:
Agents 14, 16.

ARTIFACT:
Pure business functions.

DEADLINE:
M7.


FROM:
Agent 15.

TO:
Agent 17.

ARTIFACT:
Working list/detail endpoints.

DEADLINE:
M7.


FROM:
Agent 16.

TO:
Agents 18, 14.

ARTIFACT:
Review and approval lifecycle.

DEADLINE:
M8–M10.


FROM:
Agent 01.

TO:
Agent 20.

ARTIFACT:
Integrated application.

DEADLINE:
M12.


13. DETAILED ASSIGNMENTS FOR ALL 20 AGENTS
=========================================

All checkboxes below represent planned work, not completed work.

Every agent must read:

- Scope.
- Ownership.
- Shared contracts.
- API contracts.
- Persistence and approval.
- Its own assignment.


AGENT 01 — INTEGRATION LEAD AND RELEASE COORDINATOR
-------------------------------------------------

GOAL

Produce one connected, testable application and an accurate outcome
report.


OWNS

- src/index.ts
- docs/integration-status.md
- Integration decisions.
- Release candidate selection.


INPUTS

- Shared contracts.
- Module exports.
- Baseline build.
- Release gates.


TASK CHECKLIST

[ ] Confirm the execution model, all 20 assignments, and file ownership
    at T0.

[ ] Create the composition root using published stubs.

[ ] Mount API routes and middleware.

[ ] Wire fetch, scheduled, and queue handlers.

[ ] Export the Workflow entrypoint.

[ ] Keep the integrated application compiling as modules arrive.

[ ] Track blockers, mode selection, and gate results.

[ ] Resolve contract disagreements with Agent 02.

[ ] Integrate a fixture path before trying to improve the live path.

[ ] Freeze features at M12.

[ ] Assign failed gates to their owners.

[ ] Make the deployment decision with Agents 03, 19, and 20.

[ ] Report what completed, what was mocked, what failed, and what remains.


DO NOT

- Become the sole author of missing business modules.
- Rewrite every contributor's files.
- Wait until the end to merge.


ACCEPTANCE

Composing the supplied modules produces a full session-to-export path.

Integration status matches observed test evidence.


CHECKPOINTS

M2: Compiling skeleton.
M8: Main wiring.
M12: End-to-end path.
M18: Release decision.
M20: Final report.


COPY-PASTE ASSIGNMENT

You are Agent 01, the integration lead. Own only the composition root
and integration-status document. Keep the application compiling from
minute 2. Use this plan's contracts and module owners. Integrate
continuously; enforce the M5/M8 mode decisions and M12 feature freeze.
Assign fixes to owners. Do not claim completion without Agent 20's
evidence and Agent 19's access checks. Deliver the integrated application
and an honest live/fixture/local outcome.


AGENT 02 — SHARED CONTRACTS AND RUNTIME SCHEMAS
----------------------------------------------

GOAL

Make independent implementations compatible without repeated
negotiation.


OWNS

- src/contracts/
- Public schema changes.


INPUTS

- Sections 8–10.
- Endpoint specification.


TASK CHECKLIST

[ ] Define all required record types.

[ ] Include bundle, documents, review edits, approval, rate, and match types.

[ ] Implement runtime validation using the starter's existing dependency.

[ ] Freeze module signatures.

[ ] Freeze error envelopes.

[ ] Freeze state names and configuration names.

[ ] Define the provider-edit allowlist.

[ ] Define approval request validation.

[ ] Define Queue and approval notification payloads.

[ ] Define evidence references and provider-attestation provenance.

[ ] Define duration bounds, ID limits, and bounded array/text inputs.

[ ] Publish valid and invalid example payloads to Agent 05.

[ ] Review consumer requests for compatible changes.

[ ] Reject duplicate local versions of shared contracts.


DO NOT

Implement persistence, business rules, OAuth, or frontend screens.


ACCEPTANCE

- Consumers import one contract package.
- Invalid approval/edit payloads fail validation.
- Fixture schemas match API schemas.


CHECKPOINTS

M2: Schema freeze.
M5: Consumer compatibility pass.
M8 onward: Corrective changes only.


COPY-PASTE ASSIGNMENT

You are Agent 02. Own src/contracts only. Publish runtime schemas and
TypeScript contracts by minute 2 using Sections 8–10. Include bundles,
documents, review edits, approval, errors, modes, Queue payloads, and
statuses. Coordinate changes through Agent 01. Prefer a small complete
contract to speculative abstractions. Deliver importable types,
validators, examples, and a schema version.


AGENT 03 — CLOUDFLARE PLATFORM, DEPENDENCIES, AND BUILD
-----------------------------------------------------

GOAL

Give the team a functioning runtime and a repeatable release path.


OWNS

- Package and lockfiles.
- Wrangler configuration.
- Vite configuration.
- TypeScript configuration.
- Test-runner configuration.
- scripts/platform/


INPUTS

- Prepared credentials and resources.
- Chosen starter.
- Environment contract.


TASK CHECKLIST

[ ] Verify baseline installation, build, and local Worker startup.

[ ] Pin the dependency set.

[ ] Avoid broad version upgrades during the sprint.

[ ] Configure D1.

[ ] Configure Queue producer and consumer.

[ ] Configure the Workflow class binding.

[ ] Configure frontend assets.

[ ] Ensure /api/* and /auth/* reach the Worker.

[ ] Configure the scheduled trigger and document its intended cadence.

[ ] Define standard build, test, migration, seed, and development scripts.

[ ] Configure secret references without committing values.

[ ] Verify selected packages work in the runtime.

[ ] Capture the known-good deployment or baseline identifier.

[ ] Deploy only the candidate that passed the agreed gates.

[ ] Run a deployed smoke test.


DO NOT

- Install every dependency requested independently.
- Expose secrets in commands or output.
- Treat successful deployment as proof the application works.


ACCEPTANCE

One documented command sequence builds and starts the application.

Bindings resolve.

Deployment status reflects actual checks.


CHECKPOINTS

M2: Configuration contracts.
M3: Health response.
M6: Stable build configuration.
M18: Deployment or local decision.


COPY-PASTE ASSIGNMENT

You are Agent 03. Own platform configuration, package files, and build
scripts. Verify the baseline immediately. Configure one Worker, one
Queue, one Workflow, D1, and React assets using actual installed APIs.
Protect secret values. Supply binding names and commands by minute 2.
Release only after gates pass. If cloud access fails, preserve a tested
local path and state that clearly.


AGENT 04 — D1 SCHEMA AND PERSISTENCE
-----------------------------------

GOAL

Preserve sessions, revisions, approvals, and delivery intent correctly
under retries.


OWNS

- migrations/
- src/db/


INPUTS

- Persistence specification.
- Agent 02 schemas.
- D1 binding from Agent 03.


TASK CHECKLIST

[ ] Publish repository signatures by M2.

[ ] Implement minimum schema and uniqueness constraints.

[ ] Use prepared statements for dynamic input.

[ ] Implement provider-scoped session queries.

[ ] Implement versioned bundle reads.

[ ] Implement idempotent session creation.

[ ] Implement idempotent draft persistence.

[ ] Guard review writes by expected revision and allowed state.

[ ] Persist approval and notification intent atomically.

[ ] Apply consistent preconditions across approval writes.

[ ] Implement idempotent finalization.

[ ] Implement approval lookup.

[ ] Implement pending-delivery claim/update helpers.

[ ] Validate duplicate insertion behavior.

[ ] Validate stale write behavior.

[ ] Validate transaction failure behavior.


DO NOT

- Add a second database.
- Own domain calculations.
- Store unencrypted OAuth tokens.
- Assume a transaction alone enforces revision correctness.


ACCEPTANCE

Repeated operations do not create duplicate logical records.

Failed revision checks cannot leave partial approval state.


CHECKPOINTS

M2: Stubs.
M6: Repositories.
M10: Race and retry validation.


COPY-PASTE ASSIGNMENT

You are Agent 04. Own migrations and src/db. Implement Section 10 with
actual D1 primitives. Publish repository signatures by minute 2.
Prioritize scoped queries, revision checks, idempotent finalization,
and atomic approval plus delivery intent. Test duplicate/stale writes
and partial-failure behavior. Coordinate schema needs with owners rather
than editing their modules.


AGENT 05 — APPOINTMENTS, SEED DATA, AND CANONICAL FIXTURES
--------------------------------------------------------

GOAL

Give every agent the same deterministic scenario without live-service
dependencies.


OWNS

- src/calendar/
- fixtures/
- scripts/seed/


INPUTS

- Agent 02 schemas.
- Agent 04 repository interfaces.
- Section 14 fixture specification.


TASK CHECKLIST

[ ] Define one fictional provider.

[ ] Define one fictional client reference.

[ ] Define one appointment occurrence.

[ ] Define one three-goal plan.

[ ] Define one documentation rule set.

[ ] Define one hourly rate.

[ ] Create a deterministic synthetic transcript with stable references.

[ ] Produce fixture facts using the same IDs.

[ ] Produce expected bundle components.

[ ] Create missing-evidence, ambiguous, bad-citation, and malformed-output
    variants.

[ ] Include an explicit timezone and fixed clock.

[ ] Supply a repeatable seed routine.

[ ] Keep seed/reset functions away from ordinary public routes.

[ ] Publish expected amounts and required-field outcomes.

[ ] Validate fixtures against runtime schemas.

[ ] Mark all fixture content as synthetic.


DO NOT

- Build a calendar integration.
- Edit SQL migrations.
- Create separate incompatible frontend fixtures.


ACCEPTANCE

All consumers can use the same dataset.

Repeated seeding does not duplicate the appointment.


CHECKPOINTS

M3: Fixtures.
M5: Seed routine.
M8: Fixture/schema mismatch resolution.


COPY-PASTE ASSIGNMENT

You are Agent 05. Own the calendar adapter, shared fixtures, and seed
scripts. Implement Section 14 so backend, frontend, and QA share IDs,
timestamps, goals, rules, and expected amounts. Use synthetic people and
an injectable clock. Publish valid fixture objects by minute 3. Do not
add an external calendar dependency or a public data-reset endpoint.


AGENT 06 — VEXO OAUTH CONNECTION AND TOKEN LIFECYCLE
--------------------------------------------------

GOAL

Supply authorized server-side access without making consent availability
a dependency of the entire demo.


OWNS

- src/auth/vexo/


INPUTS

- Upstream authentication metadata.
- Protected storage from Agent 04.
- Security helpers from Agent 19.


TASK CHECKLIST

[ ] Publish getAccessToken(providerId).

[ ] Publish a safe connection-status interface.

[ ] Discover upstream authentication configuration.

[ ] Implement the required registration/authorization path supported by
    the selected client.

[ ] Generate and verify PKCE.

[ ] Bind one-time authorization state to the current application user.

[ ] Validate callback issuer.

[ ] Validate redirect handling.

[ ] Handle expiry and callback errors.

[ ] Persist tokens using the agreed encryption helper.

[ ] Never send tokens to the frontend.

[ ] Implement bounded refresh and reconnect behavior.

[ ] Prevent a callback from overwriting another provider's connection.

[ ] Report live proof or the exact blocker by M5.

[ ] Provide revoked/expired-token test cases.


DO NOT

- Implement application login here.
- Fabricate tokens.
- Label fixture evidence as connected Vexo.


ACCEPTANCE

An authorized connection yields a server-side token.

Invalid state or issuer is rejected.

Connection errors are actionable and redacted.


CHECKPOINTS

M2: Stub.
M5: Live decision.
M8: Bounded implementation.


COPY-PASTE ASSIGNMENT

You are Agent 06. Own Vexo OAuth and server-side token lifecycle only.
Use live metadata and the provider account's explicit connection.
Implement state, PKCE, issuer checks, protected persistence, and
refresh/reconnect behavior. Publish the token-provider interface
immediately. Report proof or a blocker by minute 5. Do not block the
fixture path or expose tokens in logs or browser responses.


AGENT 07 — VEXO MCP EVIDENCE RETRIEVAL AND NORMALIZATION
------------------------------------------------------

GOAL

Present trustworthy, bounded evidence retrieval through one stable
adapter.


OWNS

- src/integrations/vexo/


INPUTS

- Agent 06 token provider.
- Agent 02 schemas.
- Agent 05 fixtures.


TASK CHECKLIST

[ ] Implement the same interface for live and fixture evidence.

[ ] Inspect live tool schemas before assuming response shapes.

[ ] Retrieve relevant transcript days.

[ ] Follow required pages with explicit page/time bounds.

[ ] Preserve upstream references.

[ ] Preserve timestamps when available.

[ ] Preserve retrieval provenance.

[ ] Normalize partial and unavailable results honestly.

[ ] Distinguish no data from authentication, transport, or tool errors.

[ ] Apply bounded backoff.

[ ] Respect upstream rate-limit information.

[ ] Retrieve only relevant appointment context.

[ ] Do not invent missing speakers or temporal precision.

[ ] Publish a sanitized sample shape.

[ ] Publish live integration status.


DO NOT

- Match clients using names alone.
- Store full-day transcripts for convenience.
- Silently switch to fixtures after live failure.


ACCEPTANCE

Pagination and partial-result checks pass.

Every excerpt has honest provenance.

Live availability is demonstrated or explicitly unverified.


CHECKPOINTS

M4: Fixture adapter.
M8: Live decision and normalization checks.


COPY-PASTE ASSIGNMENT

You are Agent 07. Own the evidence adapter. Implement explicit live and
fixture modes using one contract. Verify live schemas, bound pagination,
preserve source references, and distinguish partial evidence from no
evidence and errors. Coordinate token use with Agent 06. Deliver fixture
retrieval by minute 4 and a live proof or precise blocker by minute 8.
Never fabricate source metadata.


AGENT 08 — APPOINTMENT AND EVIDENCE MATCHING
-------------------------------------------

GOAL

Associate evidence conservatively and expose ambiguity.


OWNS

- src/domain/matching/


INPUTS

- Appointment.
- Competing appointments.
- Normalized evidence.
- Configured time-window buffer.


TASK CHECKLIST

[ ] Implement a pure matching function.

[ ] Filter by the authenticated provider's appointment context.

[ ] Compare UTC intervals.

[ ] Preserve appointment timezone for transcript-day selection.

[ ] Define one configurable buffer.

[ ] Document that the buffer is a heuristic.

[ ] Detect evidence eligible for overlapping appointments.

[ ] Return matched, ambiguous, or no-evidence outcomes.

[ ] Include reasons for each outcome.

[ ] Preserve partial-coverage warnings.

[ ] Avoid treating names mentioned in conversation as identity proof.

[ ] Add midnight boundary cases.

[ ] Add buffer-edge cases.

[ ] Supply deterministic outputs to Workflow and QA.


DO NOT

- Add an LLM identity resolver.
- Auto-resolve ambiguity merely to make the demo succeed.


ACCEPTANCE

A unique eligible window matches.

Overlapping candidates block automatic processing.

Cross-midnight appointments consider the correct evidence range.


CHECKPOINTS

M2: Signature.
M7: Implementation and focused checks.


COPY-PASTE ASSIGNMENT

You are Agent 08. Own the pure session matcher. Time overlap is a
candidate signal, not identity proof. Handle provider scope, buffers,
overlapping visits, partial evidence, and midnight boundaries. Return
explicit outcomes and reasons. Use shared fixtures and complete focused
checks by minute 7. Do not use an LLM to guess which client was present.


AGENT 09 — DISCOVERY, SYNC, QUEUE, AND DELIVERY RECOVERY
------------------------------------------------------

GOAL

Start and resume processing reliably without requiring provider
interaction during a visit.


OWNS

- src/jobs/


INPUTS

- Appointment repository.
- Evidence and matching contracts.
- Pending deliveries.
- Workflow binding.


TASK CHECKLIST

[ ] Share one discovery function between manual and scheduled execution.

[ ] Discover completed eligible appointments using an injected clock.

[ ] Apply a bounded lookback for late evidence.

[ ] Avoid duplicate logical sessions.

[ ] Save processing intent before Queue delivery.

[ ] Validate Queue payloads.

[ ] Derive deterministic Workflow IDs.

[ ] Handle existing Workflow instances as an idempotency case.

[ ] Acknowledge only after durable start/existence is established.

[ ] Retry actual failures.

[ ] Dispatch pending approval notifications.

[ ] Reconcile approved sessions that have not finalized.

[ ] Bound retry attempts.

[ ] Make exhausted work visible for recovery.

[ ] Exclude canceled appointments and already-completed revisions from
    ordinary discovery.


DO NOT

- Add multiple pipeline Queues.
- Hide failed work.
- Treat Queue acknowledgement as proof of Workflow completion.


ACCEPTANCE

Repeated discovery and delivery do not create duplicates.

Pending sends recover after injected failure.


CHECKPOINTS

M3: Function stubs.
M8: Handlers.
M11: Duplicate and recovery checks.


COPY-PASTE ASSIGNMENT

You are Agent 09. Own scheduled/manual discovery, Queue consumption, and
pending-delivery reconciliation. Use stable occurrence and processing
revision IDs. Coordinate repositories with Agent 04 and Workflow
creation with Agent 14. Handle repeated messages and database-to-network
failure gaps. Deliver handlers by minute 8 and recovery evidence by
minute 11. Keep one processing Queue.


AGENT 10 — STRUCTURED AI EXTRACTION
-----------------------------------

GOAL

Convert relevant evidence into validated facts without inventing
missing information.


OWNS

- src/ai/


INPUTS

- Matched evidence.
- Appointment and plan context.
- Model configuration.
- Shared schemas.


TASK CHECKLIST

[ ] Implement one live extractor.

[ ] Implement one explicitly selected fixture extractor.

[ ] Use a narrow structured-output prompt.

[ ] Use the configured model.

[ ] Treat evidence as untrusted content rather than instructions.

[ ] Include only relevant excerpts and necessary plan context.

[ ] Parse and validate every returned field.

[ ] Reject unknown evidence references.

[ ] Reject unsupported goal identifiers.

[ ] Preserve unknowns rather than filling gaps with plausible prose.

[ ] Use bounded timeouts and retries.

[ ] Reject persistent invalid output.

[ ] Record prompt/model/schema versions.

[ ] Avoid sensitive prompt/response logging.

[ ] Test malformed JSON.

[ ] Test invalid citations.

[ ] Test missing progress.

[ ] Test instructions embedded in transcript text.


DO NOT

- Calculate money.
- Decide billing eligibility.
- Send messages.
- Allow model output to invoke tools.


ACCEPTANCE

Supported claims reference actual input evidence.

Malformed or unsupported outputs cannot become ordinary complete
bundles.


CHECKPOINTS

M3: Stub and fixture shape.
M8: Live adapter or declared fixture mode.


COPY-PASTE ASSIGNMENT

You are Agent 10. Own structured extraction. Use one configured model
and shared schemas; keep fixture mode explicit. Validate JSON, goal IDs,
and evidence IDs. Treat transcript instructions as data. Unknown
information must remain unknown. Do not calculate billing or perform
external actions. Deliver validated facts and failure-case results by
minute 8, with model and prompt version metadata.


AGENT 11 — ADMINISTRATIVE DOCUMENT GENERATION
--------------------------------------------

GOAL

Produce consistent records from the same facts without another model
dependency.


OWNS

- src/domain/documents/


INPUTS

- Appointment.
- Plan snapshot.
- Normalized facts.
- Provider attestations.


TASK CHECKLIST

[ ] Build deterministic service and activity sections.

[ ] Build observation and participant-response sections.

[ ] Build progress and follow-up sections.

[ ] Render goal progress separately from goal coverage.

[ ] Represent unsupported goals as unknown.

[ ] Preserve references from narrative statements to facts/evidence.

[ ] Include relevant missing-information notices.

[ ] Include relevant partial-retrieval notices.

[ ] Distinguish provider additions from extracted content.

[ ] Keep templates compact enough for review and export.

[ ] Escape content at rendering boundaries.

[ ] Support recalculation after permitted edits.

[ ] Validate normal and missing-progress fixtures.


DO NOT

- Add another LLM call for cosmetic prose.
- Make clinical conclusions absent from the facts.
- Treat model text as trusted HTML.


ACCEPTANCE

All required sections render.

Unknowns survive rendering.

Generated text introduces no new factual claims.


CHECKPOINTS

M2: Signatures.
M7: Templates and checks.


COPY-PASTE ASSIGNMENT

You are Agent 11. Own deterministic document templates over normalized
facts. Generate session notes, progress, plan coverage, follow-ups, and
missing information. Preserve evidence and provider-attestation
provenance and unknowns. Avoid new AI calls and unsupported claims.
Use shared fixtures and deliver pure functions plus representative
output checks by minute 7.


AGENT 12 — REQUIRED DOCUMENTATION RULES
--------------------------------------

GOAL

Determine whether the demo bundle contains required supported
information.


OWNS

- src/domain/rules/


INPUTS

- Versioned service rules.
- Facts.
- Documents.
- Duration confirmation.
- Provider edits.


TASK CHECKLIST

[ ] Implement deterministic checks for configured required fields.

[ ] Reject empty strings as completed documentation.

[ ] Reject placeholder text as meaningful content.

[ ] Reject unsupported claims as evidence of completion.

[ ] Require confirmed duration for approval.

[ ] Check source or attestation support where required.

[ ] Distinguish blocking issues from informational unknown goals.

[ ] Return stable issue codes.

[ ] Return affected fields and plain-language remedies.

[ ] Re-run rules after edits.

[ ] Preserve the frozen rule version.

[ ] Derive canApprove from actual blockers.

[ ] Test missing progress and duration.

[ ] Test valid provider attestation.

[ ] Test unsupported extraction.


DO NOT

- Claim legal, clinical, payer, or HIPAA certification.
- Ask an LLM to declare the bundle compliant.


ACCEPTANCE

Required unresolved facts block approval.

Optional unknown coverage does not become an invented requirement.


CHECKPOINTS

M2: Interface.
M7: Rules and checks.


COPY-PASTE ASSIGNMENT

You are Agent 12. Own deterministic required-documentation checks for
one versioned service rule set. Check meaningful supported content,
confirmed duration, and provider attestations. Return blocking and
nonblocking issues with actionable messages. Do not claim regulatory
compliance. Deliver pure functions and missing-field cases by minute 7.


AGENT 13 — TIME AND BILLING CALCULATIONS
---------------------------------------

GOAL

Produce explainable, repeatable amounts based on confirmed time.


OWNS

- src/domain/billing/


INPUTS

- Scheduled times.
- Evidence window.
- Confirmed minutes.
- Rate version.


TASK CHECKLIST

[ ] Keep scheduled, observed, and confirmed time separate.

[ ] Validate positive whole confirmed minutes.

[ ] Enforce the declared duration maximum.

[ ] Calculate integer cents.

[ ] Apply explicit rounding.

[ ] Return an estimate before confirmation.

[ ] Return a confirmed draft amount afterward.

[ ] Use the frozen rate version.

[ ] Reject browser-supplied authoritative rates or amounts.

[ ] Reject NaN, Infinity, negatives, zero duration, and out-of-range values.

[ ] Verify 60 minutes produces 7500 cents.

[ ] Verify 90 minutes produces 11250 cents.

[ ] Test a rounding boundary with a rate not divisible evenly by 60.

[ ] Support recalculation after duration changes.

[ ] Return a transparent rate/time breakdown.


DO NOT

- Infer billing eligibility.
- Calculate actual duration from speech-window length.
- Submit charges.


ACCEPTANCE

Calculations are deterministic.

Unconfirmed duration cannot produce an approved final amount.

Invalid numeric input fails.


CHECKPOINTS

M2: Signature.
M7: Implementation and boundary checks.


COPY-PASTE ASSIGNMENT

You are Agent 13. Own pure time and billing functions. Separate
schedule, evidence window, and confirmed time. Use integer cents and
explicit rounding. Freeze the configured rate; never trust a
browser-supplied amount. Cover normal, rounding, and invalid-duration
cases. Deliver the calculation contract and passing focused checks
by minute 7. No payments or eligibility inference.


AGENT 14 — DURABLE SESSION WORKFLOW
-----------------------------------

GOAL

Connect processing steps to human approval with durable, retry-safe
behavior.


OWNS

- src/workflow/


INPUTS

- Domain functions.
- Evidence and extraction adapters.
- Repository functions.
- Workflow binding conventions.


TASK CHECKLIST

[ ] Publish the Workflow class and payload contract early.

[ ] Load authoritative appointment data.

[ ] Load versioned configuration.

[ ] Retrieve and match evidence.

[ ] Stop safely on absent or ambiguous input.

[ ] Extract facts.

[ ] Generate documents.

[ ] Check requirements.

[ ] Prepare billing.

[ ] Persist a reviewable draft before waiting.

[ ] Use durable steps for side effects.

[ ] Use idempotent writes.

[ ] Avoid persisting full-day transcripts as step results.

[ ] Use the correct approval event type.

[ ] Configure explicit approval timeout.

[ ] Reload durable approval.

[ ] Handle notification races.

[ ] Finalize the approved revision once.

[ ] Expose safe failure status.

[ ] Leave timed-out sessions unapproved.


DO NOT

- Approve automatically on timeout.
- Repeat side effects without protection.
- Trust event payloads over durable approval state.


ACCEPTANCE

The Workflow reaches review, waits, resumes from a valid persisted
approval, and finalizes once.

Retry and timeout behavior is explicit.


CHECKPOINTS

M3: Skeleton.
M10: Connected lifecycle.
M12: Integration race test.


COPY-PASTE ASSIGNMENT

You are Agent 14. Own the SessionWorkflow. Compose agreed functions
into durable steps and preserve idempotency. Save the draft, wait using
the correct event type, reload durable approval, and finalize only
the approved revision. Handle timeout and event-before-wait races
without automatic approval. Publish a skeleton by minute 3 and a
connected lifecycle by minute 10.


AGENT 15 — SESSION READ API, HEALTH, AND MANUAL SYNC
--------------------------------------------------

GOAL

Give the dashboard a stable, authorized interface.


OWNS

- src/api/health.ts
- src/api/sessions.ts
- src/api/sync.ts


INPUTS

- Shared DTOs.
- Repository interfaces.
- Discovery function.
- Authentication middleware.


TASK CHECKLIST

[ ] Implement safe health/readiness response.

[ ] Exclude credential details.

[ ] Implement bounded provider-scoped listing.

[ ] Implement session detail.

[ ] Include current revision.

[ ] Include safe evidence excerpts.

[ ] Expose evidence/extraction modes.

[ ] Expose processing and error states.

[ ] Implement manual sync using the shared job function.

[ ] Authenticate state-changing requests.

[ ] Apply origin protection.

[ ] Use shared errors and correlation IDs.

[ ] Return 404 for inaccessible sessions.

[ ] Avoid full transcript and internal exception payloads.

[ ] Supply examples to Agent 17.

[ ] Supply relevant test cases to Agent 20.


DO NOT

- Implement a second discovery algorithm in the route.
- Expose a general-purpose database viewer.


ACCEPTANCE

Authorized fixture list, detail, and sync work.

Ownership checks reject inaccessible records.

Responses match shared schemas.


CHECKPOINTS

M3: Route stubs.
M7: Fixture endpoints.
M10: Integrated behavior.


COPY-PASTE ASSIGNMENT

You are Agent 15. Own health, session list/detail, and manual-sync
routes. Use shared repository and job functions, provider-scoped
access, safe errors, and mode metadata. Return stable contracts to
Agent 17. Never expose tokens, full transcripts, or another provider's
data. Deliver fixture-backed endpoints by minute 7 and integrated
handlers by minute 10.


AGENT 16 — REVIEW EDITS, APPROVAL SERVICE, AND EXPORT
---------------------------------------------------

GOAL

Ensure the provider approves exactly the displayed and validated
record.


OWNS

- src/api/review.ts
- src/services/approval/
- src/export/


INPUTS

- Repository operations.
- Document functions.
- Rules functions.
- Billing functions.
- Authenticated actor context.


TASK CHECKLIST

[ ] Validate allowlisted edits.

[ ] Validate expected bundle revision.

[ ] Persist provider additions as attestations.

[ ] Include actor and time provenance.

[ ] Recompute documents after edits.

[ ] Recompute checks after edits.

[ ] Recompute billing after edits.

[ ] Return the updated bundle revision.

[ ] Validate exact revision during approval.

[ ] Reject unresolved blockers.

[ ] Require an idempotency key.

[ ] Reject conflicting key reuse.

[ ] Persist approval and notification intent atomically.

[ ] Return accepted/pending without claiming completion.

[ ] Coordinate notification recovery with Agent 09.

[ ] Coordinate durable approval reads with Agent 14.

[ ] Export finalized content only.

[ ] Include revision and mode metadata in export.

[ ] Test stale tabs, repeated approval, inaccessible sessions, and
    post-approval edits.


DO NOT

- Accept client-calculated billing.
- Mutate approved bundles.
- Mark complete merely because an event was sent.


ACCEPTANCE

Save, recalculate, review, and approve are revision-safe.

Export equals the approved snapshot.

Retries do not duplicate effects.


CHECKPOINTS

M3: Interface.
M8: Review route.
M10: Approval and export.


COPY-PASTE ASSIGNMENT

You are Agent 16. Own review edits, approval, and approved export.
Enforce save, recalculate, display, and approve-exact-revision behavior.
Use authenticated actor context, idempotency, atomic approval/delivery
intent, and immutable final records. Coordinate recovery with Agents
04, 09, and 14. Deliver by minute 10 with stale-revision and
duplicate-approval checks.


AGENT 17 — DASHBOARD, APPLICATION SHELL, AND API CLIENT
------------------------------------------------------

GOAL

Show what needs review and make processing status understandable.


OWNS

- src/ui/App.tsx
- src/ui/api.ts
- src/ui/pages/Today.tsx
- src/ui/styles/


INPUTS

- Shared DTOs.
- Fixture responses.
- Agent 15 endpoints.
- Agent 18 review component.


TASK CHECKLIST

[ ] Build application shell.

[ ] Build session list.

[ ] Add review navigation.

[ ] Implement one typed API client.

[ ] Use consistent error handling.

[ ] Show scheduled, waiting, processing, review, approved, completed,
    and failure states.

[ ] Show evidence and extraction mode labels.

[ ] Add manual sync.

[ ] Show loading, success, and actionable error feedback.

[ ] Use bounded polling while work is active.

[ ] Stop unnecessary polling afterward.

[ ] Handle empty lists.

[ ] Handle backend unavailability.

[ ] Preserve keyboard access.

[ ] Use readable contrast and narrow-screen layout.

[ ] Integrate Agent 18's review screen without editing its files.

[ ] Remove hardcoded fixture rendering after API integration.


DO NOT

- Hide backend failure behind a fake success state.
- Build unrelated administration screens.


ACCEPTANCE

The list reflects actual API state.

Navigation works.

Modes and failures are visible.

The interface recovers after polling errors.


CHECKPOINTS

M6: Fixture interface.
M10: API integration.


COPY-PASTE ASSIGNMENT

You are Agent 17. Own the app shell, Today page, API client, and shared
styles. Build against shared fixtures first, then connect Agent 15's
endpoints. Show processing/error states and evidence/extraction modes
honestly. Support manual sync, bounded polling, and accessible
navigation. Leave the review screen to Agent 18. Deliver fixture UI
by minute 6 and connected UI by minute 10.


AGENT 18 — REVIEW, CORRECTION, AND APPROVAL INTERFACE
---------------------------------------------------

GOAL

Let the provider verify evidence, correct missing information, and
approve the displayed revision.


OWNS

- src/ui/pages/Review.tsx
- src/ui/components/review/


INPUTS

- Shared bundle DTOs.
- Agent 17 API client.
- Agent 16 endpoints.


TASK CHECKLIST

[ ] Render session note.

[ ] Render progress and plan coverage.

[ ] Render follow-ups.

[ ] Render evidence references and excerpts.

[ ] Distinguish unknown goals from failed required checks.

[ ] Display scheduled time separately.

[ ] Display evidence window separately.

[ ] Display confirmed duration separately.

[ ] Provide allowlisted correction inputs.

[ ] Use accessible labels.

[ ] Save edits before approval.

[ ] Show returned recalculated amount and revision.

[ ] Disable approval while edits remain unsaved.

[ ] Approve only the currently displayed revision.

[ ] Surface server-side blockers.

[ ] Handle stale revision by refreshing and re-reviewing.

[ ] Do not silently overwrite conflicts.

[ ] Show pending finalization separately from completion.

[ ] Enable export after completion.

[ ] Preserve mode labels.


DO NOT

- Compute authoritative billing locally.
- Pretend a prefilled duration is a provider attestation.
- Mark completed optimistically.


ACCEPTANCE

A user can:

1. Correct progress.
2. Change duration from 60 to 90 minutes.
3. Save.
4. See USD 112.50.
5. Approve that revision.
6. Export after completion.


CHECKPOINTS

M7: Fixture review.
M11: Connected approval flow.


COPY-PASTE ASSIGNMENT

You are Agent 18. Own the review screen. Show evidence, documents,
goal coverage, missing information, distinct time fields, and billing.
Save edits before approval, display the server-recalculated revision,
and handle conflicts and pending finalization. Never mark success
optimistically. Use Agent 17's API client. Deliver fixture review by
minute 7 and full interaction by minute 11.


AGENT 19 — APPLICATION ACCESS AND SENSITIVE-DATA HANDLING
--------------------------------------------------------

GOAL

Prevent credential exposure and unauthorized approval.


OWNS

- src/security/
- Security findings supplied to Agent 01.


INPUTS

- Existing access mechanism.
- Deployment origin.
- Secrets.
- Provider mapping.


TASK CHECKLIST

[ ] Define authenticated actor context.

[ ] Define provider mapping.

[ ] Reuse a prepared access gateway or secure server session.

[ ] Do not create public login bypasses.

[ ] Enforce session ownership.

[ ] Apply origin and CSRF controls.

[ ] Provide token encryption and decryption helpers.

[ ] Use platform cryptography.

[ ] Provide structured redacted logging.

[ ] Review browser bundles for secrets.

[ ] Review API responses for full transcripts.

[ ] Review Gateway request logging/caching.

[ ] Review Workflow result retention.

[ ] Review export HTML escaping with owners.

[ ] Run unauthorized-access checks.

[ ] Document remaining limits before release.


DO NOT

- Claim production compliance.
- Treat Vexo authorization as application authentication.
- Use real sensitive data to compensate for an unprotected demo.


ACCEPTANCE

Unauthenticated and wrong-provider access fail.

Secrets remain server-side.

Unprotected deployments are not used for sensitive evidence.


CHECKPOINTS

M3: Helper interfaces.
M8: Access checks.
M12: Findings.
M16: Release gate.


COPY-PASTE ASSIGNMENT

You are Agent 19. Own shared access and privacy helpers. Provide
authenticated provider context, ownership checks, origin protection,
token encryption, and redacted logging. Reuse prepared application
authentication. If unavailable, require a local synthetic-only outcome.
Review frontend, API, Gateway, and Workflow data surfaces. Report
blockers before release without claiming production compliance.


AGENT 20 — INTEGRATION QA, RELEASE EVIDENCE, AND DEMO
---------------------------------------------------

GOAL

Verify connected behavior and make the final claim match observed
results.


OWNS

- tests/integration/
- tests/e2e/
- docs/demo.md


INPUTS

- Acceptance matrix.
- Canonical fixtures.
- Integrated application.


TASK CHECKLIST

[ ] Start the harness before full integration is available.

[ ] Build a normal-path test using shared contracts and fixtures.

[ ] Test missing evidence.

[ ] Test partial evidence.

[ ] Test invalid extraction.

[ ] Test ambiguous matching.

[ ] Test repeated discovery and Queue delivery.

[ ] Test repeated approval.

[ ] Test stale revisions.

[ ] Test notification recovery.

[ ] Test approval/wait timing.

[ ] Test unauthorized and wrong-provider access.

[ ] Test unsafe export content.

[ ] Verify billing results.

[ ] Verify confirmed-duration requirements.

[ ] Run deployed smoke checks only if deployment exists.

[ ] Create a repeatable demo script.

[ ] Record evidence, extraction, and runtime modes.

[ ] Publish pass, fail, and not-run results accurately.


DO NOT

- Rewrite business modules instead of assigning fixes to owners.
- Run large unrelated suites after relevant checks pass.
- Convert unrun checks into passes.


ACCEPTANCE

Every mandatory scenario has an observed or explicitly unverified
result.

The demonstration reproduces the approved revision.

Unverified integrations are accurately declared.


CHECKPOINTS

M5: Harness.
M12: First end-to-end result.
M16: Gate report.
M19: Demo runbook.


COPY-PASTE ASSIGNMENT

You are Agent 20. Own integration/e2e checks and the demo runbook.
Start early using canonical fixtures. Execute Section 15, prioritizing
approval integrity, ownership, billing, duplicate effects, and recovery.
Send failures to owners. Record pass/fail/not-run and actual modes.
Deliver a gate report by minute 16 and a reproducible demo by minute 19.
Never certify behavior you did not test.


14. SHARED FIXTURE SPECIFICATION
================================

14.1 FIXTURE IDENTITY AND CLOCK

Use a fixed test date independent of the execution machine's date.

Example:

{
  "fixtureVersion": "1",
  "clockNow": "2026-11-13T20:00:00Z",
  "providerId": "provider_demo_001",
  "clientRef": "C-104",
  "appointmentId": "appointment_demo_001",
  "occurrenceId": "occurrence_demo_001",
  "startAt": "2026-11-13T18:00:00Z",
  "endAt": "2026-11-13T19:00:00Z",
  "timezone": "America/Los_Angeles",
  "serviceCode": "DEMO-ILS",
  "planVersion": "plan_demo_v1",
  "ruleVersion": "rules_demo_v1",
  "rateVersion": "rate_demo_v1",
  "hourlyRateCents": 7500,
  "currency": "USD"
}

These timestamps represent a 10:00–11:00 AM Los Angeles appointment
on that date.

They are test data, not a real visit.

The injected clock makes the appointment completed regardless of the
host clock.


14.2 PLAN

GOAL:
goal_transport.

OBJECTIVE:
Practice transportation planning.

EXPECTED COVERAGE:
Addressed.


GOAL:
goal_budget.

OBJECTIVE:
Practice budgeting.

EXPECTED COVERAGE:
Addressed or partially addressed according to the fixture wording.


GOAL:
goal_community.

OBJECTIVE:
Practice community interaction.

EXPECTED COVERAGE:
Unknown.


Do not require all goals to be addressed unless the demonstration
rule explicitly says so.

Unknown optional coverage must remain visible without automatically
blocking every approval.


14.3 SYNTHETIC EVIDENCE

The synthetic transcript establishes activities and a follow-up while
leaving progress confirmation incomplete.

Example:

10:05 Provider:
Today we will practice planning the bus route to the library.

10:12 Participant:
I found the route and the transfer stop on this map.

10:25 Provider:
We also reviewed the weekly food budget together.

10:47 Provider:
I will bring another route-planning worksheet next time.

10:52 Provider:
We are finishing the practice for today.


Assign stable synthetic source and evidence IDs.

Label them as fixtures.

This text does not establish:

- That community interaction occurred.
- That the participant independently mastered the goals.
- That the service duration equals the recorded speech window.


14.4 RULE SET

Required for approval in the demo:

- Service date.
- Provider identity.
- Client reference.
- Supported service description.
- At least one supported goal addressed.
- Supported progress statement or permitted provider confirmation.
- Confirmed actual duration.

Required-field decisions belong to Agent 12.

Empty strings and literal “unknown” do not satisfy required progress.

Provider confirmation may satisfy the demonstration rule only when
recorded explicitly as an attestation.


14.5 EXPECTED AMOUNTS AND STATES

SCENARIO:
Schedule 60 minutes, no confirmation.

EXPECTED:
Estimate 7500 cents.
Final amount null.
Approval blocked.


SCENARIO:
Confirm 60 minutes.

EXPECTED:
Draft amount 7500 cents.


SCENARIO:
Confirm 90 minutes.

EXPECTED:
Draft amount 11250 cents.


SCENARIO:
Required progress missing.

EXPECTED:
Blocking issue remains.


SCENARIO:
Confirm permitted progress and 90 minutes.

EXPECTED:
No remaining fixture blockers.
Current revision can be approved.


SCENARIO:
Approve current revision.

EXPECTED:
Approval persisted.
Finalization may initially be pending.


SCENARIO:
Workflow finalizes.

EXPECTED:
COMPLETED.
Export reflects the approved revision.


14.6 FIXTURE VARIANTS

normal
- Evidence and planned missing progress.
- Review flow works.

no-evidence
- Successful retrieval with an empty result.
- Retryable waiting/no-evidence state.

upstream-error
- Retrieval rejects.
- Failure surfaced rather than “no evidence.”

partial-evidence
- Requested sources or pages unavailable.
- Coverage warning visible.
- Relevant blockers apply.

ambiguous
- A second eligible appointment overlaps.
- Automatic processing stops.

bad-citation
- Extracted claim references absent evidence.
- Extraction rejected or marked incomplete.

malformed-extraction
- Invalid JSON or schema.
- No normal draft created from invalid content.

instruction-in-transcript
- Transcript asks system to change billing or ignore rules.
- Text remains data.
- No authorization, rate, or rule changes.

stale-review
- Two clients load the same revision.
- First edit succeeds.
- Stale mutation conflicts.

queue-duplicate
- Same message delivered twice.
- One logical processing revision.

approval-delivery-failure
- Approval persists.
- Notification fails once.
- Durable retry completes the approved revision.

wrong-provider
- Another authenticated provider requests the session.
- Access denied.

midnight
- Appointment crosses local midnight.
- Correct day range and matching window.


15. ACCEPTANCE AND FAILURE-TEST MATRIX
======================================

15.1 TEST PRIORITIES

RELEASE BLOCKER

Failure prevents claiming a complete demo and may prevent deployment.


LIVE GATE

Required to claim that the named external integration works.


FOLLOW-UP

Useful hardening outside the fixed sprint.

Record as not run if omitted.


Agent 20 selects a compact automated suite and manual checks where
appropriate.

Test meaningful outcomes, race boundaries, money, and access invariants.

Do not spend the sprint writing tests that merely repeat implementation
statements.


15.2 CORE ACCEPTANCE MATRIX

QA-01 — BUILD AND TYPECHECK

Expected:
Shared contracts compile and the production bundle builds.

Owners:
02, 03, 01.

Gate:
Release blocker.


QA-02 — SEED TWICE

Expected:
One logical appointment and session.

Owners:
04, 05.

Gate:
Release blocker.


QA-03 — NORMAL PROCESSING

Expected:
Note, progress, coverage, checks, and invoice reach review.

Owners:
10–15.

Gate:
Release blocker.


QA-04 — MISSING GOAL EVIDENCE

Expected:
Goal remains unknown. No invented completion.

Owners:
10–12.

Gate:
Release blocker.


QA-05 — MISSING REQUIRED PROGRESS

Expected:
Approval rejected until permitted confirmation.

Owners:
12, 16, 18.

Gate:
Release blocker.


QA-06 — UNCONFIRMED DURATION

Expected:
Estimate only. Approval blocked.

Owners:
13, 16.

Gate:
Release blocker.


QA-07 — 60- AND 90-MINUTE BILLING

Expected:
7500 cents and 11250 cents.

Owner:
13.

Gate:
Release blocker.


QA-08 — ROUNDING AND INVALID NUMERIC INPUT

Expected:
Declared rounding policy applied.
Invalid values rejected.

Owner:
13.

Gate:
Release blocker.


QA-09 — REVIEW UPDATE

Expected:
New revision returned with recalculated amount.

Owners:
04, 16, 18.

Gate:
Release blocker.


QA-10 — STALE EDIT OR APPROVAL

Expected:
409 conflict.
Latest record remains unchanged.

Owners:
04, 16.

Gate:
Release blocker.


QA-11 — DUPLICATE QUEUE DELIVERY

Expected:
Same Workflow identity.
No duplicate final effect.

Owners:
09, 14, 04.

Gate:
Release blocker.


QA-12 — DUPLICATE APPROVAL

Expected:
Existing approval/result reused safely.

Owners:
16, 04.

Gate:
Release blocker.


QA-13 — IDEMPOTENCY KEY CONFLICT

Expected:
Different content with reused key rejected.

Owners:
16, 04.

Gate:
Release blocker.


QA-14 — NOTIFICATION FAILURE AFTER APPROVAL SAVE

Expected:
Durable intent survives.
Retry completes the approved revision.

Owners:
09, 14, 16.

Gate:
Release blocker.


QA-15 — APPROVAL AROUND WAIT REGISTRATION

Expected:
No lost approval.
Eventual finalization or visible recoverable failure.

Owners:
14, 09.

Gate:
Release blocker.


QA-16 — APPROVAL WAIT TIMEOUT

Expected:
No automatic approval or finalization.

Owner:
14.

Gate:
Release blocker.


QA-17 — FINALIZATION RETRY

Expected:
One approved final record.

Owners:
04, 14.

Gate:
Release blocker.


QA-18 — UNAUTHENTICATED REQUEST

Expected:
Protected reads and mutations rejected.

Owners:
19, 15, 16.

Gate:
Release blocker.


QA-19 — WRONG-PROVIDER ACCESS

Expected:
Rejected without leaking session content.

Owners:
19, 04, 15, 16.

Gate:
Release blocker.


QA-20 — FORGED PROVIDER OR AMOUNT

Expected:
Rejected or ignored.
Server identity and configured rate remain authoritative.

Owners:
16, 19.

Gate:
Release blocker.


QA-21 — CROSS-ORIGIN STATE CHANGE

Expected:
Rejected according to origin/session policy.

Owner:
19.

Gate:
Release blocker.


QA-22 — AMBIGUOUS MATCH

Expected:
No automatic attribution or finalization.

Owners:
08, 14.

Gate:
Release blocker.


QA-23 — NO EVIDENCE VERSUS UPSTREAM FAILURE

Expected:
Distinct safe states.
Neither fabricates facts.

Owners:
07, 09, 14.

Gate:
Release blocker.


QA-24 — INVALID EXTRACTION OR CITATION

Expected:
Incomplete/error state.
No approvable fabricated bundle.

Owners:
10, 14.

Gate:
Release blocker.


QA-25 — TRANSCRIPT INJECTION

Expected:
Cannot change billing, rules, authorization, or execute external actions.

Owners:
10, 12, 13.

Gate:
Release blocker.


QA-26 — EXPORT CONSISTENCY

Expected:
Export equals approved revision and modes.

Owner:
16.

Gate:
Release blocker.


QA-27 — HTML OR SCRIPT CONTENT

Expected:
Rendered as text.
No script execution.

Owners:
11, 16, 18.

Gate:
Release blocker.


QA-28 — BROWSER AND LOG INSPECTION

Expected:
No secrets or unnecessary full transcript.

Owners:
06, 07, 10, 19.

Gate:
Release blocker.


QA-29 — FIXTURE LABELING

Expected:
UI and export disclose synthetic adapters.

Owners:
15–18.

Gate:
Release blocker.


QA-30 — TIMEZONE AND MIDNIGHT

Expected:
Correct evidence days and intervals.

Owners:
07, 08.

Gate:
Release blocker.


QA-31 — LIVE OAUTH AND REFRESH

Expected:
Authorized account connected.
Invalid state rejected.

Owner:
06.

Gate:
Live gate.


QA-32 — LIVE MCP RETRIEVAL

Expected:
Actual authorized evidence normalized, including pagination.

Owner:
07.

Gate:
Live gate.


QA-33 — LIVE MODEL RESPONSE

Expected:
Actual validated structured output.

Owner:
10.

Gate:
Live gate.


QA-34 — DEPLOYED SMOKE FLOW

Expected:
Assets, API, Queue, Workflow, D1, and approval work remotely.

Owners:
03, 20.

Gate:
Deployment gate.


QA-35 — SCHEDULED HANDLER INVOCATION

Expected:
Shared discovery works when the scheduled handler is invoked.

Owners:
09, 03.

Gate:
Release blocker.


QA-36 — REAL CRON OBSERVATION

Expected:
Actual remote trigger observed.

Owners:
03, 09.

Gate:
Live automation evidence.


This is a comprehensive list.

The fixed time window does not guarantee every test will run.

Unrun release-blocking checks must remain explicitly unverified.

Reusing a prepared harness is what makes a short sprint plausible.


15.3 FAILURE INJECTION

- Fail Queue send once after the database write.
- Fail approval event delivery once after approval persistence.
- Deliver the same message twice.
- Send the same approval request twice.
- Pause finalization and retry it.
- Issue two mutations against the same revision.
- Supply malformed, partial, and adversarial fixtures.
- Use an injected clock for timeouts and boundary tests.

Keep test-only hooks outside public routes.

Do not add:

- Public force-approval endpoints.
- Public reset-all-data endpoints.


15.4 TEST RESULT RECORD

Test ID:
Commit/build:
Runtime:
Evidence mode:
Extraction mode:
Observed result: pass / fail / not run
Evidence:
Owner for repair:
Material limitation:


16. SECURITY AND DATA-HANDLING REQUIREMENTS
===========================================

These requirements apply directly to sensitive evidence and approval.

They are not a substitute for production review.


16.1 AUTHENTICATION AND AUTHORIZATION

- Vexo authorization grants upstream access.
- It does not authenticate users of this application.
- Reuse a prepared access gateway or secure server session.
- Derive provider identity server-side.
- Scope every record lookup.
- Protect edit, sync, approval, and connection routes.
- Apply origin/CSRF controls appropriate to the session mechanism.
- Never place reusable admin secrets in React code or local storage.
- If application authentication is unavailable, keep the demo local
  and synthetic-only.


16.2 OAUTH CREDENTIALS

- Store static credentials through platform secrets.
- Encrypt user OAuth tokens at rest.
- Bind authorization state to the initiating application identity.
- Make state one-time and time-limited.
- Reject invalid issuer and callback state.
- Reject unsafe redirect targets.
- Keep credentials out of URLs.
- Keep credentials out of responses.
- Keep credentials out of logs.
- Keep credentials out of exports and screenshots.


16.3 EVIDENCE MINIMIZATION

- Retrieve only the context needed for the scheduled service.
- Persist necessary excerpts and provenance.
- Do not store whole-day transcripts by default.
- Inspect Workflow step results.
- Inspect request traces.
- Inspect caches and model gateway logs.
- Avoid sensitive prompt/response logging without an explicit policy.
- Treat upstream deletion/revocation as a dependency limitation.
- Copied downstream excerpts do not disappear automatically.
- Use synthetic data and consented mock recordings for the demo.


16.4 PROMPT AND RENDERING BOUNDARIES

- Transcript text is untrusted input.
- The model cannot change rates.
- The model cannot change approval state.
- The model cannot change identity.
- The model cannot change application rules.
- Validate structured outputs.
- Validate evidence references.
- Escape narrative text in HTML and UI rendering.
- Do not render model output as trusted raw HTML.
- Do not execute suggested follow-ups as tools or messages.


16.5 APPROVAL AND AUDIT SEMANTICS

- Record authenticated actor.
- Record approved revision.
- Record time.
- Record stable request identity.
- Preserve provider-edit provenance.
- Reproduce exports from the approved snapshot.
- Reject post-approval edits in this sprint.

Production follow-up must address:

- Amendments.
- Deletion.
- Retention.
- Access auditing.
- Incident response.
- Legal agreements.


17. INTEGRATION, BUILD, AND DEPLOYMENT RUNBOOK
=============================================

17.1 STANDARD SCRIPTS TO ESTABLISH

Agent 03 defines these scripts in the actual repository.

They are target interfaces, not a claim that the scripts already exist.

npm run dev
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run db:migrate:local
npm run db:seed:local
npm run deploy

If the prepared starter uses another package manager, keep it and
document equivalent commands.

Do not introduce multiple lockfiles.


17.2 INTEGRATION SEQUENCE

1. Integrate contracts, environment types, and stubs.

2. Integrate schema, repositories, and canonical seed data.

3. Verify pure matching, documents, rules, and billing.

4. Integrate fixture evidence and fixture extraction.

5. Create the Workflow and reach a persisted review draft.

6. Mount read APIs and connect the dashboard.

7. Mount review/approval APIs and connect review UI.

8. Verify approval finalization and export.

9. Wire Queue, discovery, and recovery.

10. Exercise duplicate and failure paths.

11. Enable live adapters only if their independent gates pass before
    mode freeze.

This is integration priority.

Independent implementation still happens in parallel.


17.3 MODULE HANDOFF QUALITY

Before accepting a module:

[ ] Exports match the frozen contract.
[ ] No unauthorized file areas changed.
[ ] No unauthorized dependencies added.
[ ] Errors use the agreed safe shape.
[ ] Relevant checks ran.
[ ] Fixture/live behavior is explicit.
[ ] No TODO stub remains on the claimed working path.
[ ] No secrets or personal data appear in logs or committed files.


17.4 DEPLOYMENT PREREQUISITES

[ ] Build passes.
[ ] Typecheck passes.
[ ] Database migration applied to the intended environment.
[ ] Required bindings exist.
[ ] Required secrets exist.
[ ] API/auth routes are not swallowed by SPA fallback.
[ ] OAuth callback origin matches deployed configuration if live.
[ ] Access control protects the deployed application.
[ ] Evidence mode explicitly configured.
[ ] Extraction mode explicitly configured.
[ ] Release checks have evidence or are clearly unverified.
[ ] Known-good deployment or rollback path recorded.


17.5 DEPLOYED SMOKE CHECK

1. Open the frontend.
2. Verify asset paths.
3. Call health endpoint.
4. Call a protected read endpoint.
5. Verify unauthorized requests fail.
6. Seed or select controlled demo data through an operator path.
7. Trigger sync.
8. Verify actual Queue and Workflow progression.
9. Load the generated review bundle.
10. Save corrections.
11. Confirm the revised amount.
12. Approve.
13. Observe completion.
14. Export.
15. Compare revision and mode metadata.
16. Check redacted operational logs.

A successful deploy command does not prove the application works.


17.6 ROLLBACK AND FAILURE HANDLING

If the deployment is broken:

- Restore the known-good Worker version where available.
- Preserve evidence of the failure.
- Do not delete production-like records to save the demonstration.
- Do not run destructive schema rollback commands casually.
- Prefer an isolated demo database.
- Prefer forward-compatible schema changes.

If deployment is not repaired by M18:

- Use the tested local build.
- State the limitation.
- Preserve redacted logs and configuration details for later repair.


18. DEMO SCRIPT AND COMPLETION EVIDENCE
=======================================

18.1 PRE-DEMO PREPARATION

[ ] Select a deterministic fixture session or prior consented mock session.
[ ] Confirm evidence, extraction, and runtime modes are visible.
[ ] Reset only isolated demo data using an operator-controlled script.
[ ] Confirm provider authentication.
[ ] Confirm initial missing progress is visible.
[ ] Confirm duration is initially unconfirmed.


18.2 TWO-MINUTE DEMONSTRATION

0:00–0:15

Action:
Explain the fictional scheduled visit and mode labels.

Evidence:
Appointment and service are visible.


0:15–0:30

Action:
Trigger manual sync or show completed scheduled processing.

Evidence:
Actual backend states progress.


0:30–0:50

Action:
Open review and inspect generated records.

Evidence:
Note, progress, coverage, follow-up, and sources appear.


0:50–1:10

Action:
Show missing goal evidence and required progress issue.

Evidence:
Unknown remains unknown.
Approval is blocked.


1:10–1:30

Action:
Confirm progress.
Change duration to 90 minutes.
Save.

Evidence:
Server returns a new revision and USD 112.50.


1:30–1:45

Action:
Approve the displayed revision.

Evidence:
Pending approval/finalization, then completed.


1:45–2:00

Action:
Download or print the finalized bundle.

Evidence:
Export matches the approved revision and mode metadata.


Actual live latency may exceed this demonstration timing.

Do not fake progress transitions to fit the script.

Use the fixture path when deterministic timing is necessary and
disclose that choice.


18.3 REQUIRED COMPLETION EVIDENCE

- Build or commit identifier.
- Test report with pass/fail/not-run.
- Local URL or actual deployed URL.
- Evidence mode.
- Extraction mode.
- Runtime mode.
- Completed session ID.
- Approved bundle revision.
- Confirmed duration.
- Invoice amount.
- Exported bundle or reproducible export path.
- Known limitations.
- Unresolved live/deployment gates.


18.4 FINAL REPORT TEMPLATE

Outcome:
live deployed / mixed deployed / local fixture / partial prototype

Implemented:
- ...

Verified:
- ...

Modes:
- Evidence:
- Extraction:
- Runtime:

Demo session:
Approved revision:
Confirmed minutes:
Amount:
Export:

Failed or unrun gates:
- ...

Preparation duration:
Implementation duration:

Next highest-priority work:
- ...


19. MASTER ORCHESTRATOR PROMPT AND HANDOFF TEMPLATES
===================================================

19.1 MASTER PROMPT FOR A 20-SLOT RUNNER

Build the bounded Vexo Field Assistant demo described in this document.

Use exactly 20 total agent roles:

- Agent 01 is integration lead.
- Agents 02–20 own the assignments in Section 13.

This is one coordinated implementation, not 20 independent applications.

Before starting the timer:

1. Report readiness from Section 5.
2. Confirm actual concurrency and repository execution model.
3. Confirm starter build, fixtures, resources, and access control.
4. Declare whether preparation is included in the deadline.

At T0:

1. Distribute the same plan, baseline, contracts, and ownership map.
2. Publish importable stubs immediately.
3. Keep implementation inside assigned file areas.
4. Use fixtures while live dependencies are unfinished.

Coordination:

- Agent 02 owns shared contracts.
- Agent 03 owns packages and platform configuration.
- Agent 04 owns migrations and repository primitives.
- Agent 01 owns composition and integration decisions.
- Report blockers after 60 seconds.
- Continue independent work while blocked.
- Report status at minutes 2, 5, 8, 12, and 16.
- Integrate early.
- Do not wait for every worker to finish.

Gates:

M2:
Shared contracts and compiling stubs.

M5:
Readiness/live-dependency decision.

M8:
Evidence and extraction modes frozen.

M12:
Complete fixture path and feature freeze.

M16:
Acceptance and release report.

M18:
Deployed or verified local demonstration selected.

M20:
Demonstration and honest final report.

Non-negotiable behavior:

- AI output stays evidence-backed.
- Unknowns remain explicit.
- Billing uses confirmed duration and integer-money rules.
- Edits are saved and recalculated before exact-revision approval.
- Duplicate delivery/approval cannot duplicate final records.
- App authentication is distinct from Vexo authorization.
- No silent live-to-fixture fallback.
- No automatic approval on timeout.
- No public secret.
- No transcript dump.
- No force-approval route.
- No payment action.

If a gate fails:

- Change the declared outcome.
- Report the blocker.
- Do not describe fixtures or untested integrations as live.

Deliver:

- Source.
- Run commands.
- Test evidence.
- Demo runbook.
- Limitations.


19.2 INDIVIDUAL-AGENT PREAMBLE

Prepend this to the role-specific prompt:

Read the shared plan's scope, ownership, contracts, approval, and
timing rules.

Your task is bounded by your assigned files.

You may read other modules, but request cross-owner edits through the
owner or integrator.

Publish compiling exports immediately.

Build against canonical fixtures while dependencies are unfinished.

Run focused checks for meaningful failure modes.

Remain available for integration fixes until the end of the sprint.

Do not expand scope.


19.3 DEPENDENCY REQUEST TEMPLATE

From agent:
To owner:
Needed export/schema:
Current contract:
Problem:
Smallest proposed change:
Consumers affected:
Can proceed with stub: yes/no
Needed by minute:


19.4 IMPLEMENTATION HANDOFF TEMPLATE

Agent:
Owned files changed:
Commit or shared-workspace status:
Exports/routes:
Dependency assumptions:
Validation commands/results:
Live/fixture behavior:
Known limitation:
Ready for integration: yes/no


19.5 BLOCKER REPORT TEMPLATE

Agent:
Blocked since minute:
Exact failing operation:
Observed error, redacted:
Owner who can resolve:
Independent work continuing:
Proposed fallback:
Impact on claimed outcome:


19.6 SEVEN-SLOT ADAPTATION

If constrained to seven slots:

- Retain one coordinator.
- Run six implementers at a time.
- Consolidate or rotate assignments.

Possible initial groups:

1. Platform and contracts.
2. Persistence and security.
3. OAuth and evidence.
4. Matching and extraction.
5. Documents, rules, and billing.
6. User interface.

Then rotate capacity into:

- Jobs and Workflow.
- API and approval.
- Integration QA.

This changes concurrency and lengthens the critical path.

Re-estimate the deadline.

Do not claim the same 20-minute expectation merely because the task
list still contains 20 role names.


20. RISK REGISTER AND FALLBACK DECISIONS
========================================

RISK: NO WORKING STARTER

Trigger:
Build unavailable at T0.

Owners:
03, 01.

Action:
Reduce the goal to setup/integration spike or add explicit preparation.

Limitation:
No full-demo guarantee.


RISK: INSUFFICIENT AGENT SLOTS

Trigger:
Runner cannot execute 20 roles concurrently.

Owner:
01.

Action:
Use waves or consolidate roles; re-estimate.

Limitation:
Not a 20-agent parallel run.


RISK: VEXO ACCOUNT OR CONSENT BLOCKED

Trigger:
No token by M5.

Owner:
06.

Action:
Use explicit fixture evidence.

Limitation:
Wearable integration unverified.


RISK: TRANSCRIPT UNAVAILABLE OR LATE

Trigger:
No usable result by M8.

Owner:
07.

Action:
Use prior authorized mock evidence or synthetic fixtures.

Limitation:
New-capture latency unproven.


RISK: MCP SHAPE DIFFERS

Trigger:
Live schema mismatch.

Owners:
07, 02.

Action:
Normalize at adapter boundary; preserve downstream contracts.

Limitation:
Live gate remains open.


RISK: MODEL INVALID OR SLOW

Trigger:
Repeated invalid output or timeout.

Owner:
10.

Action:
Bound retry; select explicit fixture extraction.

Limitation:
Live extraction unverified.


RISK: RATE LIMITS

Trigger:
Upstream requests rejected.

Owners:
07, 10.

Action:
Backoff, reduce duplicate fetches, preserve failures.

Limitation:
Throughput unverified.


RISK: MATCHING AMBIGUITY

Trigger:
Multiple eligible appointments.

Owner:
08.

Action:
Stop automatic processing.

Limitation:
Manual resolution deferred.


RISK: CONTRACT DRIFT

Trigger:
Consumers disagree.

Owners:
02, 01.

Action:
Freeze schema and use local adapters where appropriate.

Limitation:
Integration may miss a gate.


RISK: FILE CONFLICTS

Trigger:
Multiple agents edit the same area.

Owner:
01.

Action:
Restore ownership and resolve small changes.

Limitation:
Lost time; no silent overwrites.


RISK: DUPLICATE PROCESSING

Trigger:
Repeated Queue or Workflow effects.

Owners:
04, 09, 14.

Action:
Fix stable IDs and idempotent writes.

Limitation:
Completion blocked.


RISK: LOST APPROVAL NOTIFICATION

Trigger:
Database commit succeeds but notification fails.

Owners:
09, 16.

Action:
Retry durable intent and verify finalization.

Limitation:
Reliability claim blocked until tested.


RISK: STALE APPROVAL

Trigger:
Concurrent edits or browser tabs.

Owners:
04, 16, 18.

Action:
Reject old revision and require re-review.

Limitation:
Completion blocked if bypassable.


RISK: WRONG MONETARY AMOUNT

Trigger:
Floating-point error or unconfirmed-time calculation.

Owner:
13.

Action:
Use integer units and confirmation gate.

Limitation:
Completion blocked.


RISK: MISSING APPLICATION AUTHENTICATION

Trigger:
Public routes unprotected.

Owners:
19, 03.

Action:
Use local synthetic-only demonstration.

Limitation:
Deployed/private-data target blocked.


RISK: SENSITIVE CONTENT IN LOGS

Trigger:
Transcript or token appears in traces.

Owners:
19 and relevant implementation owner.

Action:
Remove unsafe logging.
Rotate exposed credentials where necessary.
Retest.

Limitation:
Release blocked.


RISK: DEPLOYMENT FAILURE

Trigger:
Build, binding, or runtime issue at M18.

Owner:
03.

Action:
Demonstrate the verified local version.

Limitation:
Deployment unverified.


RISK: CRON NOT OBSERVED

Trigger:
No actual remote scheduled event within the window.

Owners:
09, 03.

Action:
Test handler invocation and disclose the unobserved schedule.

Limitation:
Automatic production timing unproven.


RISK: TESTS NOT EXECUTED

Trigger:
Time expires before mandatory checks.

Owners:
20, 01.

Action:
Mark not run and qualify the outcome.

Limitation:
Reliability remains unverified.


20.1 SCOPE-CUT ORDER

Cut first:

- Visual polish.
- Extra export styling.
- Optional detailed progress wording.
- Live-adapter attempts that miss their gates.

Preserve:

- Evidence integrity.
- Access checks.
- Deterministic money.
- Revision-safe approval.
- Honest mode and outcome labels.

Do not save time by:

- Removing approval validation.
- Hiding errors.
- Auto-filling missing facts.
- Submitting a fixture invoice as a real invoice.


21. POST-SPRINT PRODUCT BACKLOG
===============================

This backlog preserves the full product intent without pretending it
fits inside the initial sprint.

Estimate follow-up work after observing real integration behavior.


21.1 INTEGRATION HARDENING

[ ] Measure capture-to-transcript latency across real mock sessions.
[ ] Confirm speaker coverage.
[ ] Confirm timestamp granularity.
[ ] Confirm pagination behavior.
[ ] Confirm source retrieval behavior.
[ ] Test reconnect and token rotation.
[ ] Test refresh concurrency.
[ ] Test revocation.
[ ] Handle upstream edits and deletions.
[ ] Define downstream retention implications.
[ ] Add actual calendar synchronization.
[ ] Define rescheduling and cancellation semantics.
[ ] Handle recurring appointments.
[ ] Handle group sessions.
[ ] Handle travel time.
[ ] Handle late evidence.
[ ] Add manual evidence reassignment with audit history.
[ ] Add monitored recovery for exhausted jobs.
[ ] Add operational alerting.


21.2 PRODUCT COMPLETENESS

[ ] Multiple service plans.
[ ] Versioned documentation rules.
[ ] Configured payer/service policies.
[ ] Reviewed amendments after approval.
[ ] Correction workflows.
[ ] Draft rejection controls.
[ ] Reprocessing controls.
[ ] Agency review roles.
[ ] Delegated approval where appropriate.
[ ] PDF export.
[ ] R2 storage with controlled access.
[ ] Batch review.
[ ] Daily summaries.
[ ] User-controlled retention.
[ ] User-controlled deletion flows.
[ ] Accessibility review beyond smoke checks.
[ ] Clear consent and capture-status experience.


21.3 AI AND QUALITY EVALUATION

[ ] Curated consented evaluation dataset.
[ ] Representative session types.
[ ] Citation validity evaluation.
[ ] Interpretation accuracy evaluation.
[ ] Activity extraction precision and recall.
[ ] Goal extraction precision and recall.
[ ] Progress extraction precision and recall.
[ ] Follow-up extraction precision and recall.
[ ] Unsupported-claim rate measurement.
[ ] False-confidence assessment.
[ ] Incomplete transcript evaluation.
[ ] Noisy transcript evaluation.
[ ] Multiple-speaker evaluation.
[ ] Systematic prompt-injection testing.
[ ] Adversarial evidence evaluation.
[ ] Model cost/latency/quality comparison.
[ ] Prompt and schema versioning.
[ ] Migration and reprocessing policy.


21.4 BILLING AND EXTERNAL ACTIONS

[ ] Validate actual payer rules.
[ ] Validate billing units and rounding.
[ ] Validate caps and service codes.
[ ] Validate eligibility requirements.
[ ] Establish invoice numbering.
[ ] Establish correction policy.
[ ] Add external invoice delivery only with authorization.
[ ] Add payment integration after invoice semantics are stable.
[ ] Add external-action idempotency.
[ ] Add delivery receipts.
[ ] Keep documentation approval distinct from claims/payment submission.


21.5 PRODUCTION SECURITY AND OPERATIONS

[ ] Threat model.
[ ] Independent security review.
[ ] Multi-tenant authorization.
[ ] Role-based access.
[ ] Audit trails.
[ ] Applicable legal/privacy review.
[ ] Vendor agreements for the intended data.
[ ] Retention procedures.
[ ] Deletion procedures.
[ ] Backup and restore.
[ ] Incident response.
[ ] Key rotation.
[ ] Gateway storage and retention review.
[ ] Workflow storage and retention review.
[ ] Database location and retention review.
[ ] Capacity testing.
[ ] Cost monitoring.
[ ] Observability.
[ ] Load testing.
[ ] Fault injection.
[ ] Stuck-session monitoring.
[ ] Failed-finalization monitoring.
[ ] Operational ownership.
[ ] Support runbook.


21.6 OPTIONAL WELL-BEING EXTENSION

[ ] Verify actual sensor API access separately.
[ ] Define a user-controlled purpose.
[ ] Define retention policy.
[ ] Separate personal trends from diagnosis claims.
[ ] Keep the extension outside the administrative critical path.


22. FINAL DEFINITION OF DONE
============================

22.1 COMPLETE FIXTURE DEMO

[ ] Repository builds.
[ ] Repository starts with documented commands.
[ ] Fictional appointment seeds repeatably.
[ ] Explicit fixture evidence enters the actual processing path.
[ ] Structured facts produce a session note.
[ ] Structured facts produce progress.
[ ] Structured facts produce plan coverage.
[ ] Structured facts produce follow-ups.
[ ] Required documentation checks run.
[ ] Billing is deterministic.
[ ] Unknown information remains visible.
[ ] Missing information remains visible.
[ ] Provider confirms duration.
[ ] Provider supplies required permitted corrections.
[ ] Saving edits returns a recalculated revision and amount.
[ ] Approval requires the displayed current revision.
[ ] Approval requires a valid authenticated actor.
[ ] Duplicate delivery does not duplicate finalization.
[ ] Duplicate approval does not duplicate finalization.
[ ] Failed notification is recoverable.
[ ] Durable approval is not lost.
[ ] Export matches the approved snapshot.
[ ] UI mode labels are accurate.
[ ] Export mode labels are accurate.
[ ] Acceptance results are documented.
[ ] Unverified behavior is documented.


22.2 ADDITIONAL REQUIREMENTS FOR A LIVE DEPLOYED CLAIM

[ ] Actual authorized Vexo retrieval succeeded.
[ ] Actual structured model extraction succeeded.
[ ] Deployed Worker served UI and API correctly.
[ ] Actual deployed Queue behavior observed.
[ ] Actual deployed Workflow behavior observed.
[ ] Actual deployed D1 behavior observed.
[ ] Application access control verified remotely.
[ ] Full review/approval/export completed remotely.
[ ] Any scheduling claim has an observed trigger, not just configuration.


22.3 HANDOFF PACKAGE

[ ] Source repository or exact commit.
[ ] Environment setup instructions.
[ ] Binding setup instructions without secrets.
[ ] Migration instructions.
[ ] Seed instructions.
[ ] Shared contract/schema version.
[ ] Test commands.
[ ] Test results.
[ ] Demo instructions.
[ ] Example session and approved revision.
[ ] Known limitations.
[ ] Next work.


COMPLETION RULE

A deadline determines when the team reports the result.

It does not determine whether the result passed.


23. REFERENCE SOURCES AND VALIDATION LIMITS
===========================================

23.1 USER-SUPPLIED PRODUCT SOURCE

“Vexo Field Assistant — Complete Product + Technical Architecture,”
uploaded as Pasted text.txt.

This plan preserves:

- The core product.
- Seven logical business pipelines.
- Screen-free field experience.
- Cloudflare-first implementation.

It adds the corrections and coordination requirements described above.


23.2 OFFICIAL DOCUMENTATION CHECKED

Vexo developer documentation:
https://www.vexoai.com/docs

Supports the documented OAuth/MCP evidence integration.
Account-specific behavior remains untested.


Cloudflare Workflows events and parameters:
https://developers.cloudflare.com/workflows/build/events-and-parameters/

Supports event type, sendEvent, and explicit wait/timeout design.


Cloudflare Workflows rules:
https://developers.cloudflare.com/workflows/build/rules-of-workflows/

Supports the need for idempotent operations in retryable steps.


Cloudflare Queues delivery guarantees:
https://developers.cloudflare.com/queues/reference/delivery-guarantees/

Establishes at-least-once delivery and the need for deduplication.


Cloudflare Workers static assets:
https://developers.cloudflare.com/workers/static-assets/

Supports serving the frontend with the Worker application.


Cloudflare D1 database API:
https://developers.cloudflare.com/d1/worker-api/d1-database/

Supports prepared statements and transactional batches.


23.3 VALIDATION BOUNDARIES

This is architecture and planning validation against:

- The supplied brief.
- Selected official documentation.

It does not imply:

- Production compliance determination.
- Performance benchmarking.
- Actual account connection.
- Application implementation.
- Deployment verification.

The minute-by-minute targets are planning constraints, not empirical
measurements of a specific team's speed.

Before execution, verify:

- SDK versions.
- Tool schemas.
- Account permissions.
- Runtime behavior.
- Actual environment readiness.


END OF MASTER PLAN
==================

Use the frozen scope, shared contracts, and ownership rules together.

Distributing only the individual prompts without the shared
specification will recreate the integration problems this plan is
designed to prevent.
