import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvalId,
  deliveryKey,
  sessionIdFor,
  SessionBundle,
  type ApprovalRecord,
  type Appointment,
} from "../../src/contracts";
import { createRepository, backoffMs } from "../../src/db/d1";
import type { Repository } from "../../src/db/repository";
import {
  DEMO_PROVIDER_ID,
  DEMO_PROVIDER_IDENTITY,
  OTHER_PROVIDER_ID,
  demoAppointment,
  demoConfig,
  demoEvidence,
  demoFacts,
} from "../../fixtures/scenario";

// 0001 plus 0013 (archive: ensureSession / discovery consult dismissed_events).
const MIGRATION = ["0001_init.sql", "0013_archive.sql"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url)), "utf8"))
  .join("\n");
const NOW = new Date("2026-11-13T20:00:00.000Z");

const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
afterAll(() => mf.dispose());

const TABLES = [
  "oauth_connections", "pending_deliveries", "final_bundles", "approvals", "bundles",
  "evidence", "sessions", "appointments", "service_configs", "providers",
  "archived_items", "dismissed_events", "audit_log",
];

async function freshDb(): Promise<D1Database> {
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const t of TABLES) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  const stmts = MIGRATION.split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(stmts.map((s) => db.prepare(s)));
  return db;
}

function makeBundle(sessionId: string, bundleRevision: number, processingRevision: number, opts: { confirmedMinutes?: number | null } = {}): SessionBundle {
  const confirmed = opts.confirmedMinutes ?? null;
  return SessionBundle.parse({
    sessionId,
    bundleRevision,
    processingRevision,
    appointment: demoAppointment,
    config: demoConfig,
    evidence: demoEvidence,
    evidenceWindow: { from: "2026-11-13T18:05:00.000Z", to: "2026-11-13T18:53:00.000Z" },
    extractedFacts: demoFacts,
    facts: demoFacts,
    attestations: [],
    documents: {
      sections: [{ key: "session_note", title: "Session note", lines: [{ text: "Practiced route planning.", claimIds: ["fact_act_1"], evidenceIds: ["ev_001"], attestationIds: [], origin: "extracted" }] }],
      planCoverage: [{ goalId: "goal_transport", objective: "Practice transportation planning.", status: "addressed", claimIds: ["fact_goal_1"] }],
      timeSummary: {
        scheduledFrom: demoAppointment.startAt,
        scheduledTo: demoAppointment.endAt,
        scheduledMinutes: 60,
        evidenceWindowFrom: "2026-11-13T18:05:00.000Z",
        evidenceWindowTo: "2026-11-13T18:53:00.000Z",
        evidenceWindowMinutes: 48,
        confirmedMinutes: confirmed,
        timezone: demoAppointment.timezone,
      },
    },
    checks: { ruleVersion: "rules_demo_v1", issues: [], canApprove: confirmed !== null },
    billing: {
      currency: "USD",
      hourlyRateCents: 7500,
      scheduledMinutes: 60,
      confirmedMinutes: confirmed,
      amountCents: confirmed === null ? null : Math.round((7500 * confirmed) / 60),
      estimateAmountCents: 7500,
      isEstimate: confirmed === null,
      rateVersion: "rate_demo_v1",
      rounding: "half_up_to_cent",
      breakdown: "test",
    },
    provenance: {
      evidenceMode: "fixture",
      extractionMode: "fixture",
      runtimeMode: "local",
      schemaVersion: "1",
      promptVersion: "test",
      model: null,
      evidenceCompleteness: "complete",
      evidenceWarnings: [],
    },
    createdAt: NOW.toISOString(),
  });
}

function makeApproval(sessionId: string, rev: number, key: string, fingerprint = "fp-1"): ApprovalRecord {
  return {
    id: approvalId(sessionId, rev),
    sessionId,
    bundleRevision: rev,
    approverProviderId: DEMO_PROVIDER_ID,
    approvedAt: NOW.toISOString(),
    idempotencyKey: key,
    requestFingerprint: fingerprint,
    finalizationStatus: "pending",
  };
}

let db: D1Database;
let repo: Repository;
let sessionId: string;

async function count(table: string, where = "1=1", ...params: unknown[]): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...params).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Drive a session to NEEDS_REVIEW at bundle revision 1. */
async function toNeedsReview(confirmedMinutes: number | null = 60): Promise<void> {
  await repo.ensureSession(demoAppointment, sessionId, NOW);
  const q = await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE"], NOW);
  expect(q.ok).toBe(true);
  expect((await repo.transitionSession(sessionId, ["QUEUED"], "PROCESSING", null, NOW)).ok).toBe(true);
  const d = await repo.saveDraft(makeBundle(sessionId, 1, 1, { confirmedMinutes }), NOW);
  expect(d.ok).toBe(true);
}

beforeEach(async () => {
  db = await freshDb();
  repo = createRepository(db);
  sessionId = await sessionIdFor(DEMO_PROVIDER_ID, demoAppointment.occurrenceId);
  await repo.upsertProvider(DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY);
  await repo.upsertServiceConfig("DEMO-ILS", demoConfig);
  await repo.upsertAppointment(demoAppointment);
});

describe("providers, config, appointments", () => {
  it("maps identity, round-trips config and appointments", async () => {
    expect(await repo.findProviderByIdentity(DEMO_PROVIDER_IDENTITY)).toBe(DEMO_PROVIDER_ID);
    expect(await repo.findProviderByIdentity("nobody@example.invalid")).toBeNull();
    expect(await repo.getServiceConfig("plan_demo_v1", "rules_demo_v1", "rate_demo_v1")).toEqual(demoConfig);
    expect(await repo.getServiceConfig("plan_demo_v1", "rules_demo_v1", "rate_x")).toBeNull();
    expect(await repo.getAppointment(demoAppointment.id)).toEqual(demoAppointment);
  });

  it("discovers completed appointments in the lookback window and lists overlaps", async () => {
    const canceled: Appointment = { ...demoAppointment, id: "appt_c", occurrenceId: "occ_c", canceled: true };
    const future: Appointment = { ...demoAppointment, id: "appt_f", occurrenceId: "occ_f", startAt: "2026-11-13T21:00:00.000Z", endAt: "2026-11-13T22:00:00.000Z" };
    await repo.upsertAppointment(canceled);
    await repo.upsertAppointment(future);
    expect((await repo.listDiscoverableAppointments(NOW, 120, 10)).map((a) => a.id)).toEqual([demoAppointment.id]);
    expect(await repo.listDiscoverableAppointments(NOW, 30, 10)).toEqual([]);
    const overlap = await repo.listProviderAppointmentsOverlapping(DEMO_PROVIDER_ID, "2026-11-13T18:30:00.000Z", "2026-11-13T21:30:00.000Z");
    expect(overlap.map((a) => a.id)).toEqual([demoAppointment.id, "appt_f"]);
    expect(await repo.listProviderAppointmentsOverlapping(OTHER_PROVIDER_ID, "2026-11-13T18:30:00.000Z", "2026-11-13T21:30:00.000Z")).toEqual([]);
  });
});

describe("sessions", () => {
  it("ensureSession is idempotent per provider+occurrence", async () => {
    const a = await repo.ensureSession(demoAppointment, sessionId, NOW);
    const b = await repo.ensureSession(demoAppointment, sessionId, new Date(NOW.getTime() + 1000));
    const c = await repo.ensureSession(demoAppointment, "sess_other_id", NOW);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
    expect(b.session).toEqual(a.session);
    expect(c.session.id).toBe(sessionId);
    expect(a.session.status).toBe("WAITING_FOR_EVIDENCE");
    expect(await count("sessions")).toBe(1);
  });

  it("scoped reads return null for the wrong provider", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    expect(await repo.getSessionForProvider(DEMO_PROVIDER_ID, sessionId)).not.toBeNull();
    expect(await repo.getSessionForProvider(OTHER_PROVIDER_ID, sessionId)).toBeNull();
    expect((await repo.listSessionsForProvider(OTHER_PROVIDER_ID, 10, null)).sessions).toEqual([]);
  });

  it("transitionSession is conditional", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    const bad = await repo.transitionSession(sessionId, ["PROCESSING"], "FAILED", "x", NOW);
    expect(bad).toMatchObject({ ok: false, reason: "invalid_state" });
    const good = await repo.transitionSession(sessionId, ["WAITING_FOR_EVIDENCE"], "NO_EVIDENCE", "nothing yet", NOW);
    expect(good.ok && good.value.status).toBe("NO_EVIDENCE");
    expect(await repo.transitionSession("missing", ["SCHEDULED"], "FAILED", null, NOW)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("enqueueProcessing bumps revision once and records one delivery", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    const first = await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE", "NO_EVIDENCE"], NOW);
    expect(first).toEqual({ ok: true, value: { processingRevision: 1, deliveryKey: deliveryKey("process_session", sessionId, 1) } });
    const again = await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE", "NO_EVIDENCE"], NOW);
    expect(again).toMatchObject({ ok: false, reason: "invalid_state" });
    const s = await repo.getSession(sessionId);
    expect(s).toMatchObject({ status: "QUEUED", processingRevision: 1 });
    expect(await count("pending_deliveries")).toBe(1);
    const d = await repo.getDelivery(deliveryKey("process_session", sessionId, 1));
    expect(d).toMatchObject({ operation: "process_session", revision: 1, attempts: 0, status: "pending", payload: { schemaVersion: "1", sessionId, processingRevision: 1 } });
    expect(await repo.enqueueProcessing("missing", ["WAITING_FOR_EVIDENCE"], NOW)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("lists summaries joined with appointment + current bundle, paginated", async () => {
    await toNeedsReview(60);
    for (let i = 0; i < 3; i++) {
      const appt: Appointment = { ...demoAppointment, id: `appt_${i}`, occurrenceId: `occ_${i}`, startAt: `2026-11-1${i}T18:00:00.000Z`, endAt: `2026-11-1${i}T19:00:00.000Z` };
      await repo.ensureSession(appt, `sess_page_${i}`, NOW);
    }
    const p1 = await repo.listSessionsForProvider(DEMO_PROVIDER_ID, 2, null);
    expect(p1.sessions.map((s) => s.id)).toEqual([sessionId, "sess_page_2"]);
    expect(p1.sessions[0]).toMatchObject({ status: "NEEDS_REVIEW", currentBundleRevision: 1, canApprove: true, amountCents: 7500, evidenceMode: "fixture", extractionMode: "fixture", clientRef: "C-104" });
    expect(p1.sessions[1]).toMatchObject({ canApprove: null, amountCents: null, evidenceMode: null });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await repo.listSessionsForProvider(DEMO_PROVIDER_ID, 2, p1.nextCursor);
    expect(p2.sessions.map((s) => s.id)).toEqual(["sess_page_1", "sess_page_0"]);
    expect(p2.nextCursor).toBeNull();
    const big = await repo.listSessionsForProvider(DEMO_PROVIDER_ID, 1000, null);
    expect(big.sessions).toHaveLength(4);
  });
});

describe("evidence + bundles", () => {
  it("replaceEvidence is guarded by processing revision", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE"], NOW);
    await repo.replaceEvidence(sessionId, 1, demoEvidence);
    await repo.replaceEvidence(sessionId, 1, demoEvidence.slice(0, 2));
    expect(await count("evidence")).toBe(2);
    await repo.replaceEvidence(sessionId, 7, demoEvidence);
    expect(await count("evidence")).toBe(2);
  });

  it("saveDraft is idempotent on replay and guarded by processing revision", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE"], NOW);
    const stale = await repo.saveDraft(makeBundle(sessionId, 1, 1), NOW);
    expect(stale).toMatchObject({ ok: false, reason: "invalid_state" }); // still QUEUED
    await repo.transitionSession(sessionId, ["QUEUED"], "PROCESSING", null, NOW);
    expect(await repo.saveDraft(makeBundle(sessionId, 1, 2), NOW)).toMatchObject({ ok: false, reason: "stale_revision" });
    const bundle = makeBundle(sessionId, 1, 1);
    const first = await repo.saveDraft(bundle, NOW);
    const replay = await repo.saveDraft(bundle, new Date(NOW.getTime() + 5000));
    expect(first).toEqual({ ok: true, value: bundle });
    expect(replay).toEqual({ ok: true, value: bundle });
    expect(await count("bundles")).toBe(1);
    expect(await repo.getSession(sessionId)).toMatchObject({ status: "NEEDS_REVIEW", currentBundleRevision: 1 });
    expect(await repo.getCurrentBundle(sessionId)).toEqual(bundle);
    expect(await repo.getBundle(sessionId, 2)).toBeNull();
  });

  it("saveReviewRevision rejects stale expected revision without writing", async () => {
    await toNeedsReview(null);
    const r2 = await repo.saveReviewRevision(sessionId, 1, makeBundle(sessionId, 2, 1, { confirmedMinutes: 90 }), NOW);
    expect(r2.ok).toBe(true);
    const stale = await repo.saveReviewRevision(sessionId, 1, makeBundle(sessionId, 2, 1, { confirmedMinutes: 30 }), NOW);
    expect(stale).toMatchObject({ ok: false, reason: "stale_revision" });
    expect(await count("bundles")).toBe(2);
    const cur = await repo.getCurrentBundle(sessionId);
    expect(cur?.bundleRevision).toBe(2);
    expect(cur?.billing.amountCents).toBe(11250);
  });
});

describe("approvals + finalization", () => {
  const KEY = "demo-session-approval-request-001";

  it("persists approval, transition and notification intent atomically; same key replays", async () => {
    await toNeedsReview(60);
    const write = { approval: makeApproval(sessionId, 1, KEY), expectedBundleRevision: 1, notificationPayload: { approvalId: approvalId(sessionId, 1) } };
    const first = await repo.persistApproval(write, NOW);
    expect(first).toMatchObject({ ok: true, value: { replayed: false } });
    const replay = await repo.persistApproval(write, NOW);
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, approval: { id: approvalId(sessionId, 1) } } });
    expect(await count("approvals")).toBe(1);
    expect(await count("pending_deliveries", "operation = 'approval_notification'")).toBe(1);
    expect(await repo.getSession(sessionId)).toMatchObject({ status: "APPROVED" });
    expect(await repo.getApprovalByKey(KEY)).toMatchObject({ bundleRevision: 1 });
    expect(await repo.getApprovalForSession(sessionId)).toMatchObject({ idempotencyKey: KEY });
    expect(await repo.getDelivery(deliveryKey("approval_notification", sessionId, 1))).toMatchObject({ payload: { approvalId: approvalId(sessionId, 1) } });
  });

  it("different key for an already-approved revision -> conflict", async () => {
    await toNeedsReview(60);
    await repo.persistApproval({ approval: makeApproval(sessionId, 1, KEY), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    const other = await repo.persistApproval({ approval: makeApproval(sessionId, 1, "another-key-0002"), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    expect(other).toMatchObject({ ok: false, reason: "conflict" });
    expect(await count("approvals")).toBe(1);
  });

  it("same key with different fingerprint -> conflict", async () => {
    await toNeedsReview(60);
    await repo.persistApproval({ approval: makeApproval(sessionId, 1, KEY, "fp-1"), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    const other = await repo.persistApproval({ approval: makeApproval(sessionId, 1, KEY, "fp-2"), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    expect(other).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("stale-revision approval writes nothing", async () => {
    await toNeedsReview(null);
    await repo.saveReviewRevision(sessionId, 1, makeBundle(sessionId, 2, 1, { confirmedMinutes: 60 }), NOW);
    const before = await repo.getSession(sessionId);
    const stale = await repo.persistApproval({ approval: makeApproval(sessionId, 1, KEY), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    expect(stale).toMatchObject({ ok: false, reason: "stale_revision" });
    expect(await count("approvals")).toBe(0);
    expect(await count("pending_deliveries", "operation = 'approval_notification'")).toBe(0);
    expect(await repo.getSession(sessionId)).toEqual(before);
  });

  it("unique violation mid-batch rolls back every write", async () => {
    await toNeedsReview(60);
    // Orphan delivery row with the key the approval batch will try to insert.
    await db
      .prepare("INSERT INTO pending_deliveries (delivery_key, operation, session_id, revision, payload_json, next_attempt_at, created_at, updated_at) VALUES (?, 'approval_notification', ?, 1, '{}', ?, ?, ?)")
      .bind(deliveryKey("approval_notification", sessionId, 1), sessionId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
      .run();
    const r = await repo.persistApproval({ approval: makeApproval(sessionId, 1, KEY), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    expect(r).toMatchObject({ ok: false, reason: "conflict" });
    expect(await count("approvals")).toBe(0);
    expect(await repo.getSession(sessionId)).toMatchObject({ status: "NEEDS_REVIEW" });
  });

  it("finalize twice -> one final record, COMPLETED, approval finalized", async () => {
    await toNeedsReview(60);
    const aId = approvalId(sessionId, 1);
    await repo.persistApproval({ approval: makeApproval(sessionId, 1, KEY), expectedBundleRevision: 1, notificationPayload: {} }, NOW);
    expect(await repo.listApprovedUnfinalized(10)).toHaveLength(1);
    const f1 = await repo.finalizeApproved(sessionId, aId, 1, NOW);
    const f2 = await repo.finalizeApproved(sessionId, aId, 1, new Date(NOW.getTime() + 60_000));
    expect(f1.ok && f2.ok).toBe(true);
    if (f1.ok && f2.ok) {
      expect(f2.value).toEqual(f1.value);
      expect(f1.value.bundle.bundleRevision).toBe(1);
    }
    expect(await count("final_bundles")).toBe(1);
    expect(await repo.getSession(sessionId)).toMatchObject({ status: "COMPLETED" });
    expect(await repo.getApprovalForSession(sessionId)).toMatchObject({ finalizationStatus: "finalized" });
    expect(await repo.listApprovedUnfinalized(10)).toEqual([]);
    expect(await repo.getFinalBundle(sessionId)).toEqual(f1.ok ? f1.value : null);
    expect(await repo.finalizeApproved(sessionId, "approval-other", 1, NOW)).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("finalize before approval writes nothing", async () => {
    await toNeedsReview(60);
    const r = await repo.finalizeApproved(sessionId, approvalId(sessionId, 1), 1, NOW);
    expect(r.ok).toBe(false);
    expect(await count("final_bundles")).toBe(0);
    expect(await repo.getSession(sessionId)).toMatchObject({ status: "NEEDS_REVIEW" });
  });
});

describe("pending deliveries", () => {
  it("claim bumps attempts, fail backs off, exhausts at maxAttempts", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    const q = await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE"], NOW);
    if (!q.ok) throw new Error("enqueue failed");
    const key = q.value.deliveryKey;

    let t = NOW;
    const claimed = await repo.claimDueDeliveries(t, 10);
    expect(claimed.map((d) => [d.deliveryKey, d.attempts])).toEqual([[key, 1]]);
    expect(await repo.claimDueDeliveries(t, 10)).toEqual([]); // leased

    expect(await repo.failDelivery(key, "queue down", t, 3)).toBe("pending");
    let d = await repo.getDelivery(key);
    expect(d).toMatchObject({ attempts: 1, status: "pending", lastError: "queue down", nextAttemptAt: new Date(t.getTime() + backoffMs(1)).toISOString() });
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(await repo.claimDueDeliveries(new Date(t.getTime() + 59_000), 10)).toEqual([]);

    t = new Date(t.getTime() + 60_000);
    expect((await repo.claimDueDeliveries(t, 10))[0]?.attempts).toBe(2);
    expect(await repo.failDelivery(key, "again", t, 3)).toBe("pending");
    t = new Date(t.getTime() + backoffMs(2));
    expect((await repo.claimDueDeliveries(t, 10))[0]?.attempts).toBe(3);
    expect(await repo.failDelivery(key, "final", t, 3)).toBe("exhausted");
    d = await repo.getDelivery(key);
    expect(d).toMatchObject({ status: "exhausted", attempts: 3, lastError: "final" });
    expect(await repo.claimDueDeliveries(new Date(t.getTime() + 10 * 3_600_000), 10)).toEqual([]);
  });

  it("completeDelivery marks done and removes from claims", async () => {
    await repo.ensureSession(demoAppointment, sessionId, NOW);
    const q = await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE"], NOW);
    if (!q.ok) throw new Error("enqueue failed");
    await repo.completeDelivery(q.value.deliveryKey, NOW);
    expect(await repo.getDelivery(q.value.deliveryKey)).toMatchObject({ status: "done" });
    expect(await repo.claimDueDeliveries(new Date(NOW.getTime() + 3_600_000), 10)).toEqual([]);
    expect(await repo.failDelivery(q.value.deliveryKey, "late", NOW, 3)).toBe("done");
  });
});
