/**
 * Jobs (Agent 09): discovery, durable delivery dispatch, approval
 * notification and queue consumption. Handoff §9.6–9.8, §10.2–10.6.
 *
 * Rules:
 * - Durable intent first (repo.enqueueProcessing / persistApproval write the
 *   pending delivery); Queue sends and Workflow events are attempts on top.
 * - Queue messages and workflow events are wake-up hints carrying ids only;
 *   the database is the source of truth.
 * - Logs carry ids, counts and error class names only — never excerpts.
 */
import {
  APPROVAL_EVENT_TYPE,
  QueuePayload,
  deliveryKey,
  sessionIdFor,
  workflowInstanceId,
} from "../contracts";
import type {
  ApprovalRecord,
  Clock,
  DiscoverySummary,
  DispatchSummary,
  SessionStatus,
  WorkflowParams,
} from "../contracts";
import type { PendingDelivery, Repository } from "../db/repository";

export interface JobDeps {
  repo: Repository;
  workflow: Workflow<WorkflowParams>;
  queue: Queue<QueuePayload>;
  clock: Clock;
  lookbackMinutes?: number;
  maxAttempts?: number;
  /** v2: performs an auto drive upload (payload.deliveryId). Injected by the composition root. */
  processFileDelivery?: (deliveryId: string) => Promise<unknown>;
}

export const DEFAULT_LOOKBACK_MINUTES = 7 * 24 * 60;
export const DEFAULT_MAX_ATTEMPTS = 8;
const DISCOVERY_LIMIT = 100;
const DISPATCH_LIMIT = 25;
const RECONCILE_LIMIT = 25;

/** Statuses from which discovery may (re-)enqueue processing. */
export const ENQUEUEABLE_STATUSES: SessionStatus[] = ["SCHEDULED", "WAITING_FOR_EVIDENCE", "NO_EVIDENCE"];

// ------------------------------------------------------------------ logging
function log(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

/** Redacted error description: class name + short, single-line, length-capped message. */
function errKind(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

function errSummary(err: unknown): string {
  const name = errKind(err);
  const msg = err instanceof Error ? err.message : String(err);
  return `${name}: ${msg.replace(/\s+/g, " ").slice(0, 120)}`;
}

function isAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /already exists|already_exists|duplicate|instance\.already|exists already/i.test(msg);
}

function queueMessage(sessionId: string, processingRevision: number): QueuePayload {
  return { schemaVersion: "1", sessionId, processingRevision };
}

// ------------------------------------------------------------------ discovery
/** Shared by cron and manual sync. Idempotent: repeated runs create no duplicates. */
export interface DiscoverOptions {
  /** Restrict discovery to one provider (manual sync, scheduled per-provider runs). */
  providerId?: string;
  /** Overrides deps.lookbackMinutes (e.g. from the provider's sync settings). */
  lookbackMinutes?: number;
}

export async function discoverSessions(deps: JobDeps, opts: DiscoverOptions = {}): Promise<DiscoverySummary> {
  const now = deps.clock.now();
  const lookback = opts.lookbackMinutes ?? deps.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
  const appointments = await deps.repo.listDiscoverableAppointments(now, lookback, DISCOVERY_LIMIT, opts.providerId);
  const summary: DiscoverySummary = { examined: 0, created: 0, enqueued: 0, skipped: 0 };

  for (const appt of appointments) {
    summary.examined++;
    const id = await sessionIdFor(appt.providerId, appt.occurrenceId);
    const { session, created } = await deps.repo.ensureSession(appt, id, now);
    if (created) summary.created++;

    if (!ENQUEUEABLE_STATUSES.includes(session.status)) {
      summary.skipped++;
      continue;
    }
    const res = await deps.repo.enqueueProcessing(session.id, ENQUEUEABLE_STATUSES, now);
    if (!res.ok) {
      // Concurrent discovery / state moved on — nothing to do.
      summary.skipped++;
      continue;
    }
    summary.enqueued++;
    const { processingRevision, deliveryKey: key } = res.value;
    try {
      await deps.queue.send(queueMessage(session.id, processingRevision));
      await deps.repo.completeDelivery(key, deps.clock.now());
    } catch (err) {
      // Durable intent stays pending; dispatchPendingDeliveries retries.
      log("discovery.send_deferred", { sessionId: session.id, processingRevision, error: errKind(err) });
    }
  }
  log("discovery.done", { ...summary });
  return summary;
}

// ------------------------------------------------------------------ notification
/** Wake-up hint to the session's workflow. Throws on failure. */
export async function notifyApproval(deps: JobDeps, approval: ApprovalRecord): Promise<void> {
  const session = await deps.repo.getSession(approval.sessionId);
  if (!session) throw new Error("notifyApproval: session not found");
  const instance = await deps.workflow.get(workflowInstanceId(session.id, session.processingRevision));
  await instance.sendEvent({
    type: APPROVAL_EVENT_TYPE,
    payload: { approvalId: approval.id, sessionId: approval.sessionId, bundleRevision: approval.bundleRevision },
  });
}

// ------------------------------------------------------------------ dispatch
async function deliver(deps: JobDeps, d: PendingDelivery): Promise<void> {
  if (d.operation === "process_session") {
    await deps.queue.send(queueMessage(d.sessionId, d.revision));
    return;
  }
  if (d.operation === "file_delivery") {
    const deliveryId = typeof d.payload.deliveryId === "string" ? d.payload.deliveryId : null;
    if (!deliveryId) throw new Error("file_delivery payload missing deliveryId");
    if (!deps.processFileDelivery) throw new Error("file delivery not wired");
    // Throws on retryable failure -> failDelivery backoff; non-retryable is recorded on the delivery.
    await deps.processFileDelivery(deliveryId);
    return;
  }
  const approval = await deps.repo.getApprovalForSession(d.sessionId);
  if (!approval) throw new Error("approval not found");
  if (approval.bundleRevision !== d.revision) throw new Error("approval revision mismatch");
  if (approval.finalizationStatus === "finalized") return; // nothing left to wake
  await notifyApproval(deps, approval);
}

export async function dispatchPendingDeliveries(deps: JobDeps): Promise<DispatchSummary> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const summary: DispatchSummary = { attempted: 0, succeeded: 0, failed: 0, exhausted: 0 };

  const due = await deps.repo.claimDueDeliveries(deps.clock.now(), DISPATCH_LIMIT);
  const touched = new Set<string>();
  for (const d of due) {
    summary.attempted++;
    touched.add(d.deliveryKey);
    try {
      await deliver(deps, d);
      await deps.repo.completeDelivery(d.deliveryKey, deps.clock.now());
      summary.succeeded++;
    } catch (err) {
      const status = await deps.repo.failDelivery(d.deliveryKey, errSummary(err), deps.clock.now(), maxAttempts);
      if (status === "exhausted") summary.exhausted++;
      else summary.failed++;
      log("dispatch.failed", { deliveryKey: d.deliveryKey, operation: d.operation, attempts: d.attempts, status, error: errKind(err) });
    }
  }

  // Reconcile: approvals whose notification was delivered but which are still
  // unfinalized (e.g. event arrived before the workflow reached its wait).
  // Pending deliveries are handled above; exhausted ones need intervention.
  const unfinalized = await deps.repo.listApprovedUnfinalized(RECONCILE_LIMIT);
  for (const approval of unfinalized) {
    const key = deliveryKey("approval_notification", approval.sessionId, approval.bundleRevision);
    const delivery = await deps.repo.getDelivery(key);
    // Skip ones just attempted in this pass to avoid an immediate double send.
    if (touched.has(key) || !delivery || delivery.status !== "done") continue;
    summary.attempted++;
    try {
      await notifyApproval(deps, approval);
      summary.succeeded++;
    } catch (err) {
      summary.failed++;
      log("reconcile.failed", { sessionId: approval.sessionId, bundleRevision: approval.bundleRevision, error: errKind(err) });
    }
  }

  log("dispatch.done", { ...summary });
  return summary;
}

// ------------------------------------------------------------------ queue consumer
export async function handleQueueBatch(batch: MessageBatch<unknown>, deps: JobDeps): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = QueuePayload.safeParse(msg.body);
    if (!parsed.success) {
      log("queue.invalid_payload", { messageId: msg.id, issues: parsed.error.issues.length });
      msg.ack(); // can never succeed
      continue;
    }
    const { sessionId, processingRevision } = parsed.data;
    try {
      const session = await deps.repo.getSession(sessionId);
      if (!session) {
        log("queue.unknown_session", { messageId: msg.id, sessionId });
        msg.ack();
        continue;
      }
      if (session.processingRevision !== processingRevision) {
        log("queue.stale_revision", { sessionId, processingRevision, current: session.processingRevision });
        msg.ack();
        continue;
      }
      const id = workflowInstanceId(session.id, session.processingRevision);
      const params: WorkflowParams = queueMessage(session.id, session.processingRevision);
      let existed = false;
      try {
        await deps.workflow.create({ id, params });
      } catch (err) {
        if (!isAlreadyExistsError(err)) throw err;
        existed = true;
      }
      await deps.repo.setWorkflowId(session.id, session.processingRevision, id);
      log("queue.workflow_started", { sessionId, processingRevision, existed });
      msg.ack();
    } catch (err) {
      log("queue.retry", { messageId: msg.id, sessionId, processingRevision, error: errKind(err) });
      msg.retry();
    }
  }
}


/**
 * Scheduled heartbeat entry point. Runs discovery only for providers whose
 * own (user-controlled) sync interval is due, then records the run.
 * Delivery recovery (dispatchPendingDeliveries) is NOT governed by these
 * settings — the caller always runs it, so approvals still finalize even
 * when a provider turns automatic sync off.
 */
export async function runScheduledSync(
  deps: JobDeps,
): Promise<DiscoverySummary & { providersRun: number }> {
  const due = await deps.repo.listProvidersDueForSync(deps.clock.now(), 200);
  const total = { examined: 0, created: 0, enqueued: 0, skipped: 0, providersRun: 0 };
  for (const { providerId, settings } of due) {
    try {
      const s = await discoverSessions(deps, { providerId, lookbackMinutes: settings.lookbackDays * 24 * 60 });
      total.examined += s.examined;
      total.created += s.created;
      total.enqueued += s.enqueued;
      total.skipped += s.skipped;
      total.providersRun++;
      await deps.repo.markSyncRun(providerId, deps.clock.now());
    } catch (err) {
      // One provider's failure must not block the others; it stays due and retries next heartbeat.
      log("scheduled_sync.provider_failed", { providerId, error: errKind(err) });
    }
  }
  log("scheduled_sync.done", { ...total, due: due.length });
  return total;
}
