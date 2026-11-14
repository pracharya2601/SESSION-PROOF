/**
 * v3 repository methods (clients, snapshots, templates, run history) over
 * Miniflare D1 with ALL migrations applied in order.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvalId,
  sessionIdFor,
  SessionBundle,
  type Appointment,
  type ClientInput,
  type ClientSnapshot,
  type RunEvent,
  type TemplateInput,
} from "../../src/contracts";
import { createRepository } from "../../src/db/d1";
import type { Repository } from "../../src/db/repository";
import {
  DEMO_PROVIDER_ID,
  DEMO_PROVIDER_IDENTITY,
  OTHER_PROVIDER_ID,
  OTHER_PROVIDER_IDENTITY,
  demoAppointment,
  demoConfig,
  demoEvidence,
  demoFacts,
} from "../../fixtures/scenario";

const MIG_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const NOW = new Date("2026-11-13T20:00:00.000Z");

const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
afterAll(() => mf.dispose());

function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function freshDb(): Promise<D1Database> {
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  for (const { name } of results) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  for (const f of readdirSync(MIG_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of splitSql(readFileSync(resolve(MIG_DIR, f), "utf8"))) await db.prepare(stmt).run();
  }
  return db;
}

function makeBundle(appointment: Appointment, sessionId: string): SessionBundle {
  const confirmed = 60;
  const bundleRevision = 1;
  const processingRevision = 1;
  return SessionBundle.parse({
    sessionId,
    bundleRevision,
    processingRevision,
    appointment: appointment,
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
        scheduledFrom: appointment.startAt,
        scheduledTo: appointment.endAt,
        scheduledMinutes: 60,
        evidenceWindowFrom: "2026-11-13T18:05:00.000Z",
        evidenceWindowTo: "2026-11-13T18:53:00.000Z",
        evidenceWindowMinutes: 48,
        confirmedMinutes: confirmed,
        timezone: appointment.timezone,
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

let db: D1Database;
let repo: Repository;

beforeEach(async () => {
  db = await freshDb();
  repo = createRepository(db);
  await repo.upsertProvider(DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY);
  await repo.upsertProvider(OTHER_PROVIDER_ID, OTHER_PROVIDER_IDENTITY);
  await repo.upsertServiceConfig("DEMO-ILS", demoConfig);
});

function appt(n: number, providerId = DEMO_PROVIDER_ID, startHour = 10 + n): Appointment {
  const start = new Date(Date.UTC(2026, 10, 12, startHour));
  return {
    ...demoAppointment,
    id: `appointment_v3_${providerId}_${n}`,
    occurrenceId: `occurrence_v3_${providerId}_${n}`,
    providerId,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

/** ensureSession → enqueueProcessing → PROCESSING → saveDraft → persistApproval → finalizeApproved. */
async function completeSession(a: Appointment): Promise<string> {
  await repo.upsertAppointment(a);
  const sessionId = await sessionIdFor(a.providerId, a.occurrenceId);
  await repo.ensureSession(a, sessionId, NOW);
  expect((await repo.enqueueProcessing(sessionId, ["WAITING_FOR_EVIDENCE"], NOW)).ok).toBe(true);
  expect((await repo.transitionSession(sessionId, ["QUEUED"], "PROCESSING", null, NOW)).ok).toBe(true);
  expect((await repo.saveDraft(makeBundle(a, sessionId), NOW)).ok).toBe(true);
  const approval = {
    id: approvalId(sessionId, 1),
    sessionId,
    bundleRevision: 1,
    approverProviderId: a.providerId,
    approvedAt: NOW.toISOString(),
    idempotencyKey: `key-${sessionId}`,
    requestFingerprint: "fp",
    finalizationStatus: "pending" as const,
  };
  expect((await repo.persistApproval({ approval, expectedBundleRevision: 1, notificationPayload: {} }, NOW)).ok).toBe(true);
  expect((await repo.finalizeApproved(sessionId, approval.id, 1, NOW)).ok).toBe(true);
  return sessionId;
}


function clientInput(ref: string, patch: Partial<ClientInput> = {}): ClientInput {
  return {
    clientRef: ref,
    displayName: null,
    preferredName: null,
    hourlyRateCents: null,
    fundingSource: null,
    authorizationNumber: null,
    fiscalIntermediary: null,
    authorizedHours: null,
    caseManager: null,
    customFields: [],
    templates: { session_note: null, invoice: null, approval_record: null },
    notes: null,
    active: true,
    ...patch,
  };
}

const LATER = new Date("2026-11-14T08:00:00.000Z");

describe("clients", () => {
  it("inserts with rateVersion 1 and round-trips every field", async () => {
    const input = clientInput("C-104", {
      displayName: "Jordan Example",
      preferredName: "Jo",
      hourlyRateCents: 8200,
      fundingSource: "Self-Determination",
      authorizationNumber: "AUTH-1",
      fiscalIntermediary: "FI Co",
      authorizedHours: 12.5,
      caseManager: "CM",
      customFields: [{ label: "Medicaid ID", value: "X123" }],
      templates: { session_note: "tpl_a", invoice: null, approval_record: null },
      notes: "n",
    });
    const rec = await repo.upsertClient(DEMO_PROVIDER_ID, input, NOW);
    expect(rec).toMatchObject({ ...input, providerId: DEMO_PROVIDER_ID, rateVersion: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    expect(await repo.getClient(DEMO_PROVIDER_ID, "C-104")).toEqual(rec);
  });

  it("bumps rateVersion only when hourlyRateCents changes", async () => {
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: 7000 }), NOW);
    const same = await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: 7000, displayName: "New" }), LATER);
    expect(same.rateVersion).toBe(1);
    expect(same.displayName).toBe("New");
    expect(same.createdAt).toBe(NOW.toISOString());
    expect(same.updatedAt).toBe(LATER.toISOString());
    const changed = await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: 7500 }), LATER);
    expect(changed.rateVersion).toBe(2);
    const toNull = await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: null }), LATER);
    expect(toNull.rateVersion).toBe(3);
    const stillNull = await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: null }), LATER);
    expect(stillNull.rateVersion).toBe(3);
  });

  it("isolates providers", async () => {
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: 1 }), NOW);
    await repo.upsertClient(OTHER_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: 2 }), NOW);
    expect((await repo.getClient(DEMO_PROVIDER_ID, "C-1"))?.hourlyRateCents).toBe(1);
    expect((await repo.getClient(OTHER_PROVIDER_ID, "C-1"))?.hourlyRateCents).toBe(2);
    expect(await repo.getClient(OTHER_PROVIDER_ID, "C-2")).toBeNull();
    const list = await repo.listClients(OTHER_PROVIDER_ID, { includeInactive: true, limit: 50 });
    expect(list.map((x) => [x.client.providerId, x.client.clientRef])).toEqual([[OTHER_PROVIDER_ID, "C-1"]]);
  });

  it("searches case-insensitively with escaped wildcards and filters inactive", async () => {
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("A-1", { displayName: "Alice Smith" }), NOW);
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("B-2", { preferredName: "Bobby" }), NOW);
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C_3", { displayName: "100% Carol", active: false }), NOW);
    const refs = async (search: string | undefined, includeInactive = true) =>
      (await repo.listClients(DEMO_PROVIDER_ID, { includeInactive, limit: 50, ...(search === undefined ? {} : { search }) })).map((x) => x.client.clientRef);
    expect(await refs("smith")).toEqual(["A-1"]);
    expect(await refs("BOB")).toEqual(["B-2"]);
    expect(await refs("b-")).toEqual(["B-2"]);
    expect(await refs("_")).toEqual(["C_3"]);
    expect(await refs("%")).toEqual(["C_3"]);
    expect(await refs("zzz")).toEqual([]);
    expect(await refs(undefined)).toEqual(["A-1", "B-2", "C_3"]);
    expect(await refs(undefined, false)).toEqual(["A-1", "B-2"]);
    expect(await refs("carol", false)).toEqual([]);
  });

  it("joins session stats and orders by lastServiceAt desc then clientRef", async () => {
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("AAA"), NOW);
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput(demoAppointment.clientRef), NOW);
    await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("ZZZ"), NOW);
    // completed session for demo client (amount 7500c / 60 min)
    await completeSession(appt(1));
    // a NEEDS_REVIEW session for the same client, later start
    const a2 = appt(2);
    await repo.upsertAppointment(a2);
    const s2 = await sessionIdFor(a2.providerId, a2.occurrenceId);
    await repo.ensureSession(a2, s2, NOW);
    await repo.enqueueProcessing(s2, ["WAITING_FOR_EVIDENCE"], NOW);
    await repo.transitionSession(s2, ["QUEUED"], "PROCESSING", null, NOW);
    expect((await repo.saveDraft(makeBundle(a2, s2), NOW)).ok).toBe(true);
    // ZZZ: a session with an earlier appointment, other provider's session for demo ref is ignored
    const a3 = { ...appt(3, DEMO_PROVIDER_ID, 2), clientRef: "ZZZ" };
    await repo.upsertAppointment(a3);
    await repo.ensureSession(a3, await sessionIdFor(a3.providerId, a3.occurrenceId), NOW);
    await completeSession(appt(4, OTHER_PROVIDER_ID));

    const list = await repo.listClients(DEMO_PROVIDER_ID, { includeInactive: false, limit: 50 });
    expect(list.map((x) => x.client.clientRef)).toEqual([demoAppointment.clientRef, "ZZZ", "AAA"]);
    expect(list[0]!.stats).toEqual({
      sessions: 2,
      completed: 1,
      needsReview: 1,
      billedCents: 7500,
      billedMinutes: 60,
      lastServiceAt: a2.startAt,
    });
    expect(list[1]!.stats).toMatchObject({ sessions: 1, completed: 0, needsReview: 0, billedCents: 0, lastServiceAt: a3.startAt });
    expect(list[2]!.stats).toEqual({ sessions: 0, completed: 0, needsReview: 0, billedCents: 0, billedMinutes: 0, lastServiceAt: null });
    expect(await repo.listClients(DEMO_PROVIDER_ID, { includeInactive: false, limit: 1 })).toHaveLength(1);
  });
});

describe("client snapshots", () => {
  it("is idempotent per session+revision (first write wins)", async () => {
    const rec = await repo.upsertClient(DEMO_PROVIDER_ID, clientInput("C-1", { hourlyRateCents: 9000 }), NOW);
    const { notes: _n, templates: _t, ...rest } = rec;
    const snap: ClientSnapshot = { ...rest, effectiveHourlyRateCents: 9000, capturedAt: NOW.toISOString() };
    await repo.saveClientSnapshot("sess_1", 1, snap);
    await repo.saveClientSnapshot("sess_1", 1, { ...snap, effectiveHourlyRateCents: 1 });
    expect(await repo.getClientSnapshot("sess_1", 1)).toEqual(snap);
    expect(await repo.getClientSnapshot("sess_1", 2)).toBeNull();
  });
});

function tplInput(kind: TemplateInput["kind"], name: string): TemplateInput {
  return {
    kind,
    name,
    theme: { accentColor: "#123456", fontFamily: "serif", paper: "letter", density: "compact", logoText: "L", headerNote: "", footerNote: "f" },
    sections: [{ key: "overview", enabled: true }],
    text: {
      title: "",
      invoicePrefix: "INV-",
      paymentTerms: "",
      invoiceNotes: "",
      attestationStatement: "",
      participantSignatureLabel: "Participant",
      providerSignatureLabel: "Provider",
      representativeSignatureLabel: "",
    },
  };
}

describe("templates", () => {
  it("creates, lists by kind, gets scoped, updates and deletes", async () => {
    const t1 = await repo.createTemplate(DEMO_PROVIDER_ID, "tpl_1", tplInput("invoice", "Blue invoice"), NOW);
    expect(t1).toMatchObject({ ...tplInput("invoice", "Blue invoice"), id: "tpl_1", builtin: false, isDefault: false, updatedAt: NOW.toISOString() });
    await repo.createTemplate(DEMO_PROVIDER_ID, "tpl_2", tplInput("session_note", "Note"), NOW);
    await repo.createTemplate(OTHER_PROVIDER_ID, "tpl_3", tplInput("invoice", "Other"), NOW);

    expect((await repo.listTemplates(DEMO_PROVIDER_ID)).map((t) => t.id).sort()).toEqual(["tpl_1", "tpl_2"]);
    expect((await repo.listTemplates(DEMO_PROVIDER_ID, "invoice")).map((t) => t.id)).toEqual(["tpl_1"]);
    expect((await repo.listTemplates(DEMO_PROVIDER_ID)).some((t) => t.builtin)).toBe(false);
    expect(await repo.getTemplate(OTHER_PROVIDER_ID, "tpl_1")).toBeNull();

    const upd = await repo.updateTemplate(DEMO_PROVIDER_ID, "tpl_1", tplInput("invoice", "Renamed"), LATER);
    expect(upd).toMatchObject({ name: "Renamed", updatedAt: LATER.toISOString() });
    expect(await repo.updateTemplate(OTHER_PROVIDER_ID, "tpl_1", tplInput("invoice", "x"), LATER)).toBeNull();
    expect(await repo.updateTemplate(DEMO_PROVIDER_ID, "missing", tplInput("invoice", "x"), LATER)).toBeNull();

    expect(await repo.deleteTemplate(OTHER_PROVIDER_ID, "tpl_1")).toBe(false);
    expect(await repo.deleteTemplate(DEMO_PROVIDER_ID, "tpl_1")).toBe(true);
    expect(await repo.deleteTemplate(DEMO_PROVIDER_ID, "tpl_1")).toBe(false);
    expect(await repo.getTemplate(DEMO_PROVIDER_ID, "tpl_1")).toBeNull();
  });

  it("default template: set, isDefault, builtin ids, clear, delete clears default", async () => {
    expect(await repo.getDefaultTemplateId(DEMO_PROVIDER_ID, "invoice")).toBeNull();
    await repo.createTemplate(DEMO_PROVIDER_ID, "tpl_1", tplInput("invoice", "A"), NOW);
    await repo.setDefaultTemplateId(DEMO_PROVIDER_ID, "invoice", "tpl_1", NOW);
    expect(await repo.getDefaultTemplateId(DEMO_PROVIDER_ID, "invoice")).toBe("tpl_1");
    expect(await repo.getDefaultTemplateId(OTHER_PROVIDER_ID, "invoice")).toBeNull();
    expect((await repo.getTemplate(DEMO_PROVIDER_ID, "tpl_1"))?.isDefault).toBe(true);
    expect((await repo.listTemplates(DEMO_PROVIDER_ID, "invoice"))[0]?.isDefault).toBe(true);

    await repo.setDefaultTemplateId(DEMO_PROVIDER_ID, "invoice", "builtin:invoice", NOW);
    expect(await repo.getDefaultTemplateId(DEMO_PROVIDER_ID, "invoice")).toBe("builtin:invoice");
    expect((await repo.getTemplate(DEMO_PROVIDER_ID, "tpl_1"))?.isDefault).toBe(false);
    await repo.setDefaultTemplateId(DEMO_PROVIDER_ID, "invoice", null, NOW);
    expect(await repo.getDefaultTemplateId(DEMO_PROVIDER_ID, "invoice")).toBeNull();

    await repo.setDefaultTemplateId(DEMO_PROVIDER_ID, "invoice", "tpl_1", NOW);
    expect(await repo.deleteTemplate(DEMO_PROVIDER_ID, "tpl_1")).toBe(true);
    expect(await repo.getDefaultTemplateId(DEMO_PROVIDER_ID, "invoice")).toBeNull();
  });
});

// ---------------------------------------------------------------- run history
const T0 = Date.parse("2026-11-13T18:00:00.000Z");
function ev(runId: string, stage: RunEvent["stage"], status: RunEvent["status"], sec: number, patch: Partial<RunEvent> = {}): RunEvent {
  return {
    id: `${runId}:${stage}:${status}`,
    runId,
    runKind: "processing",
    sessionId: "sess_a",
    providerId: DEMO_PROVIDER_ID,
    stage,
    status,
    label: `${stage} ${status}`,
    detail: null,
    meta: {},
    at: new Date(T0 + sec * 1000).toISOString(),
    ...patch,
  };
}

describe("run history", () => {
  it("dedupes events by id and lists them ordered by at then id", async () => {
    await repo.appendRunEvent(ev("r1", "load", "started", 5));
    await repo.appendRunEvent(ev("r1", "discovered", "info", 0));
    await repo.appendRunEvent(ev("r1", "discovered", "info", 99, { label: "dupe" }));
    await repo.appendRunEvent(ev("r1", "queued", "info", 0));
    const events = await repo.listRunEvents("r1", DEMO_PROVIDER_ID);
    expect(events.map((e) => e.id)).toEqual(["r1:discovered:info", "r1:queued:info", "r1:load:started"]);
    expect(events[0]!.label).toBe("discovered info");
    expect(await repo.listRunEvents("r1", OTHER_PROVIDER_ID)).toEqual([]);
  });

  async function seedRuns(): Promise<void> {
    // clientRef resolution via sessions -> appointments
    const a = appt(1);
    await repo.upsertAppointment(a);
    const sid = await sessionIdFor(a.providerId, a.occurrenceId);
    await repo.ensureSession(a, sid, NOW);
    // r_ok: succeeded, has extraction meta (newest start = 400)
    for (const e of [
      ev("r_ok", "workflow_started", "started", 400, { sessionId: sid }),
      ev("r_ok", "extraction", "succeeded", 410, { sessionId: sid, meta: { aiProvider: "openai", model: "gpt-4.1", facts: 3 } }),
      ev("r_ok", "completed", "succeeded", 430, { sessionId: sid }),
    ])
      await repo.appendRunEvent(e);
    // r_wait: waiting on approval (start 300)
    await repo.appendRunEvent(ev("r_wait", "workflow_started", "started", 300));
    await repo.appendRunEvent(ev("r_wait", "approval_wait", "waiting", 320));
    // r_fail: failed (start 200)
    await repo.appendRunEvent(ev("r_fail", "workflow_started", "started", 200, { sessionId: "sess_b" }));
    await repo.appendRunEvent(ev("r_fail", "extraction", "failed", 205, { sessionId: "sess_b" }));
    await repo.appendRunEvent(ev("r_fail", "failed", "failed", 206, { sessionId: "sess_b" }));
    // r_run: running (start 100)
    await repo.appendRunEvent(ev("r_run", "workflow_started", "started", 100));
    await repo.appendRunEvent(ev("r_run", "load", "started", 101));
    // delivery: failed then retried and succeeded (start 50)
    await repo.appendRunEvent(ev("delivery:d1", "delivery_drive", "failed", 50, { runKind: "delivery" }));
    await repo.appendRunEvent(ev("delivery:d1", "delivery_drive", "succeeded", 60, { runKind: "delivery" }));
    // other provider
    await repo.appendRunEvent(ev("r_other", "workflow_started", "started", 999, { providerId: OTHER_PROVIDER_ID }));
  }

  it("aggregates runs with status, stage, timing, ai provider and clientRef", async () => {
    await seedRuns();
    const { runs, nextCursor } = await repo.listRuns(DEMO_PROVIDER_ID, { limit: 50, cursor: null });
    expect(nextCursor).toBeNull();
    expect(runs.map((r) => [r.runId, r.status, r.currentStage])).toEqual([
      ["r_ok", "succeeded", "completed"],
      ["r_wait", "waiting", "approval_wait"],
      ["r_fail", "failed", "failed"],
      ["r_run", "running", "load"],
      ["delivery:d1", "succeeded", "delivery_drive"],
    ]);
    const ok = runs[0]!;
    expect(ok).toMatchObject({
      runKind: "processing",
      clientRef: demoAppointment.clientRef,
      startedAt: new Date(T0 + 400_000).toISOString(),
      endedAt: new Date(T0 + 430_000).toISOString(),
      durationMs: 30_000,
      eventCount: 3,
      aiProvider: "openai",
      model: "gpt-4.1",
    });
    expect(runs[1]).toMatchObject({ endedAt: null, durationMs: null, aiProvider: null, model: null, clientRef: null });
    expect(runs[2]).toMatchObject({ endedAt: new Date(T0 + 206_000).toISOString(), durationMs: 6000, sessionId: "sess_b" });
    expect(runs[4]).toMatchObject({ runKind: "delivery", durationMs: 10_000 });
  });

  it("filters by status and sessionId", async () => {
    await seedRuns();
    const ids = async (o: { status?: "running" | "waiting" | "succeeded" | "failed"; sessionId?: string }) =>
      (await repo.listRuns(DEMO_PROVIDER_ID, { ...o, limit: 50, cursor: null })).runs.map((r) => r.runId);
    expect(await ids({ status: "succeeded" })).toEqual(["r_ok", "delivery:d1"]);
    expect(await ids({ status: "failed" })).toEqual(["r_fail"]);
    expect(await ids({ status: "waiting" })).toEqual(["r_wait"]);
    expect(await ids({ status: "running" })).toEqual(["r_run"]);
    expect(await ids({ sessionId: "sess_b" })).toEqual(["r_fail"]);
    expect(await ids({ sessionId: "sess_a", status: "running" })).toEqual(["r_run"]);
    expect((await repo.listRuns(OTHER_PROVIDER_ID, { limit: 50, cursor: null })).runs.map((r) => r.runId)).toEqual(["r_other"]);
  });

  it("paginates with an opaque cursor, also under a status filter", async () => {
    await seedRuns();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Awaited<ReturnType<Repository["listRuns"]>> = await repo.listRuns(DEMO_PROVIDER_ID, { limit: 2, cursor });
      seen.push(...page.runs.map((r) => r.runId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["r_ok", "r_wait", "r_fail", "r_run", "delivery:d1"]);

    const p1 = await repo.listRuns(DEMO_PROVIDER_ID, { status: "succeeded", limit: 1, cursor: null });
    expect(p1.runs.map((r) => r.runId)).toEqual(["r_ok"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await repo.listRuns(DEMO_PROVIDER_ID, { status: "succeeded", limit: 1, cursor: p1.nextCursor });
    expect(p2.runs.map((r) => r.runId)).toEqual(["delivery:d1"]);
    expect(p2.nextCursor).toBeNull();

    // limit clamped to 1..50
    expect((await repo.listRuns(DEMO_PROVIDER_ID, { limit: 0, cursor: null })).runs).toHaveLength(1);
    await expect(repo.listRuns(DEMO_PROVIDER_ID, { limit: 5, cursor: "garbage" })).rejects.toThrow();
  });
});
