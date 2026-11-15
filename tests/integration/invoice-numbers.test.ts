/** Business profile + sequential invoice numbers (migration 0015) on Miniflare D1, and the approval gate. */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../../src/db/d1";
import type { Repository } from "../../src/db/repository";
import { EMPTY_PROVIDER_PROFILE } from "../../src/contracts";
import { validReviewedBundle } from "../../src/contracts/examples";
import { applyBusinessProfileGate, BUSINESS_PROFILE_MESSAGE } from "../../src/domain/rules/profile-gate";
import { demoProviderProfile } from "../../src/calendar/seed";

const MIG_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const NOW = new Date("2026-11-13T20:00:00.000Z");
const P = "prov_inv_1";
const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
afterAll(() => mf.dispose());

function splitSql(sql: string): string[] {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
}

let repo: Repository;
beforeEach(async () => {
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  for (const { name } of results) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  for (const f of readdirSync(MIG_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of splitSql(readFileSync(resolve(MIG_DIR, f), "utf8"))) await db.prepare(stmt).run();
  }
  repo = createRepository(db);
});

describe("business profile", () => {
  it("empty by default; saves and round-trips (logo included)", async () => {
    expect(await repo.getProviderProfile(P)).toBeNull();
    const saved = await repo.saveProviderProfile(P, demoProviderProfile, NOW);
    expect(saved).toMatchObject({ ...demoProviderProfile, providerId: P });
  });
});

describe("invoice numbers", () => {
  it("sequential per provider, idempotent per revision, never reused (counter never goes back)", async () => {
    await repo.saveProviderProfile(P, { ...demoProviderProfile, invoicePrefix: "VOS", nextInvoiceNumber: 1001 }, NOW);
    const a = await repo.ensureInvoiceNumber(P, "s1", 1, NOW);
    const again = await repo.ensureInvoiceNumber(P, "s1", 1, NOW);
    const b = await repo.ensureInvoiceNumber(P, "s2", 1, NOW);
    const c = await repo.ensureInvoiceNumber(P, "s1", 2, NOW); // amended revision → new number
    expect([a.invoiceNumber, again.invoiceNumber, b.invoiceNumber, c.invoiceNumber]).toEqual(["VOS-1001", "VOS-1001", "VOS-1002", "VOS-1003"]);
    expect(a.profile.legalName).toBe(demoProviderProfile.legalName);
    // Lowering the counter is ignored.
    const p = await repo.saveProviderProfile(P, { ...demoProviderProfile, invoicePrefix: "VOS", nextInvoiceNumber: 1 }, NOW);
    expect(p.nextInvoiceNumber).toBe(1004);
    // Dev reset deletes the row, the number is still never reused.
    await repo.devResetSession("s2");
    expect((await repo.ensureInvoiceNumber(P, "s2", 1, NOW)).invoiceNumber).toBe("VOS-1004");
  });

  it("concurrent finalizes get distinct consecutive numbers", async () => {
    await repo.saveProviderProfile(P, { ...EMPTY_PROVIDER_PROFILE, invoicePrefix: "INV", nextInvoiceNumber: 1 }, NOW);
    const recs = await Promise.all(Array.from({ length: 12 }, (_, i) => repo.ensureInvoiceNumber(P, `s${i % 6}`, 1 + Math.floor(i / 6), NOW)));
    const nums = new Set(recs.map((r) => r.seq));
    expect(nums.size).toBe(12);
    expect([...nums].sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // same revision concurrently → same number
    const [x, y] = await Promise.all([repo.ensureInvoiceNumber(P, "dup", 1, NOW), repo.ensureInvoiceNumber(P, "dup", 1, NOW)]);
    expect(x.invoiceNumber).toBe(y.invoiceNumber);
  });

  it("works for a provider with no saved profile (default INV prefix)", async () => {
    expect((await repo.ensureInvoiceNumber("prov_new", "s9", 1, NOW)).invoiceNumber).toBe("INV-0001");
  });
});

describe("business profile approval gate", () => {
  it("missing profile → blocking issue + checklist item; complete profile → unchanged", () => {
    const withChecklist = {
      ...validReviewedBundle,
      checks: { ...validReviewedBundle.checks, checklist: { version: "checklist-v1", sdpCode: "320", evvRequired: true, items: [], summary: { pass: 0, warn: 0, fail: 0 } } },
    };
    const gated = applyBusinessProfileGate(withChecklist, null);
    expect(gated.checks.canApprove).toBe(false);
    expect(gated.checks.issues[0]).toMatchObject({ code: "BUSINESS_PROFILE_INCOMPLETE", blocking: true });
    expect(gated.checks.checklist?.items[0]).toMatchObject({ label: BUSINESS_PROFILE_MESSAGE, status: "fail", blocksApproval: true });
    expect(BUSINESS_PROFILE_MESSAGE).toBe("Complete your business profile (vendor #, address) before approving");
    expect(applyBusinessProfileGate(withChecklist, { ...demoProviderProfile, vendorNumber: null }).checks.canApprove).toBe(false);
    expect(applyBusinessProfileGate(withChecklist, demoProviderProfile)).toBe(withChecklist);
  });
});
