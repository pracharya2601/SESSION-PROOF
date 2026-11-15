/**
 * Amendments (Agent 01): reopen a COMPLETED session as a new revision that must be
 * re-approved. The previously approved final bundle is kept (superseded_finals),
 * never mutated. The new revision starts from the approved bundle (same extracted
 * facts, evidence, frozen rate and attestations) plus an `amendment_reason`
 * attestation, then goes through the normal review → approve path.
 *
 * Finalization of an amended revision: the session's original Workflow has already
 * completed, so there is nothing waiting for the approval event. `finalizeDirect`
 * performs the same durable steps the Workflow does (client snapshot → finalize →
 * completion hook) and is idempotent; jobs.notifyApproval uses it when no live
 * workflow instance exists.
 */
import { assignInvoiceNumber } from "../profile/index";
import { AmendRequest, type ApprovalRecord, type ClientRecord, type Appointment, type RunRecorder, type SessionBundle, workflowInstanceId } from "../../contracts";
import type { Repository } from "../../db/repository";
import type { Actor, ApiDeps } from "../../api/deps";
import { ServiceError } from "./index";
import { snapshotClient } from "../../clients";
import { safeRecord } from "../../history";

export type AmendDeps = Pick<ApiDeps, "repo" | "clock" | "assemble" | "recorder">;

export async function amendSession(deps: AmendDeps, actor: Actor, sessionId: string, input: AmendRequest): Promise<SessionBundle> {
  const req = AmendRequest.parse(input);
  const session = await deps.repo.getSessionForProvider(actor.providerId, sessionId);
  if (!session) throw new ServiceError(404, "NOT_FOUND", "Session not found", false);
  if (session.status !== "COMPLETED") {
    throw new ServiceError(409, "INVALID_STATE", "Only completed (approved and finalized) sessions can be amended", false);
  }
  const final = await deps.repo.getFinalBundle(sessionId);
  if (!final || final.bundleRevision !== req.expectedRevision || session.currentBundleRevision !== req.expectedRevision) {
    throw new ServiceError(409, "STALE_REVISION", "The approved revision changed — reload and try again", false);
  }

  const now = deps.clock.now();
  const approved = final.bundle;
  const newRev = req.expectedRevision + 1;
  const attestations = [
    ...approved.attestations.filter((a) => a.field !== "amendment_reason"),
    {
      id: `att-${sessionId}-r${newRev}-amendment_reason`,
      field: "amendment_reason" as const,
      text: req.reason,
      actorProviderId: actor.providerId,
      attestedAt: now.toISOString(),
      bundleRevision: newRev,
    },
  ];
  const bundle = deps.assemble({
    sessionId,
    bundleRevision: newRev,
    processingRevision: approved.processingRevision,
    appointment: approved.appointment,
    config: approved.config, // rate stays frozen at the originally approved rate
    evidence: approved.evidence,
    evidenceWindow: approved.evidenceWindow,
    facts: approved.extractedFacts,
    attestations,
    provenance: approved.provenance,
    createdAt: now.toISOString(),
  });

  const res = await deps.repo.amendSession(sessionId, req.expectedRevision, bundle, req.reason, actor.providerId, now);
  if (!res.ok) {
    if (res.reason === "not_found") throw new ServiceError(404, "NOT_FOUND", "Session not found", false);
    if (res.reason === "stale_revision" || res.reason === "conflict") {
      throw new ServiceError(409, "STALE_REVISION", "The approved revision changed — reload and try again", false);
    }
    throw new ServiceError(409, "INVALID_STATE", "Session can no longer be amended", false);
  }
  await safeRecord(deps.recorder, {
    runId: workflowInstanceId(sessionId, approved.processingRevision),
    runKind: "processing",
    sessionId,
    providerId: actor.providerId,
    stage: "amended",
    status: "info",
    idSuffix: `r${newRev}`,
    label: `Reopened approved revision r${req.expectedRevision} as r${newRev} for amendment`,
    detail: null, // reason is free text; kept out of history
    meta: { fromRevision: req.expectedRevision, toRevision: newRev },
  });
  return res.value;
}

export interface FinalizeDirectDeps {
  repo: Repository;
  clock: { now(): Date };
  recorder?: RunRecorder;
  resolveClient?: (appointment: Appointment) => Promise<ClientRecord | null>;
  onCompleted?: (sessionId: string) => Promise<unknown>;
}

/** Finalize an approved revision without a live Workflow (amendments). Idempotent. */
export async function finalizeDirect(deps: FinalizeDirectDeps, approval: ApprovalRecord): Promise<void> {
  const session = await deps.repo.getSession(approval.sessionId);
  if (!session) throw new Error("session not found");
  const existing = await deps.repo.getFinalBundle(approval.sessionId);
  if (existing && existing.approvalId === approval.id) return; // already done
  const bundle = await deps.repo.getBundle(approval.sessionId, approval.bundleRevision);
  if (!bundle) throw new Error("approved bundle not found");
  const runId = workflowInstanceId(session.id, session.processingRevision);
  const base = { runId, runKind: "processing" as const, sessionId: session.id, providerId: session.providerId };

  if (deps.resolveClient && !(await deps.repo.getClientSnapshot(session.id, approval.bundleRevision))) {
    const client = await deps.resolveClient(bundle.appointment);
    if (client) {
      await deps.repo.saveClientSnapshot(session.id, approval.bundleRevision, snapshotClient(client, bundle.config.rate, deps.clock.now()));
      await safeRecord(deps.recorder, { ...base, stage: "client_snapshot", status: "succeeded", idSuffix: `r${approval.bundleRevision}`, label: "Client details frozen for this revision", detail: null, meta: { bundleRevision: approval.bundleRevision } });
    }
  }
  await assignInvoiceNumber(deps.repo, session.providerId, session.id, approval.bundleRevision, deps.clock.now());
  const res = await deps.repo.finalizeApproved(session.id, approval.id, approval.bundleRevision, deps.clock.now());
  if (!res.ok) {
    const again = await deps.repo.getFinalBundle(session.id);
    if (!(again && again.approvalId === approval.id)) throw new Error(`finalize failed: ${res.reason}`);
  }
  const meta = { bundleRevision: approval.bundleRevision };
  await safeRecord(deps.recorder, { ...base, stage: "finalize", status: "succeeded", idSuffix: `r${approval.bundleRevision}`, label: "Finalized amended revision", detail: null, meta });
  await safeRecord(deps.recorder, { ...base, stage: "files", status: "succeeded", idSuffix: `r${approval.bundleRevision}`, label: "Session Note, Invoice and Approval Record ready", detail: null, meta: { ...meta, files: 3 } });
  await safeRecord(deps.recorder, { ...base, stage: "completed", status: "succeeded", idSuffix: `r${approval.bundleRevision}`, label: "Amended session completed", detail: null, meta });
  if (deps.onCompleted) {
    try {
      await deps.onCompleted(session.id);
    } catch {
      /* completion is final; hook failures are not retried here */
    }
  }
}
