/**
 * SessionWorkflow body (Agent 14). Runtime-agnostic: no "cloudflare:*" imports,
 * so vitest can exercise it with a fake StepLike. See src/workflow/index.ts for
 * the WorkflowEntrypoint adapter.
 *
 * Durability rules:
 *  - Step results are SMALL (ids/status/revisions). Transcripts, evidence and
 *    bundles are written to D1 inside steps and never returned from them.
 *  - Every approval check is its own named step, so each one is a fresh durable
 *    read (never a memoized pre-approval read).
 *  - An event payload is a wake-up hint only; the durable approval row is truth.
 *  - A wait timeout never approves.
 */
import {
  APPROVAL_EVENT_TYPE,
  ApprovalNotification,
  EvidenceUnavailableError,
  ExtractionRejectedError,
  SCHEMA_VERSION,
} from "../contracts";
import type {
  AssembleBundleFn,
  BundleProvenance,
  Clock,
  EvidenceResult,
  EvidenceSource,
  Extractor,
  ExtractionOutput,
  MatchEvidenceFn,
  RuntimeMode,
  SessionRecord,
  SessionStatus,
  WorkflowParams,
} from "../contracts";
import type { Repository } from "../db/repository";

export interface WorkflowDeps {
  repo: Repository;
  evidence: EvidenceSource;
  extractor: Extractor;
  match: MatchEvidenceFn;
  assemble: AssembleBundleFn;
  clock: Clock;
  runtimeMode: RuntimeMode;
  approvalTimeout?: string;
}

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  waitForEvent<T>(name: string, opts: { type: string; timeout: string | number }): Promise<{ payload: T }>;
}

export const MAX_APPROVAL_ITERATIONS = 5;
export const DEFAULT_APPROVAL_TIMEOUT = "24 hours";

/** Statuses at which a draft for this processing revision already exists. */
const DRAFTED: readonly SessionStatus[] = ["NEEDS_REVIEW", "APPROVED", "COMPLETED"];
/** Terminal non-review outcomes of the prepare step. */
const TERMINAL_FAILURES: readonly SessionStatus[] = ["NO_EVIDENCE", "AMBIGUOUS_MATCH", "INCOMPLETE", "FAILED"];

type PrepareResult = { status: SessionStatus | "STALE"; bundleRevision?: number };
type ApprovalCheck =
  | { kind: "approved"; approvalId: string; bundleRevision: number }
  | { kind: "pending"; currentBundleRevision: number }
  | { kind: "stale" };

function log(event: string, fields: Record<string, unknown>): void {
  // Ids/revisions only — never transcripts, facts or credentials.
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

export async function runSessionWorkflow(
  deps: WorkflowDeps,
  params: WorkflowParams,
  step: StepLike,
): Promise<{ outcome: string }> {
  const { repo, clock } = deps;
  const { sessionId, processingRevision: rev } = params;

  // ---------------------------------------------------------------- a. load
  const loaded = await step.do(`load session r${rev}`, async () => {
    const session = await repo.getSession(sessionId);
    if (!session) return { found: false as const };
    return {
      found: true as const,
      stale: session.processingRevision !== rev,
      status: session.status,
    };
  });
  if (!loaded.found) {
    log("workflow.session_missing", { sessionId, processingRevision: rev });
    return { outcome: "missing" };
  }
  if (loaded.stale) {
    log("workflow.stale", { sessionId, processingRevision: rev });
    return { outcome: "stale" };
  }

  // ---------------------------------------------------------------- b. mark processing
  const marked = await step.do("mark processing", async () => {
    const res = await repo.transitionSession(sessionId, ["QUEUED"], "PROCESSING", null, clock.now());
    if (res.ok) return { stale: false, status: res.value.status };
    const s = await repo.getSession(sessionId);
    if (!s || s.processingRevision !== rev) return { stale: true, status: s?.status ?? null };
    // Already PROCESSING (or further) for this revision: idempotent.
    if (s.status === "QUEUED") throw new Error("transition to PROCESSING did not apply");
    return { stale: false, status: s.status };
  });
  if (marked.stale) return { outcome: "stale" };

  // ---------------------------------------------------------------- c. prepare draft
  const prepared = await step.do(`prepare draft r${rev}`, () => prepareDraft(deps, sessionId, rev));
  if (prepared.status === "STALE") return { outcome: "stale" };
  if (TERMINAL_FAILURES.includes(prepared.status as SessionStatus)) {
    return { outcome: prepared.status.toLowerCase() };
  }
  if (!DRAFTED.includes(prepared.status as SessionStatus)) {
    // Should be unreachable: prepareDraft only returns drafted/terminal/STALE.
    throw new Error(`unexpected prepare status ${prepared.status}`);
  }

  // ---------------------------------------------------------------- d. approval loop
  const timeout = deps.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
  const check = () => checkApproval(repo, sessionId, rev);
  let approved: Extract<ApprovalCheck, { kind: "approved" }> | null = null;

  for (let i = 0; i < MAX_APPROVAL_ITERATIONS && !approved; i++) {
    const c = await step.do(`check approval #${i}`, check);
    if (c.kind === "stale") return { outcome: "stale" };
    if (c.kind === "approved") {
      approved = c;
      break;
    }

    let woke: { payload: unknown };
    try {
      woke = await step.waitForEvent<unknown>(`await provider approval #${i}`, {
        type: APPROVAL_EVENT_TYPE,
        timeout,
      });
    } catch {
      // Timeout (the runtime throws). Fresh durable check — a timeout never approves.
      const after = await step.do(`check approval after timeout #${i}`, check);
      if (after.kind === "stale") return { outcome: "stale" };
      if (after.kind === "approved") {
        approved = after;
        break;
      }
      log("workflow.approval_timeout", { sessionId, processingRevision: rev, iteration: i });
      return { outcome: "approval_timeout" };
    }

    // Payload is a hint only; loop re-reads durable state.
    const hint = ApprovalNotification.shape.payload.safeParse(woke.payload);
    if (!hint.success || hint.data.sessionId !== sessionId) {
      log("workflow.approval_event_ignored", { sessionId, iteration: i, reason: "invalid_payload" });
    } else if (hint.data.bundleRevision !== c.currentBundleRevision) {
      log("workflow.approval_event_revision_mismatch", {
        sessionId,
        iteration: i,
        eventRevision: hint.data.bundleRevision,
        currentBundleRevision: c.currentBundleRevision,
      });
    }
  }

  if (!approved) {
    // Woke MAX times without a durable approval: one last fresh read.
    const last = await step.do(`check approval #${MAX_APPROVAL_ITERATIONS}`, check);
    if (last.kind === "stale") return { outcome: "stale" };
    if (last.kind !== "approved") {
      log("workflow.approval_unconfirmed", { sessionId, processingRevision: rev });
      return { outcome: "approval_unconfirmed" };
    }
    approved = last;
  }

  // ---------------------------------------------------------------- e. finalize
  const { approvalId, bundleRevision } = approved;
  await step.do(`finalize r${bundleRevision}`, async () => {
    const res = await repo.finalizeApproved(sessionId, approvalId, bundleRevision, clock.now());
    if (res.ok) return { finalized: true, bundleRevision: res.value.bundleRevision };
    const existing = await repo.getFinalBundle(sessionId);
    if (existing && existing.bundleRevision === bundleRevision && existing.approvalId === approvalId) {
      return { finalized: true, bundleRevision };
    }
    throw new Error(`finalize failed: ${res.reason}`);
  });
  log("workflow.completed", { sessionId, processingRevision: rev, bundleRevision });
  return { outcome: "completed" };
}

// -------------------------------------------------------------------- helpers

async function checkApproval(repo: Repository, sessionId: string, rev: number): Promise<ApprovalCheck> {
  const session = await repo.getSession(sessionId);
  if (!session || session.processingRevision !== rev) return { kind: "stale" };
  const approval = await repo.getApprovalForSession(sessionId);
  if (
    approval &&
    approval.bundleRevision === session.currentBundleRevision &&
    (session.status === "APPROVED" || session.status === "COMPLETED")
  ) {
    return { kind: "approved", approvalId: approval.id, bundleRevision: approval.bundleRevision };
  }
  return { kind: "pending", currentBundleRevision: session.currentBundleRevision };
}

/** Moves PROCESSING -> `to`; tolerant of a retry that already applied it. */
async function finishAs(
  deps: WorkflowDeps,
  sessionId: string,
  rev: number,
  to: SessionStatus,
  reason: string,
): Promise<PrepareResult> {
  const res = await deps.repo.transitionSession(sessionId, ["PROCESSING"], to, reason, deps.clock.now());
  if (res.ok) {
    log("workflow.terminal", { sessionId, processingRevision: rev, status: to });
    return { status: to };
  }
  const s = await deps.repo.getSession(sessionId);
  if (!s || s.processingRevision !== rev) return { status: "STALE" };
  if (s.status === to) return { status: to };
  throw new Error(`transition to ${to} failed: ${res.reason}`);
}

/** Result for a session that has already left PROCESSING (retry/replay). */
function alreadyAdvanced(s: SessionRecord): PrepareResult | null {
  if (DRAFTED.includes(s.status)) return { status: s.status, bundleRevision: s.currentBundleRevision };
  if (TERMINAL_FAILURES.includes(s.status)) return { status: s.status };
  return null;
}

async function prepareDraft(deps: WorkflowDeps, sessionId: string, rev: number): Promise<PrepareResult> {
  const { repo, clock } = deps;
  const session = await repo.getSession(sessionId);
  if (!session || session.processingRevision !== rev) return { status: "STALE" };
  if (session.status !== "PROCESSING") {
    const done = alreadyAdvanced(session);
    if (done) return done;
    throw new Error(`session not PROCESSING (${session.status})`);
  }

  const appointment = await repo.getAppointment(session.appointmentId);
  if (!appointment) return finishAs(deps, sessionId, rev, "FAILED", "Appointment record unavailable.");
  const config = await repo.getServiceConfig(appointment.planVersion, appointment.ruleVersion, appointment.rateVersion);
  if (!config) return finishAs(deps, sessionId, rev, "FAILED", "Service configuration unavailable.");

  // retrieve
  let result: EvidenceResult;
  try {
    result = await deps.evidence.retrieveEvidence(appointment);
  } catch (err) {
    if (err instanceof EvidenceUnavailableError) {
      return finishAs(deps, sessionId, rev, "FAILED", `Evidence source unavailable (${err.kind}).`);
    }
    throw err;
  }
  if (result.items.length === 0) {
    return finishAs(deps, sessionId, rev, "NO_EVIDENCE", "No evidence found for the appointment window.");
  }

  // match
  const overlapping = await repo.listProviderAppointmentsOverlapping(
    appointment.providerId,
    appointment.startAt,
    appointment.endAt,
  );
  const competing = overlapping.filter((a) => a.id !== appointment.id);
  const match = deps.match(appointment, result, competing);
  if (match.outcome === "ambiguous") {
    return finishAs(deps, sessionId, rev, "AMBIGUOUS_MATCH", "Evidence could match more than one appointment.");
  }
  if (match.outcome === "no_evidence" || match.evidence.length === 0) {
    return finishAs(deps, sessionId, rev, "NO_EVIDENCE", "No evidence matched the appointment window.");
  }
  await repo.replaceEvidence(sessionId, rev, match.evidence);

  // extract
  let extraction: ExtractionOutput;
  try {
    extraction = await deps.extractor.extractFacts({ appointment, plan: config.plan, evidence: match.evidence });
  } catch (err) {
    if (err instanceof ExtractionRejectedError) {
      return finishAs(deps, sessionId, rev, "INCOMPLETE", `Extraction rejected (${err.reason}).`);
    }
    throw err;
  }

  // assemble
  const bundleRevision = session.currentBundleRevision + 1;
  const provenance: BundleProvenance = {
    evidenceMode: deps.evidence.mode,
    extractionMode: extraction.mode,
    runtimeMode: deps.runtimeMode,
    schemaVersion: SCHEMA_VERSION,
    promptVersion: extraction.promptVersion,
    model: extraction.model,
    evidenceCompleteness: result.completeness,
    evidenceWarnings: [...result.warnings, ...match.warnings],
  };
  const now = clock.now();
  const bundle = deps.assemble({
    sessionId,
    bundleRevision,
    processingRevision: rev,
    appointment,
    config,
    evidence: match.evidence,
    evidenceWindow: match.evidenceWindow,
    facts: extraction.facts,
    attestations: [],
    provenance,
    createdAt: now.toISOString(),
  });

  // save
  const saved = await repo.saveDraft(bundle, now);
  if (saved.ok) {
    log("workflow.draft_saved", { sessionId, processingRevision: rev, bundleRevision });
    return { status: "NEEDS_REVIEW", bundleRevision };
  }
  const after = await repo.getSession(sessionId);
  if (!after || after.processingRevision !== rev) return { status: "STALE" };
  if (DRAFTED.includes(after.status) && after.currentBundleRevision >= bundleRevision) {
    // A previous attempt already saved this draft.
    return { status: after.status, bundleRevision };
  }
  throw new Error(`saveDraft failed: ${saved.reason}`);
}
