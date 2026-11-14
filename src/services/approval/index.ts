/**
 * Review + approval service (Agent 16, handoff §10.5 / §16.5).
 *
 * - Actor identity always comes from the authenticated context, never the body.
 * - Edits are allowlisted (ReviewEdits) and recorded as provider attestations.
 * - Approval binds an exact bundle revision; persistence is atomic in the repo
 *   (approval + state transition + notification intent), notification is best-effort.
 */
import {
  approvalId,
  sha256Hex,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApproveResponse,
  type ProviderAttestation,
  type ReviewRequest,
  type SessionBundle,
  type SessionRecord,
} from "../../contracts";
import type { ConditionalResult } from "../../db/repository";
import type { Actor, ApiDeps } from "../../api/deps";
import { log } from "../../security/index";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export type ApprovalDeps = Pick<ApiDeps, "repo" | "clock" | "assemble" | "notifyApproval">;

function notFound(): ServiceError {
  return new ServiceError(404, "NOT_FOUND", "Session not found", false);
}

async function loadScoped(deps: Pick<ApiDeps, "repo">, actor: Actor, sessionId: string): Promise<SessionRecord> {
  const session = await deps.repo.getSessionForProvider(actor.providerId, sessionId);
  if (!session) throw notFound();
  return session;
}

function conditionalError(r: Extract<ConditionalResult<unknown>, { ok: false }>): ServiceError {
  switch (r.reason) {
    case "not_found":
      return notFound();
    case "stale_revision":
      return new ServiceError(409, "STALE_REVISION", "The bundle revision is no longer current", false);
    case "invalid_state":
      return new ServiceError(409, "INVALID_STATE", "Session is not in a reviewable state", false);
    case "conflict":
      return new ServiceError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", false);
  }
}

function requireReviewable(session: SessionRecord, expectedRevision: number): void {
  if (session.status !== "NEEDS_REVIEW") {
    throw new ServiceError(409, "INVALID_STATE", `Session is ${session.status}; edits and approval require NEEDS_REVIEW`, false);
  }
  if (session.currentBundleRevision !== expectedRevision) {
    throw new ServiceError(409, "STALE_REVISION", "The bundle revision is no longer current", false);
  }
}

export async function saveReview(
  deps: ApprovalDeps,
  actor: Actor,
  sessionId: string,
  req: ReviewRequest,
): Promise<SessionBundle> {
  const session = await loadScoped(deps, actor, sessionId);
  requireReviewable(session, req.expectedRevision);

  const current = await deps.repo.getBundle(sessionId, req.expectedRevision);
  if (!current) throw new ServiceError(409, "STALE_REVISION", "The bundle revision is no longer current", false);

  const now = deps.clock.now();
  const attestedAt = now.toISOString();
  const newRev = req.expectedRevision + 1;

  const fresh: ProviderAttestation[] = [];
  const mk = (field: ProviderAttestation["field"], text: string): ProviderAttestation => ({
    id: `att-${sessionId}-r${newRev}-${field}`,
    field,
    text,
    actorProviderId: actor.providerId,
    attestedAt,
    bundleRevision: newRev,
  });
  if (req.edits.progressConfirmation !== undefined) fresh.push(mk("progress", req.edits.progressConfirmation));
  if (req.edits.confirmedMinutes !== undefined) fresh.push(mk("duration", String(req.edits.confirmedMinutes)));
  if (req.edits.participantDirected !== undefined) fresh.push(mk("participant_direction", req.edits.participantDirected ? "yes" : "no"));
  if (req.edits.participantChoices !== undefined) fresh.push(mk("participant_choices", req.edits.participantChoices));
  if (req.edits.activitySummary !== undefined) fresh.push(mk("activity_summary", req.edits.activitySummary));

  const superseded = new Set<ProviderAttestation["field"]>(fresh.map((a) => a.field));
  if (req.edits.goalsAddressed !== undefined) {
    // Strict: only goal ids from this session's frozen plan. One attestation per confirmed goal;
    // the list replaces any earlier confirmation ([] clears it).
    const planGoals = new Set(current.config.plan.goals.map((g) => g.goalId));
    const unknown = req.edits.goalsAddressed.filter((id) => !planGoals.has(id));
    if (unknown.length > 0) {
      throw new ServiceError(422, "UNKNOWN_GOAL", "goalsAddressed may only contain goal ids from this session's plan.", false, {
        unknownGoalIds: unknown.slice(0, 20),
      });
    }
    superseded.add("goal_addressed");
    req.edits.goalsAddressed.forEach((goalId, i) =>
      fresh.push({ ...mk("goal_addressed", goalId), id: `att-${sessionId}-r${newRev}-goal_addressed-${i + 1}` }),
    );
  }
  const attestations = [...current.attestations.filter((a) => !superseded.has(a.field)), ...fresh];

  // Duration must also respect the frozen rate's own maximum (may be < schema max).
  if (req.edits.confirmedMinutes !== undefined && req.edits.confirmedMinutes > current.config.rate.maxMinutes) {
    throw new ServiceError(422, "DURATION_OUT_OF_RANGE", `Confirmed duration must be at most ${current.config.rate.maxMinutes} minutes.`);
  }

  const bundle = deps.assemble({
    sessionId,
    bundleRevision: newRev,
    processingRevision: current.processingRevision,
    appointment: current.appointment,
    config: current.config,
    evidence: current.evidence,
    evidenceWindow: current.evidenceWindow,
    facts: current.extractedFacts,
    attestations,
    provenance: current.provenance,
    createdAt: attestedAt,
  });

  const saved = await deps.repo.saveReviewRevision(sessionId, req.expectedRevision, bundle, now);
  if (!saved.ok) throw conditionalError(saved);
  return saved.value;
}

async function tryNotify(deps: ApprovalDeps, approval: ApprovalRecord): Promise<void> {
  try {
    await deps.notifyApproval(approval);
  } catch (err) {
    // Redacted: ids only. The durable pending delivery is retried by dispatch.
    log("warn", "approval.notify_failed", {
      sessionId: approval.sessionId,
      approvalId: approval.id,
      bundleRevision: approval.bundleRevision,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

export async function approveSession(
  deps: ApprovalDeps,
  actor: Actor,
  sessionId: string,
  req: ApprovalRequest,
): Promise<ApproveResponse> {
  const session = await loadScoped(deps, actor, sessionId);

  const existing = await deps.repo.getApprovalByKey(req.idempotencyKey);
  if (existing) {
    if (existing.sessionId === sessionId && existing.bundleRevision === req.expectedRevision) {
      if (existing.finalizationStatus === "pending") await tryNotify(deps, existing);
      return { approval: existing, finalization: existing.finalizationStatus };
    }
    throw new ServiceError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request", false);
  }

  requireReviewable(session, req.expectedRevision);
  const bundle = await deps.repo.getBundle(sessionId, req.expectedRevision);
  if (!bundle) throw new ServiceError(409, "STALE_REVISION", "The bundle revision is no longer current", false);

  if (!bundle.checks.canApprove) {
    const blocking = bundle.checks.issues.filter((i) => i.blocking);
    throw new ServiceError(422, "DOCUMENTATION_BLOCKERS", "Unresolved documentation blockers", false, blocking);
  }
  const { confirmedMinutes, amountCents } = bundle.billing;
  if (confirmedMinutes === null || amountCents === null) {
    throw new ServiceError(422, "DURATION_NOT_CONFIRMED", "Confirmed duration is required before approval", false);
  }

  const now = deps.clock.now();
  const rev = req.expectedRevision;
  const approval: ApprovalRecord = {
    id: approvalId(sessionId, rev),
    sessionId,
    bundleRevision: rev,
    approverProviderId: actor.providerId,
    approvedAt: now.toISOString(),
    idempotencyKey: req.idempotencyKey,
    requestFingerprint: await sha256Hex(`${sessionId}|${rev}|${actor.providerId}|${amountCents}`),
    finalizationStatus: "pending",
  };

  const persisted = await deps.repo.persistApproval(
    {
      approval,
      expectedBundleRevision: rev,
      notificationPayload: { approvalId: approval.id, sessionId, bundleRevision: rev },
    },
    now,
  );
  if (!persisted.ok) throw conditionalError(persisted);

  const stored = persisted.value.approval;
  if (stored.finalizationStatus === "pending") await tryNotify(deps, stored);
  return { approval: stored, finalization: stored.finalizationStatus };
}
