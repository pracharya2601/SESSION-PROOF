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
  VISIT_APPOINTMENT_PREFIX,
  workflowInstanceId,
} from "../contracts";
import type {
  Appointment,
  AssembleBundleFn,
  ClientRecord,
  BundleProvenance,
  Clock,
  EvidenceResult,
  EvidenceSource,
  Extractor,
  ExtractionOutput,
  MatchEvidenceFn,
  RunRecorder,
  RuntimeMode,
  SessionRecord,
  SessionStatus,
  WorkflowParams,
} from "../contracts";
import type { Repository } from "../db/repository";
import { effectiveRate, snapshotClient } from "../clients/index";
import { safeRecord } from "../history/index";

export interface WorkflowDeps {
  repo: Repository;
  evidence: EvidenceSource;
  extractor: Extractor;
  match: MatchEvidenceFn;
  assemble: AssembleBundleFn;
  clock: Clock;
  runtimeMode: RuntimeMode;
  approvalTimeout?: string;
  /** v2: called after finalization (e.g. enqueue auto drive upload). Failures never undo completion. */
  onCompleted?: (sessionId: string) => Promise<unknown>;
  /** v3: run history (best-effort; never fails the workflow). */
  recorder?: RunRecorder;
  /** v3: client record for the appointment (per-client rate + snapshot at finalization). */
  resolveClient?: (appointment: Appointment) => Promise<ClientRecord | null>;
}

type RecordInput = Parameters<RunRecorder["record"]>[0];
/** Records one event for this processing run (ids/counts/reason codes only). */
type Emit = (
  stage: RecordInput["stage"],
  status: RecordInput["status"],
  label: string,
  extra?: { detail?: string | null; meta?: RecordInput["meta"]; idSuffix?: string },
) => Promise<void>;

function emitterFor(deps: WorkflowDeps, sessionId: string, rev: number, providerId: string): Emit {
  const runId = workflowInstanceId(sessionId, rev);
  return (stage, status, label, extra = {}) =>
    safeRecord(deps.recorder, {
      runId,
      runKind: "processing",
      sessionId,
      providerId,
      stage,
      status,
      label,
      detail: extra.detail ?? null,
      meta: extra.meta ?? {},
      ...(extra.idSuffix ? { idSuffix: extra.idSuffix } : {}),
    });
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
    const stale = session.processingRevision !== rev;
    if (!stale) {
      const emit = emitterFor(deps, sessionId, rev, session.providerId);
      let clientRef: string | null = null;
      try {
        clientRef = (await repo.getAppointment(session.appointmentId))?.clientRef ?? null;
      } catch {
        clientRef = null;
      }
      const meta = { processingRevision: rev, clientRef, runtimeMode: deps.runtimeMode };
      await emit("workflow_started", "started", "Workflow started", { meta });
      await emit("load", "succeeded", "Loaded session", { meta: { status: session.status, clientRef } });
    }
    return {
      found: true as const,
      stale,
      status: session.status,
      providerId: session.providerId,
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
  const emit = emitterFor(deps, sessionId, rev, loaded.providerId);

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
  const prepared = await step.do(`prepare draft r${rev}`, () => prepareDraft(deps, sessionId, rev, emit));
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
  /** A check step that also records its outcome (inside the step: replay doesn't re-emit). */
  const checkAndRecord = (onPending: (c: Extract<ApprovalCheck, { kind: "pending" }>) => Promise<void>) => async () => {
    const c = await check();
    if (c.kind === "approved") {
      await emit("approved", "succeeded", "Provider approved", {
        meta: { bundleRevision: c.bundleRevision },
        idSuffix: `r${c.bundleRevision}`,
      });
    } else if (c.kind === "pending") {
      await onPending(c);
    }
    return c;
  };
  let approved: Extract<ApprovalCheck, { kind: "approved" }> | null = null;

  for (let i = 0; i < MAX_APPROVAL_ITERATIONS && !approved; i++) {
    const c = await step.do(
      `check approval #${i}`,
      checkAndRecord((p) =>
        emit("approval_wait", "waiting", "Waiting for provider approval", {
          meta: { iteration: i, bundleRevision: p.currentBundleRevision },
          idSuffix: String(i),
        }),
      ),
    );
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
      const after = await step.do(
        `check approval after timeout #${i}`,
        checkAndRecord(() =>
          emit("approval_wait", "info", "Approval wait timed out (not approved)", {
            detail: "approval_timeout",
            meta: { iteration: i },
            idSuffix: `timeout:${i}`,
          }),
        ),
      );
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
    const last = await step.do(
      `check approval #${MAX_APPROVAL_ITERATIONS}`,
      checkAndRecord(() =>
        emit("approval_wait", "info", "Approval not confirmed", {
          detail: "approval_unconfirmed",
          idSuffix: "unconfirmed",
        }),
      ),
    );
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
    if (deps.resolveClient) await snapshotClientFor(deps, sessionId, bundleRevision, emit);
    const done = async () => {
      await emit("finalize", "succeeded", "Finalized approved revision", { meta: { bundleRevision } });
      // Files are rendered on demand from the frozen bundle (HTML preview / PDF on download or sync).
      await emit("files", "succeeded", "Session Note, Invoice and Approval Record ready", {
        meta: { bundleRevision, files: 3 },
      });
      await emit("completed", "succeeded", "Session completed", { meta: { bundleRevision } });
      return { finalized: true, bundleRevision };
    };
    const res = await repo.finalizeApproved(sessionId, approvalId, bundleRevision, clock.now());
    if (res.ok) return done();
    const existing = await repo.getFinalBundle(sessionId);
    if (existing && existing.bundleRevision === bundleRevision && existing.approvalId === approvalId) {
      return done();
    }
    throw new Error(`finalize failed: ${res.reason}`);
  });
  if (deps.onCompleted) {
    await step.do(`after completion r${bundleRevision}`, async () => {
      try {
        await deps.onCompleted!(sessionId);
        return { ok: true };
      } catch (err) {
        // Completion is final; a failed hook (e.g. auto-upload enqueue) is logged, not retried forever.
        log("workflow.on_completed_failed", { sessionId, error: err instanceof Error ? err.name : "unknown" });
        return { ok: false };
      }
    });
  }
  log("workflow.completed", { sessionId, processingRevision: rev, bundleRevision });
  return { outcome: "completed" };
}

// -------------------------------------------------------------------- helpers

/**
 * Freezes the client record for the approved revision (idempotent per
 * session+revision). Throws on repo failure so the finalize step retries.
 */
async function snapshotClientFor(deps: WorkflowDeps, sessionId: string, bundleRevision: number, emit: Emit): Promise<void> {
  const existing = await deps.repo.getClientSnapshot(sessionId, bundleRevision);
  if (existing) {
    await emit("client_snapshot", "succeeded", "Client details frozen", {
      meta: { bundleRevision, rateVersion: existing.rateVersion, existing: true },
    });
    return;
  }
  const bundle = await deps.repo.getBundle(sessionId, bundleRevision);
  if (!bundle) throw new Error("approved bundle not found");
  const client = await deps.resolveClient!(bundle.appointment);
  if (!client) {
    await emit("client_snapshot", "skipped", "No client record to freeze", { meta: { bundleRevision } });
    return;
  }
  const snapshot = snapshotClient(client, bundle.config.rate, deps.clock.now());
  await deps.repo.saveClientSnapshot(sessionId, bundleRevision, snapshot);
  await emit("client_snapshot", "succeeded", "Client details frozen", {
    meta: { bundleRevision, rateVersion: client.rateVersion, effectiveHourlyRateCents: snapshot.effectiveHourlyRateCents },
  });
}

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
  emit?: Emit,
): Promise<PrepareResult> {
  // `reason` is always a fixed, safe string (enum codes only) — never upstream messages.
  const recordFailed = () =>
    emit?.("failed", "failed", `Stopped: ${to}`, { detail: reason, meta: { status: to } }) ?? Promise.resolve();
  const res = await deps.repo.transitionSession(sessionId, ["PROCESSING"], to, reason, deps.clock.now());
  if (res.ok) {
    log("workflow.terminal", { sessionId, processingRevision: rev, status: to });
    await recordFailed();
    return { status: to };
  }
  const s = await deps.repo.getSession(sessionId);
  if (!s || s.processingRevision !== rev) return { status: "STALE" };
  if (s.status === to) {
    await recordFailed();
    return { status: to };
  }
  throw new Error(`transition to ${to} failed: ${res.reason}`);
}

/** Result for a session that has already left PROCESSING (retry/replay). */
function alreadyAdvanced(s: SessionRecord): PrepareResult | null {
  if (DRAFTED.includes(s.status)) return { status: s.status, bundleRevision: s.currentBundleRevision };
  if (TERMINAL_FAILURES.includes(s.status)) return { status: s.status };
  return null;
}

async function prepareDraft(deps: WorkflowDeps, sessionId: string, rev: number, emit: Emit): Promise<PrepareResult> {
  const { repo, clock } = deps;
  const session = await repo.getSession(sessionId);
  if (!session || session.processingRevision !== rev) return { status: "STALE" };
  if (session.status !== "PROCESSING") {
    const done = alreadyAdvanced(session);
    if (done) return done;
    throw new Error(`session not PROCESSING (${session.status})`);
  }
  const fail = (to: SessionStatus, reason: string) => finishAs(deps, sessionId, rev, to, reason, emit);

  const appointment = await repo.getAppointment(session.appointmentId);
  if (!appointment) return fail("FAILED", "Appointment record unavailable.");
  const baseConfig = await repo.getServiceConfig(appointment.planVersion, appointment.ruleVersion, appointment.rateVersion);
  if (!baseConfig) return fail("FAILED", "Service configuration unavailable.");

  // retrieve
  const evidenceMode = deps.evidence.modeFor ? await deps.evidence.modeFor(appointment) : deps.evidence.mode;
  await emit("evidence", "started", "Retrieving evidence", { meta: { evidenceMode } });
  let result: EvidenceResult;
  try {
    result = await deps.evidence.retrieveEvidence(appointment);
  } catch (err) {
    if (err instanceof EvidenceUnavailableError) {
      await emit("evidence", "failed", "Evidence source unavailable", { detail: err.kind, meta: { retryable: err.retryable } });
      return fail("FAILED", `Evidence source unavailable (${err.kind}).`);
    }
    throw err;
  }
  await emit("evidence", "succeeded", `Retrieved ${result.items.length} evidence item(s)`, {
    meta: {
      items: result.items.length,
      completeness: result.completeness,
      unavailableSources: result.unavailableSourceIds.length,
      warnings: result.warnings.length,
    },
  });
  if (result.items.length === 0) {
    return fail("NO_EVIDENCE", "No evidence found for the appointment window.");
  }

  // match
  const overlapping = await repo.listProviderAppointmentsOverlapping(
    appointment.providerId,
    appointment.startAt,
    appointment.endAt,
  );
  // Band-visit evidence is bound to its own visit by id, not by time: a band appointment has no
  // competitors, and it never competes for another appointment's time-window evidence.
  const competing = appointment.id.startsWith(VISIT_APPOINTMENT_PREFIX)
    ? []
    : overlapping.filter((a) => a.id !== appointment.id && !a.id.startsWith(VISIT_APPOINTMENT_PREFIX));
  const match = deps.match(appointment, result, competing);
  const matchMeta = { outcome: match.outcome, matched: match.evidence.length, competing: competing.length };
  if (match.outcome === "ambiguous") {
    await emit("match", "failed", "Evidence could match more than one appointment", { detail: "ambiguous", meta: matchMeta });
    return fail("AMBIGUOUS_MATCH", "Evidence could match more than one appointment.");
  }
  if (match.outcome === "no_evidence" || match.evidence.length === 0) {
    await emit("match", "failed", "No evidence matched the appointment window", { detail: "no_evidence", meta: matchMeta });
    return fail("NO_EVIDENCE", "No evidence matched the appointment window.");
  }
  await emit("match", "succeeded", `Matched ${match.evidence.length} evidence item(s)`, { meta: matchMeta });
  await repo.replaceEvidence(sessionId, rev, match.evidence);

  // extract
  await emit("extraction", "started", "Extracting facts", { meta: { extractionMode: deps.extractor.mode } });
  let extraction: ExtractionOutput;
  try {
    extraction = await deps.extractor.extractFacts({ appointment, plan: baseConfig.plan, evidence: match.evidence });
  } catch (err) {
    if (err instanceof ExtractionRejectedError) {
      await emit("extraction", "failed", "Extraction rejected", { detail: err.reason });
      return fail("INCOMPLETE", `Extraction rejected (${err.reason}).`);
    }
    throw err;
  }

  // assemble
  const bundleRevision = session.currentBundleRevision + 1;
  const provenance: BundleProvenance = {
    evidenceMode,
    extractionMode: extraction.mode,
    runtimeMode: deps.runtimeMode,
    schemaVersion: SCHEMA_VERSION,
    promptVersion: extraction.promptVersion,
    model: extraction.model,
    evidenceCompleteness: result.completeness,
    evidenceWarnings: [...new Set([...result.warnings, ...match.warnings])],
  };
  // v2 extras from the multi-provider extractor (counts only, never values).
  const ext = extraction as typeof extraction & {
    aiProvider?: string;
    privacy?: { scrubbed: boolean; findings: Partial<Record<string, number>> };
  };
  if (ext.aiProvider) provenance.aiProvider = ext.aiProvider;
  if (ext.privacy) {
    const findings: Record<string, number> = {};
    for (const [k, v] of Object.entries(ext.privacy.findings)) if (typeof v === "number") findings[k] = v;
    provenance.privacy = { scrubbed: ext.privacy.scrubbed, findings };
    if (extraction.mode === "live") {
      const total = Object.values(findings).reduce((a, b) => a + b, 0);
      const meta: Record<string, number | boolean> = { scrubbed: ext.privacy.scrubbed, findings: total };
      for (const [k, v] of Object.entries(findings)) meta[`findings_${k}`.slice(0, 60)] = v;
      await emit("privacy", "succeeded", ext.privacy.scrubbed ? `Scrubbed ${total} PII finding(s) before AI` : "Privacy check", { meta });
    }
  }
  const providerLabel = ext.aiProvider ?? extraction.mode;
  await emit(
    "extraction",
    "succeeded",
    extraction.model ? `Extracted facts with ${providerLabel} ${extraction.model}` : `Extracted facts (${providerLabel})`,
    {
      meta: {
        aiProvider: ext.aiProvider ?? null,
        model: extraction.model,
        mode: extraction.mode,
        promptVersion: extraction.promptVersion,
      },
    },
  );

  // v3: the client's rate is frozen into the draft bundle.
  const client = deps.resolveClient ? await deps.resolveClient(appointment) : null;
  const config = { ...baseConfig, rate: effectiveRate(baseConfig.rate, client) };
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
  await emit("assemble", "succeeded", "Assembled draft documents and billing", {
    meta: {
      bundleRevision,
      canApprove: bundle.checks.canApprove,
      blocking: bundle.checks.issues.filter((i) => i.blocking).length,
      issues: bundle.checks.issues.length,
      amountCents: bundle.billing.amountCents ?? bundle.billing.estimateAmountCents ?? null,
      isEstimate: bundle.billing.isEstimate,
      rateVersion: bundle.billing.rateVersion,
      clientRate: client !== null && client.hourlyRateCents !== null,
    },
  });

  // save
  const savedDraft = () => emit("draft_saved", "succeeded", "Draft ready for review", { meta: { bundleRevision } });
  const saved = await repo.saveDraft(bundle, now);
  if (saved.ok) {
    log("workflow.draft_saved", { sessionId, processingRevision: rev, bundleRevision });
    await savedDraft();
    return { status: "NEEDS_REVIEW", bundleRevision };
  }
  const after = await repo.getSession(sessionId);
  if (!after || after.processingRevision !== rev) return { status: "STALE" };
  if (DRAFTED.includes(after.status) && after.currentBundleRevision >= bundleRevision) {
    // A previous attempt already saved this draft.
    await savedDraft();
    return { status: after.status, bundleRevision };
  }
  throw new Error(`saveDraft failed: ${saved.reason}`);
}
