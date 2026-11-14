/**
 * v2 repository methods over Miniflare D1 with ALL migrations applied in order.
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
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  DEFAULT_AI_SETTINGS,
  type Appointment,
  type FileDelivery,
  type StoredConnection,
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
    id: `appointment_v2_${providerId}_${n}`,
    occurrenceId: `occurrence_v2_${providerId}_${n}`,
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

describe("settings", () => {
  it("returns defaults when unset, null AI settings", async () => {
    expect(await repo.getStorageSettings(DEMO_PROVIDER_ID)).toEqual(DEFAULT_STORAGE_SETTINGS);
    expect(await repo.getEmailSettings(DEMO_PROVIDER_ID)).toEqual(DEFAULT_EMAIL_SETTINGS);
    expect(await repo.getAiSettings(DEMO_PROVIDER_ID)).toBeNull();
  });

  it("round-trips and overwrites per provider", async () => {
    const storage = { provider: "google" as const, folderPath: "Notes/{clientRef}", autoUploadOnComplete: true };
    const email = { ...DEFAULT_EMAIL_SETTINGS, provider: "microsoft" as const, defaultTo: ["billing@example.com"], attach: ["invoice" as const] };
    const ai = { ...DEFAULT_AI_SETTINGS, provider: "openai" as const, model: "gpt-4.1" };
    await repo.saveStorageSettings(DEMO_PROVIDER_ID, storage, NOW);
    await repo.saveEmailSettings(DEMO_PROVIDER_ID, email, NOW);
    await repo.saveAiSettings(DEMO_PROVIDER_ID, ai, NOW);
    expect(await repo.getStorageSettings(DEMO_PROVIDER_ID)).toEqual(storage);
    expect(await repo.getEmailSettings(DEMO_PROVIDER_ID)).toEqual(email);
    expect(await repo.getAiSettings(DEMO_PROVIDER_ID)).toEqual(ai);
    await repo.saveStorageSettings(DEMO_PROVIDER_ID, { ...storage, autoUploadOnComplete: false }, NOW);
    expect((await repo.getStorageSettings(DEMO_PROVIDER_ID)).autoUploadOnComplete).toBe(false);
    // Other provider unaffected.
    expect(await repo.getStorageSettings(OTHER_PROVIDER_ID)).toEqual(DEFAULT_STORAGE_SETTINGS);
    expect(await repo.getAiSettings(OTHER_PROVIDER_ID)).toBeNull();
  });

  it("rejects invalid settings on write and on read", async () => {
    await expect(
      repo.saveStorageSettings(DEMO_PROVIDER_ID, { provider: null, folderPath: "bad:path", autoUploadOnComplete: false }, NOW),
    ).rejects.toThrow();
    await expect(
      repo.saveEmailSettings(DEMO_PROVIDER_ID, { ...DEFAULT_EMAIL_SETTINGS, defaultTo: ["not-an-email"] }, NOW),
    ).rejects.toThrow();
    await expect(
      repo.saveAiSettings(DEMO_PROVIDER_ID, { ...DEFAULT_AI_SETTINGS, provider: "nope" as never }, NOW),
    ).rejects.toThrow();
    expect(await repo.getAiSettings(DEMO_PROVIDER_ID)).toBeNull();
    await db
      .prepare("INSERT INTO provider_settings (provider_id, kind, value_json, updated_at) VALUES (?, 'storage', ?, ?)")
      .bind(DEMO_PROVIDER_ID, JSON.stringify({ provider: "dropbox" }), NOW.toISOString())
      .run();
    await expect(repo.getStorageSettings(DEMO_PROVIDER_ID)).rejects.toThrow();
  });

  it("getProviderIdentity", async () => {
    expect(await repo.getProviderIdentity(DEMO_PROVIDER_ID)).toBe(DEMO_PROVIDER_IDENTITY);
    expect(await repo.getProviderIdentity("missing")).toBeNull();
  });
});

describe("connections + oauth pending", () => {
  const conn: StoredConnection = {
    providerId: DEMO_PROVIDER_ID,
    provider: "google",
    accountEmail: "me@example.com",
    scopes: ["openid", "email"],
    encryptedTokens: "v1.aXY=.Y2lwaGVy+/==",
    accessTokenExpiresAt: "2026-11-13T21:00:00.000Z",
    status: "connected",
    lastError: null,
    connectedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };

  it("saves, lists, upserts and deletes; tokens stored verbatim", async () => {
    await repo.saveConnection(conn);
    await repo.saveConnection({ ...conn, provider: "microsoft", accountEmail: null });
    await repo.saveConnection({ ...conn, providerId: OTHER_PROVIDER_ID });
    expect(await repo.getConnection(DEMO_PROVIDER_ID, "google")).toEqual(conn);
    const raw = await db
      .prepare("SELECT encrypted_tokens FROM connections WHERE provider_id = ? AND provider = 'google'")
      .bind(DEMO_PROVIDER_ID)
      .first<{ encrypted_tokens: string }>();
    expect(raw?.encrypted_tokens).toBe(conn.encryptedTokens);
    expect((await repo.listConnections(DEMO_PROVIDER_ID)).map((c) => c.provider)).toEqual(["google", "microsoft"]);

    await repo.saveConnection({ ...conn, status: "error", lastError: "refresh failed", encryptedTokens: "v1.new" });
    const updated = await repo.getConnection(DEMO_PROVIDER_ID, "google");
    expect(updated?.status).toBe("error");
    expect(updated?.encryptedTokens).toBe("v1.new");

    await repo.deleteConnection(DEMO_PROVIDER_ID, "google");
    expect(await repo.getConnection(DEMO_PROVIDER_ID, "google")).toBeNull();
    expect(await repo.listConnections(DEMO_PROVIDER_ID)).toHaveLength(1);
    expect(await repo.listConnections(OTHER_PROVIDER_ID)).toHaveLength(1);
  });

  it("consumes oauth pending exactly once; expired yields null and is deleted", async () => {
    const p = {
      nonce: "nonce-1",
      providerId: DEMO_PROVIDER_ID,
      provider: "google" as const,
      codeVerifier: "verifier",
      returnTo: "/#/connections",
      expiresAt: "2026-11-13T20:10:00.000Z",
    };
    await repo.saveOAuthPending(p);
    const [a, b] = await Promise.all([repo.consumeOAuthPending("nonce-1", NOW), repo.consumeOAuthPending("nonce-1", NOW)]);
    expect([a, b].filter(Boolean)).toEqual([p]);
    expect(await repo.consumeOAuthPending("nonce-1", NOW)).toBeNull();

    await repo.saveOAuthPending({ ...p, nonce: "nonce-2" });
    expect(await repo.consumeOAuthPending("nonce-2", new Date("2026-11-13T20:10:00.000Z"))).toBeNull();
    const left = await db.prepare("SELECT COUNT(*) AS n FROM oauth_pending").first<{ n: number }>();
    expect(Number(left?.n)).toBe(0);
    expect(await repo.consumeOAuthPending("unknown", NOW)).toBeNull();
  });
});

describe("file deliveries", () => {
  it("create, update, get, list", async () => {
    const d: FileDelivery = {
      id: "del_1",
      sessionId: "sess_x",
      bundleRevision: 1,
      target: "email_draft",
      provider: "google",
      files: ["session_note", "invoice"],
      status: "pending",
      externalId: null,
      webUrl: null,
      recipients: ["billing@example.com"],
      error: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    await repo.createFileDelivery(d);
    await repo.createFileDelivery({ ...d, id: "del_2", target: "drive", recipients: [], createdAt: "2026-11-13T20:05:00.000Z" });
    await repo.createFileDelivery({ ...d, id: "del_3", sessionId: "sess_other" });
    expect(await repo.getFileDelivery("del_1")).toEqual(d);
    expect(await repo.getFileDelivery("missing")).toBeNull();

    const later = new Date("2026-11-13T20:30:00.000Z");
    await repo.updateFileDelivery("del_1", { status: "done", externalId: "draft-9", webUrl: "https://mail.example/d/9" }, later);
    const done = await repo.getFileDelivery("del_1");
    expect(done).toMatchObject({ status: "done", externalId: "draft-9", webUrl: "https://mail.example/d/9", error: null, updatedAt: later.toISOString() });
    await repo.updateFileDelivery("del_1", { status: "failed", error: "x".repeat(800) }, later);
    const failed = await repo.getFileDelivery("del_1");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toHaveLength(500);
    expect(failed?.externalId).toBe("draft-9");

    const list = await repo.listFileDeliveries("sess_x");
    expect(list.map((x) => x.id)).toEqual(["del_2", "del_1"]);
    await expect(repo.createFileDelivery({ ...d, id: "del_1" })).rejects.toThrow();
  });
});

describe("listCompletedForProvider", () => {
  it("returns only the provider's COMPLETED sessions, newest first, paginated", async () => {
    const s1 = await completeSession(appt(1));
    const s2 = await completeSession(appt(2));
    const s3 = await completeSession(appt(3));
    await completeSession(appt(1, OTHER_PROVIDER_ID));
    // A non-completed session for the same provider.
    const open = appt(4);
    await repo.upsertAppointment(open);
    await repo.ensureSession(open, await sessionIdFor(open.providerId, open.occurrenceId), NOW);

    const all = await repo.listCompletedForProvider(DEMO_PROVIDER_ID, 50, null);
    expect(all.items.map((i) => i.session.id)).toEqual([s3, s2, s1]);
    expect(all.nextCursor).toBeNull();
    for (const i of all.items) {
      expect(i.session.status).toBe("COMPLETED");
      expect(i.final.sessionId).toBe(i.session.id);
      expect(i.final.bundle.bundleRevision).toBe(1);
      expect(i.approval.id).toBe(i.final.approvalId);
      expect(i.approval.finalizationStatus).toBe("finalized");
    }

    const p1 = await repo.listCompletedForProvider(DEMO_PROVIDER_ID, 2, null);
    expect(p1.items.map((i) => i.session.id)).toEqual([s3, s2]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await repo.listCompletedForProvider(DEMO_PROVIDER_ID, 2, p1.nextCursor);
    expect(p2.items.map((i) => i.session.id)).toEqual([s1]);
    expect(p2.nextCursor).toBeNull();

    // Limit clamped to >= 1.
    expect((await repo.listCompletedForProvider(DEMO_PROVIDER_ID, 0, null)).items).toHaveLength(1);
    expect((await repo.listCompletedForProvider(OTHER_PROVIDER_ID, 50, null)).items).toHaveLength(1);
    expect((await repo.listCompletedForProvider("nobody", 50, null)).items).toEqual([]);
    await expect(repo.listCompletedForProvider(DEMO_PROVIDER_ID, 5, "garbage")).rejects.toThrow();
  });
});

describe("enqueuePendingDelivery", () => {
  it("is idempotent and claimable as file_delivery", async () => {
    const d = { deliveryKey: "file_delivery:sess_x:del_1", operation: "file_delivery" as const, sessionId: "sess_x", revision: 1, payload: { deliveryId: "del_1" } };
    await repo.enqueuePendingDelivery(d, NOW);
    await repo.enqueuePendingDelivery({ ...d, payload: { deliveryId: "other" } }, NOW);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").first<{ n: number }>();
    expect(Number(n?.n)).toBe(1);
    expect(await repo.getDelivery(d.deliveryKey)).toMatchObject({
      operation: "file_delivery", status: "pending", attempts: 0, payload: { deliveryId: "del_1" }, nextAttemptAt: NOW.toISOString(),
    });
    const claimed = await repo.claimDueDeliveries(NOW, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ deliveryKey: d.deliveryKey, operation: "file_delivery", attempts: 1 });
    await repo.completeDelivery(d.deliveryKey, NOW);
    expect((await repo.getDelivery(d.deliveryKey))?.status).toBe("done");
  });
});
