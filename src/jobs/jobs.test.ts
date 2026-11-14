import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Appointment, ApprovalRecord, QueuePayload, SessionRecord, SessionStatus, WorkflowParams } from "../contracts";
import { APPROVAL_EVENT_TYPE, approvalId, deliveryKey, sessionIdFor, workflowInstanceId } from "../contracts";
import type { ConditionalResult, PendingDelivery, Repository } from "../db/repository";
import { discoverSessions, dispatchPendingDeliveries, handleQueueBatch, notifyApproval, type JobDeps } from "./index";

const NOW = new Date("2026-11-13T12:00:00.000Z");

function appt(over: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    occurrenceId: "occ-1",
    providerId: "prov-1",
    clientRef: "client-1",
    startAt: "2026-11-13T09:00:00.000Z",
    endAt: "2026-11-13T10:00:00.000Z",
    timezone: "UTC",
    serviceCode: "svc",
    planVersion: "p1",
    ruleVersion: "r1",
    rateVersion: "rt1",
    canceled: false,
    ...over,
  };
}

// ------------------------------------------------------------------ fakes
class FakeRepo {
  appointments: Appointment[] = [];
  sessions = new Map<string, SessionRecord>();
  deliveries = new Map<string, PendingDelivery>();
  approvals = new Map<string, ApprovalRecord>();
  workflowIds = new Map<string, string>();

  async listDiscoverableAppointments(): Promise<Appointment[]> {
    return this.appointments;
  }
  async ensureSession(a: Appointment, sessionId: string, now: Date) {
    const existing = this.sessions.get(sessionId);
    if (existing) return { session: { ...existing }, created: false };
    const s: SessionRecord = {
      id: sessionId,
      providerId: a.providerId,
      appointmentId: a.id,
      occurrenceId: a.occurrenceId,
      status: "SCHEDULED",
      processingRevision: 0,
      currentBundleRevision: 0,
      workflowId: null,
      statusReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.sessions.set(sessionId, s);
    return { session: { ...s }, created: true };
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async enqueueProcessing(
    sessionId: string,
    allowedFrom: SessionStatus[],
    now: Date,
  ): Promise<ConditionalResult<{ processingRevision: number; deliveryKey: string }>> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found" };
    if (!allowedFrom.includes(s.status)) return { ok: false, reason: "invalid_state" };
    s.processingRevision++;
    s.status = "QUEUED";
    const key = deliveryKey("process_session", sessionId, s.processingRevision);
    this.deliveries.set(key, {
      deliveryKey: key,
      operation: "process_session",
      sessionId,
      revision: s.processingRevision,
      payload: { sessionId, processingRevision: s.processingRevision },
      attempts: 0,
      nextAttemptAt: now.toISOString(),
      status: "pending",
      lastError: null,
    });
    return { ok: true, value: { processingRevision: s.processingRevision, deliveryKey: key } };
  }
  async setWorkflowId(sessionId: string, _rev: number, wfId: string) {
    this.workflowIds.set(sessionId, wfId);
  }
  async claimDueDeliveries(now: Date, limit: number) {
    const out: PendingDelivery[] = [];
    for (const d of this.deliveries.values()) {
      if (out.length >= limit) break;
      if (d.status === "pending" && d.nextAttemptAt <= now.toISOString()) {
        d.attempts++;
        out.push({ ...d });
      }
    }
    return out;
  }
  async completeDelivery(key: string) {
    const d = this.deliveries.get(key);
    if (d) d.status = "done";
  }
  async failDelivery(key: string, error: string, now: Date, maxAttempts: number) {
    const d = this.deliveries.get(key)!;
    d.lastError = error;
    if (d.attempts >= maxAttempts) d.status = "exhausted";
    else d.nextAttemptAt = now.toISOString(); // no backoff in the fake
    return d.status;
  }
  async getDelivery(key: string) {
    return this.deliveries.get(key) ?? null;
  }
  async getApprovalForSession(sessionId: string) {
    return this.approvals.get(sessionId) ?? null;
  }
  async listApprovedUnfinalized(limit: number) {
    return [...this.approvals.values()]
      .filter((a) => a.finalizationStatus === "pending" && this.sessions.get(a.sessionId)?.status === "APPROVED")
      .slice(0, limit);
  }

  /** Test helper: an approved session with a pending notification delivery. */
  addApproval(sessionId: string, processingRevision: number, bundleRevision: number) {
    this.sessions.set(sessionId, {
      id: sessionId,
      providerId: "prov-1",
      appointmentId: "appt-x",
      occurrenceId: "occ-x",
      status: "APPROVED",
      processingRevision,
      currentBundleRevision: bundleRevision,
      workflowId: workflowInstanceId(sessionId, processingRevision),
      statusReason: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const approval: ApprovalRecord = {
      id: approvalId(sessionId, bundleRevision),
      sessionId,
      bundleRevision,
      approverProviderId: "prov-1",
      approvedAt: NOW.toISOString(),
      idempotencyKey: "idem-key-0001",
      requestFingerprint: "fp",
      finalizationStatus: "pending",
    };
    this.approvals.set(sessionId, approval);
    const key = deliveryKey("approval_notification", sessionId, bundleRevision);
    this.deliveries.set(key, {
      deliveryKey: key,
      operation: "approval_notification",
      sessionId,
      revision: bundleRevision,
      payload: { approvalId: approval.id, sessionId, bundleRevision },
      attempts: 0,
      nextAttemptAt: NOW.toISOString(),
      status: "pending",
      lastError: null,
    });
    return approval;
  }
}

class FakeQueue {
  sent: QueuePayload[] = [];
  failNext = 0;
  async send(body: QueuePayload) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("queue unavailable");
    }
    this.sent.push(body);
    return { metadata: {} };
  }
}

class FakeWorkflow {
  instances = new Map<string, WorkflowParams>();
  events: { id: string; event: { type: string; payload: unknown } }[] = [];
  createCalls = 0;
  failSendEvent = 0;
  async create(opts: { id: string; params: WorkflowParams }) {
    this.createCalls++;
    if (this.instances.has(opts.id)) throw new Error(`instance.already_exists: Workflow instance ${opts.id} already exists`);
    this.instances.set(opts.id, opts.params);
    return { id: opts.id };
  }
  async get(id: string) {
    if (!this.instances.has(id)) throw new Error("instance.not_found");
    return {
      id,
      sendEvent: async (event: { type: string; payload: unknown }) => {
        if (this.failSendEvent > 0) {
          this.failSendEvent--;
          throw new Error("event send failed");
        }
        this.events.push({ id, event });
      },
    };
  }
}

function makeMsg(body: unknown, id = "m1") {
  return { id, timestamp: NOW, body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}
function batchOf(...msgs: ReturnType<typeof makeMsg>[]) {
  return { messages: msgs, queue: "q", metadata: {}, retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>;
}

let repo: FakeRepo;
let queue: FakeQueue;
let workflow: FakeWorkflow;
let deps: JobDeps;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  repo = new FakeRepo();
  queue = new FakeQueue();
  workflow = new FakeWorkflow();
  deps = {
    repo: repo as unknown as Repository,
    queue: queue as unknown as Queue<QueuePayload>,
    workflow: workflow as unknown as Workflow<WorkflowParams>,
    clock: { now: () => NOW },
  };
});

// ------------------------------------------------------------------ tests
describe("discoverSessions", () => {
  it("repeated discovery yields one session and one enqueue", async () => {
    repo.appointments = [appt()];
    const first = await discoverSessions(deps);
    const second = await discoverSessions(deps);
    expect(first).toEqual({ examined: 1, created: 1, enqueued: 1, skipped: 0 });
    expect(second).toEqual({ examined: 1, created: 0, enqueued: 0, skipped: 1 });
    expect(repo.sessions.size).toBe(1);
    const sid = await sessionIdFor("prov-1", "occ-1");
    expect(queue.sent).toEqual([{ schemaVersion: "1", sessionId: sid, processingRevision: 1 }]);
    expect(repo.deliveries.get(deliveryKey("process_session", sid, 1))?.status).toBe("done");
  });

  it("does not re-enqueue terminal/in-flight statuses", async () => {
    repo.appointments = [appt()];
    const sid = await sessionIdFor("prov-1", "occ-1");
    await repo.ensureSession(appt(), sid, NOW);
    for (const status of ["FAILED", "PROCESSING", "AMBIGUOUS_MATCH", "COMPLETED"] as const) {
      repo.sessions.get(sid)!.status = status;
      const s = await discoverSessions(deps);
      expect(s.enqueued).toBe(0);
    }
    expect(queue.sent).toHaveLength(0);
  });

  it("re-enqueues NO_EVIDENCE with a new revision", async () => {
    repo.appointments = [appt()];
    await discoverSessions(deps);
    const sid = await sessionIdFor("prov-1", "occ-1");
    repo.sessions.get(sid)!.status = "NO_EVIDENCE";
    await discoverSessions(deps);
    expect(queue.sent.map((m) => m.processingRevision)).toEqual([1, 2]);
  });

  it("queue send failure leaves delivery pending; dispatch sends it", async () => {
    repo.appointments = [appt()];
    queue.failNext = 1;
    const s = await discoverSessions(deps);
    expect(s.enqueued).toBe(1);
    const sid = await sessionIdFor("prov-1", "occ-1");
    const key = deliveryKey("process_session", sid, 1);
    expect(repo.deliveries.get(key)?.status).toBe("pending");
    expect(queue.sent).toHaveLength(0);

    const d = await dispatchPendingDeliveries(deps);
    expect(d).toEqual({ attempted: 1, succeeded: 1, failed: 0, exhausted: 0 });
    expect(repo.deliveries.get(key)?.status).toBe("done");
    expect(queue.sent).toEqual([{ schemaVersion: "1", sessionId: sid, processingRevision: 1 }]);
  });
});

describe("handleQueueBatch", () => {
  async function queuedSession() {
    repo.appointments = [appt()];
    await discoverSessions(deps);
    return queue.sent[0]!;
  }

  it("duplicate message starts one workflow; both acked", async () => {
    const payload = await queuedSession();
    const m1 = makeMsg(payload, "m1");
    const m2 = makeMsg(payload, "m2");
    await handleQueueBatch(batchOf(m1), deps);
    await handleQueueBatch(batchOf(m2), deps);
    expect(workflow.createCalls).toBe(2);
    expect(workflow.instances.size).toBe(1);
    const wfId = workflowInstanceId(payload.sessionId, 1);
    expect(workflow.instances.get(wfId)).toEqual(payload);
    expect(repo.workflowIds.get(payload.sessionId)).toBe(wfId);
    expect(m1.ack).toHaveBeenCalled();
    expect(m2.ack).toHaveBeenCalled();
    expect(m1.retry).not.toHaveBeenCalled();
    expect(m2.retry).not.toHaveBeenCalled();
  });

  it("invalid payload is acked without side effects", async () => {
    const bad = [makeMsg({ sessionId: "x" }, "a"), makeMsg("junk", "b"), makeMsg({ schemaVersion: "1", sessionId: "s", processingRevision: 1, extra: "transcript" }, "c")];
    await handleQueueBatch(batchOf(...bad), deps);
    for (const m of bad) {
      expect(m.ack).toHaveBeenCalled();
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(workflow.createCalls).toBe(0);
  });

  it("stale processing revision is acked without creating a workflow", async () => {
    const payload = await queuedSession();
    repo.sessions.get(payload.sessionId)!.processingRevision = 2;
    const m = makeMsg(payload);
    await handleQueueBatch(batchOf(m), deps);
    expect(m.ack).toHaveBeenCalled();
    expect(workflow.createCalls).toBe(0);
  });

  it("transient workflow error retries the message", async () => {
    const payload = await queuedSession();
    workflow.create = async () => {
      throw new Error("internal error");
    };
    const m = makeMsg(payload);
    await handleQueueBatch(batchOf(m), deps);
    expect(m.retry).toHaveBeenCalled();
    expect(m.ack).not.toHaveBeenCalled();
  });
});

describe("approval notification", () => {
  function approvedSession() {
    const sid = "sess_approved";
    workflow.instances.set(workflowInstanceId(sid, 1), { schemaVersion: "1", sessionId: sid, processingRevision: 1 });
    return repo.addApproval(sid, 1, 3);
  }

  it("notifyApproval sends the approval event to the revision's workflow", async () => {
    const approval = approvedSession();
    await notifyApproval(deps, approval);
    expect(workflow.events).toEqual([
      {
        id: workflowInstanceId(approval.sessionId, 1),
        event: { type: APPROVAL_EVENT_TYPE, payload: { approvalId: approval.id, sessionId: approval.sessionId, bundleRevision: 3 } },
      },
    ]);
  });

  it("notification failure -> failDelivery, then success on retry", async () => {
    const approval = approvedSession();
    const key = deliveryKey("approval_notification", approval.sessionId, 3);
    workflow.failSendEvent = 1;
    const first = await dispatchPendingDeliveries(deps);
    expect(first).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, exhausted: 0 });
    expect(repo.deliveries.get(key)).toMatchObject({ status: "pending", attempts: 1 });
    expect(repo.deliveries.get(key)?.lastError).toContain("event send failed");

    const second = await dispatchPendingDeliveries(deps);
    expect(second.succeeded).toBeGreaterThanOrEqual(1);
    expect(repo.deliveries.get(key)?.status).toBe("done");
    expect(workflow.events.length).toBeGreaterThanOrEqual(1);
  });

  it("delivery exhausted after maxAttempts", async () => {
    const approval = approvedSession();
    const key = deliveryKey("approval_notification", approval.sessionId, 3);
    deps.maxAttempts = 3;
    workflow.failSendEvent = 100;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await dispatchPendingDeliveries(deps));
    expect(results.map((r) => r.failed)).toEqual([1, 1, 0, 0]);
    expect(results.map((r) => r.exhausted)).toEqual([0, 0, 1, 0]);
    expect(repo.deliveries.get(key)).toMatchObject({ status: "exhausted", attempts: 3 });
  });

  it("reconciliation resends when delivered but still unfinalized", async () => {
    const approval = approvedSession();
    const key = deliveryKey("approval_notification", approval.sessionId, 3);
    const first = await dispatchPendingDeliveries(deps);
    // delivered; not re-sent in the same pass
    expect(repo.deliveries.get(key)?.status).toBe("done");
    expect(first).toEqual({ attempted: 1, succeeded: 1, failed: 0, exhausted: 0 });
    expect(workflow.events).toHaveLength(1);

    const second = await dispatchPendingDeliveries(deps);
    expect(second).toEqual({ attempted: 1, succeeded: 1, failed: 0, exhausted: 0 });
    expect(workflow.events).toHaveLength(2);

    // finalized -> no more resends
    repo.approvals.get(approval.sessionId)!.finalizationStatus = "finalized";
    const third = await dispatchPendingDeliveries(deps);
    expect(third.attempted).toBe(0);
    expect(workflow.events).toHaveLength(2);
  });

  it("reconciliation skips approvals whose delivery is still pending or exhausted", async () => {
    const approval = approvedSession();
    const key = deliveryKey("approval_notification", approval.sessionId, 3);
    repo.deliveries.get(key)!.status = "exhausted";
    const r = await dispatchPendingDeliveries(deps);
    expect(r.attempted).toBe(0);
    expect(workflow.events).toHaveLength(0);
  });
});

describe("run history (v3)", () => {
  type Rec = Parameters<import("../contracts").RunRecorder["record"]>[0];
  function fakeRecorder() {
    const events: Rec[] = [];
    return { events, record: async (e: Rec) => void events.push(e) };
  }

  it("discovery emits discovered (new session) + queued with the workflow run id", async () => {
    const rec = fakeRecorder();
    deps.recorder = rec;
    repo.appointments = [appt()];
    await discoverSessions(deps);
    const sid = await sessionIdFor("prov-1", "occ-1");
    const runId = workflowInstanceId(sid, 1);
    expect(rec.events.map((e) => [e.stage, e.status, e.runId])).toEqual([
      ["discovered", "succeeded", runId],
      ["queued", "succeeded", runId],
    ]);
    expect(rec.events.every((e) => e.providerId === "prov-1" && e.sessionId === sid && e.runKind === "processing")).toBe(true);

    // Re-discovery of a known, in-flight session emits nothing new.
    await discoverSessions(deps);
    expect(rec.events).toHaveLength(2);

    // Re-enqueue emits queued for the new revision only.
    repo.sessions.get(sid)!.status = "NO_EVIDENCE";
    await discoverSessions(deps);
    expect(rec.events.slice(2).map((e) => [e.stage, e.runId])).toEqual([["queued", workflowInstanceId(sid, 2)]]);
  });

  it("a throwing recorder never fails discovery", async () => {
    deps.recorder = { record: async () => { throw new Error("db down"); } };
    repo.appointments = [appt()];
    const s = await discoverSessions(deps);
    expect(s.enqueued).toBe(1);
  });
});
