/**
 * Agent 20 — in-process end-to-end flow over REAL modules (handoff §15).
 * Platform bindings (Queue, Workflow) are fakes from tests/e2e/harness.ts;
 * everything else is the production code path driven via app.request().
 *
 * Test names carry the §15.2 QA ids so docs/test-report.md can map results.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sessionIdFor } from "../../src/contracts";
import type { ApprovalRecord, FinalBundle, SessionDetail } from "../../src/contracts";
import {
  DEMO_PROVIDER_ID,
  EXPECTED,
  OTHER_PROVIDER_IDENTITY,
  demoAppointment,
  demoConfig,
} from "../../fixtures/scenario";
import { createHarness, missingModules, type Harness } from "../e2e/harness";

const missing = missingModules();
const ready = missing.length === 0;
if (!ready) console.warn(`[flow.test] NOT RUN — missing modules: ${missing.join(", ")}`);

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const SID = () => sessionIdFor(DEMO_PROVIDER_ID, demoAppointment.occurrenceId);

async function detail(hh: Harness, cookie: string, id: string): Promise<SessionDetail> {
  const r = await hh.req(`/api/sessions/${id}`, { cookie });
  expect(r.status, r.text).toBe(200);
  return r.json.data as SessionDetail;
}

/** seed → sync → drain queue/workflows. Returns cookie + session id. */
async function seedAndSync(hh: Harness): Promise<{ cookie: string; id: string }> {
  const seeded = await hh.req("/api/dev/seed", { method: "POST" });
  // seed may be callable before login (operator path) or require auth; try both.
  let cookie: string;
  if (seeded.status >= 400) {
    cookie = await hh.login().catch(async () => {
      await hh.mods.seed.seedDemoData(hh.repo, { variant: hh.env.FIXTURE_VARIANT as string });
      return hh.login();
    });
    const again = await hh.req("/api/dev/seed", { method: "POST", cookie });
    if (again.status >= 400) await hh.mods.seed.seedDemoData(hh.repo, { variant: hh.env.FIXTURE_VARIANT as string });
  } else {
    cookie = await hh.login();
  }
  const sync = await hh.req("/api/sync", { method: "POST", cookie });
  expect(sync.status, sync.text).toBe(202);
  await hh.settle();
  return { cookie, id: await SID() };
}

describe.skipIf(!ready)("integration flow (real modules, fixture mode, local runtime)", () => {
  it("QA-03/05/06/07/09/10/26/27 normal path: review → 90 min → approve → COMPLETED → export", async () => {
    h = await createHarness();
    const { cookie, id } = await seedAndSync(h);

    // --- NEEDS_REVIEW rev 1, estimate only, blocked
    let d = await detail(h, cookie, id);
    expect(d.session.status).toBe("NEEDS_REVIEW");
    expect(d.session.currentBundleRevision).toBe(1);
    const b1 = d.bundle!;
    expect(b1.bundleRevision).toBe(1);
    expect(b1.billing.estimateAmountCents).toBe(EXPECTED.estimateCents60);
    expect(b1.billing.amountCents).toBeNull();
    expect(b1.billing.isEstimate).toBe(true);
    expect(b1.checks.canApprove).toBe(false);
    expect(b1.provenance).toMatchObject({ evidenceMode: "fixture", extractionMode: "fixture", runtimeMode: "local" });
    // QA-04: community goal stays unknown
    expect(b1.facts.goals.find((g) => g.goalId === "goal_community")?.status).toBe("unknown");

    // --- approve while blocked → 422
    const early = await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 1, idempotencyKey: "early-approval-attempt-001" },
    });
    expect(early.status, early.text).toBe(422);
    expect((await detail(h, cookie, id)).session.status).toBe("NEEDS_REVIEW");

    // --- review edits → rev 2, 11250, approvable
    const patch = await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: {
        expectedRevision: 1,
        edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation },
      },
    });
    expect(patch.status, patch.text).toBe(200);
    const b2 = patch.json.data;
    expect(b2.bundleRevision).toBe(2);
    expect(b2.billing.amountCents).toBe(EXPECTED.amountCents90);
    expect(b2.billing.confirmedMinutes).toBe(90);
    expect(b2.billing.hourlyRateCents).toBe(demoConfig.rate.hourlyRateCents);
    expect(b2.checks.canApprove).toBe(true);
    expect(b2.attestations.some((a: { field: string }) => a.field === "progress")).toBe(true);

    // --- stale PATCH → 409, latest unchanged
    const stale = await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: { confirmedMinutes: 60 } },
    });
    expect(stale.status, stale.text).toBe(409);
    d = await detail(h, cookie, id);
    expect(d.session.currentBundleRevision).toBe(2);
    expect(d.bundle!.billing.amountCents).toBe(EXPECTED.amountCents90);

    // --- stale approval of rev 1 → 409
    const staleApprove = await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 1, idempotencyKey: "stale-approval-attempt-01" },
    });
    expect(staleApprove.status, staleApprove.text).toBe(409);

    // --- approve rev 2 → 202 pending
    const appr = await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 2, idempotencyKey: EXPECTED.demoApprovalKey },
    });
    expect([200, 202], appr.text).toContain(appr.status);
    expect(appr.json.data.approval.bundleRevision).toBe(2);
    expect(appr.json.data.approval.approverProviderId).toBe(DEMO_PROVIDER_ID);

    // --- workflow finalizes
    await h.settle();
    d = await detail(h, cookie, id);
    expect(d.session.status).toBe("COMPLETED");
    expect(d.finalized).toBe(true);

    // --- export json
    const ej = await h.req(`/api/sessions/${id}/export?format=json`, { cookie });
    expect(ej.status, ej.text).toBe(200);
    // Export is a download document: { schemaVersion, finalized: FinalBundle, modes, approval }
    const doc = ej.json?.data ?? ej.json;
    const exported = (doc.finalized ?? doc) as FinalBundle;
    expect(exported.bundleRevision).toBe(2);
    expect(doc.modes).toMatchObject({ evidenceMode: "fixture", extractionMode: "fixture", runtimeMode: "local" });
    expect(doc.approval?.bundleRevision ?? 2).toBe(2);
    expect(exported.bundle.billing.amountCents).toBe(EXPECTED.amountCents90);
    expect(exported.bundle.billing.confirmedMinutes).toBe(90);
    expect(exported.bundle.provenance).toMatchObject({ evidenceMode: "fixture", extractionMode: "fixture", runtimeMode: "local" });

    // --- export html: escapes, discloses fixture modes
    const eh = await h.req(`/api/sessions/${id}/export?format=html`, { cookie });
    expect(eh.status).toBe(200);
    expect(eh.headers.get("content-type") ?? "").toMatch(/text\/html/);
    expect(eh.text).toMatch(/fixture/i);
    expect(eh.text).toMatch(/112\.50|11250/);
    expect(eh.text).not.toMatch(/<script/i);

    // QA-27: unsafe content renders as text
    const evil: FinalBundle = structuredClone(exported);
    evil.bundle.evidence[0]!.excerpt = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    evil.bundle.facts.activities[0]!.text = `<b onclick="x()">bold</b>`;
    const { renderExportHtml } = await import("../../src/export");
    const html: string = renderExportHtml(evil);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(`<b onclick`);
    expect(html).toContain("&lt;script&gt;");
  });

  it("QA-02a fresh-DB bootstrap over HTTP only: dev-login then POST /api/dev/seed", async () => {
    // Black-box demo path (UI 'Seed demo data', scripts/seed/seed-local.mjs, scripts/e2e/demo.mjs)
    // has no other way to create the demo provider on an empty database.
    h = await createHarness();
    const login = await h.req("/auth/dev-login", { method: "POST", body: { identity: "demo.provider@example.invalid" } });
    expect(login.status, `dev-login on empty DB: ${login.text}`).toBe(200);
  });

  it("QA-12/13/17 repeated approval with same key reuses approval; no duplicate final; key reuse with different content rejected", async () => {
    h = await createHarness();
    const { cookie, id } = await seedAndSync(h);
    await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
    });
    const body = { expectedRevision: 2, idempotencyKey: EXPECTED.demoApprovalKey };
    const a1 = await h.req(`/api/sessions/${id}/approve`, { method: "POST", cookie, body });
    expect([200, 202], a1.text).toContain(a1.status);
    const a2 = await h.req(`/api/sessions/${id}/approve`, { method: "POST", cookie, body });
    expect([200, 202], a2.text).toContain(a2.status);
    expect((a2.json.data.approval as ApprovalRecord).id).toBe((a1.json.data.approval as ApprovalRecord).id);
    await h.settle();
    const a3 = await h.req(`/api/sessions/${id}/approve`, { method: "POST", cookie, body });
    expect(a3.status, a3.text).toBe(200);
    expect(a3.json.data.finalization).toBe("finalized");
    expect(a3.json.data.approval.id).toBe(a1.json.data.approval.id);

    // Same key, different content (revision) → conflict
    const conflict = await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 1, idempotencyKey: EXPECTED.demoApprovalKey },
    });
    expect(conflict.status, conflict.text).toBe(409);

    const finals = await h.db.prepare("SELECT COUNT(*) AS n FROM final_bundles").first<{ n: number }>().catch(() => null);
    if (finals) expect(finals.n).toBe(1);
    const fb = await h.repo.getFinalBundle(id);
    expect(fb?.bundleRevision).toBe(2);
    // finalizeApproved is idempotent on retry
    const again = await h.repo.finalizeApproved(id, fb!.approvalId, 2, h.clock.now());
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.finalizedAt).toBe(fb!.finalizedAt);
    expect((await h.repo.getSession(id))?.status).toBe("COMPLETED");
  });

  it("QA-18/19/20/21 unauthenticated, other provider (404), forged fields, cross-origin", async () => {
    h = await createHarness();
    const { cookie, id } = await seedAndSync(h);

    // unauthenticated
    expect((await h.req(`/api/sessions`)).status).toBe(401);
    expect((await h.req(`/api/sessions/${id}`)).status).toBe(401);
    expect((await h.req(`/api/sync`, { method: "POST" })).status).toBe(401);

    // other provider
    const other = await h.login(OTHER_PROVIDER_IDENTITY);
    const g = await h.req(`/api/sessions/${id}`, { cookie: other });
    expect(g.status).toBe(404);
    expect(g.text).not.toContain("C-104");
    const lst = await h.req(`/api/sessions`, { cookie: other });
    expect(lst.status).toBe(200);
    expect(lst.json.data.sessions).toHaveLength(0);
    expect(
      (await h.req(`/api/sessions/${id}/review`, { method: "PATCH", cookie: other, body: { expectedRevision: 1, edits: { confirmedMinutes: 90 } } })).status,
    ).toBe(404);
    expect(
      (await h.req(`/api/sessions/${id}/approve`, { method: "POST", cookie: other, body: { expectedRevision: 1, idempotencyKey: "other-provider-key-001" } })).status,
    ).toBe(404);
    expect((await h.req(`/api/sessions/${id}/export?format=json`, { cookie: other })).status).toBe(404);

    // forged amount / provider
    const forged = await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: { amountCents: 1, hourlyRateCents: 1 } },
    });
    expect(forged.status).toBe(400);
    const forgedApprove = await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 1, idempotencyKey: "forged-provider-key-01", providerId: "provider_other_002" },
    });
    expect(forgedApprove.status).toBe(400);

    // cross-origin state change
    const xo = await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      origin: "https://evil.example",
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90 } },
    });
    expect(xo.status).toBe(403);
    const d = await detail(h, cookie, id);
    expect(d.session.currentBundleRevision).toBe(1);
  });

  it("QA-02/11 repeated seed, repeated sync and duplicate queue delivery → one session, one workflow", async () => {
    h = await createHarness();
    const { cookie, id } = await seedAndSync(h);
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    for (let i = 0; i < 2; i++) {
      const s = await h.req("/api/sync", { method: "POST", cookie });
      expect(s.status).toBe(202);
    }
    await h.settle();
    // Re-deliver every message that was ever sent (duplicate delivery).
    const { fakeBatch } = await import("../e2e/harness");
    await h.mods.jobs.handleQueueBatch(fakeBatch([...h.queue.sent, ...h.queue.sent]).batch, h.jobs);
    await h.settle();

    const list = await h.req("/api/sessions", { cookie });
    expect(list.json.data.sessions.filter((s: { id: string }) => s.id === id)).toHaveLength(1);
    expect(list.json.data.sessions).toHaveLength(1);
    expect(h.workflow.instances.size).toBe(1);
    expect([...h.workflow.instances.keys()][0]).toBe(`wf-${id}-r1`);
    const d = await detail(h, cookie, id);
    expect(d.session.processingRevision).toBe(1);
    expect(d.session.currentBundleRevision).toBe(1);
    expect(d.session.status).toBe("NEEDS_REVIEW");
  });

  it("QA-14 approval notification fails once → dispatchPendingDeliveries recovers to COMPLETED", async () => {
    h = await createHarness();
    const { cookie, id } = await seedAndSync(h);
    await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
    });
    h.workflow.failSendEvent = 1;
    const a = await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 2, idempotencyKey: EXPECTED.demoApprovalKey },
    });
    expect(a.status, a.text).toBe(202);
    await h.settle();
    let d = await detail(h, cookie, id);
    expect(d.session.status).toBe("APPROVED");
    expect(d.approval?.bundleRevision).toBe(2);
    expect(h.workflow.failSendEvent).toBe(0); // the failure was actually injected

    // durable retry (advance past any backoff)
    for (let i = 0; i < 3 && d.session.status !== "COMPLETED"; i++) {
      h.clock.advance(60 * 60_000);
      await h.mods.jobs.dispatchPendingDeliveries(h.jobs);
      await h.settle();
      d = await detail(h, cookie, id);
    }
    expect(d.session.status).toBe("COMPLETED");
    expect((await h.repo.getFinalBundle(id))?.bundleRevision).toBe(2);
  });

  it("QA-15 lost approval wake-up: durable approval found on fresh check after the wait ends", async () => {
    h = await createHarness();
    const { cookie, id } = await seedAndSync(h);
    await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
    });
    // Drop the live wake-up entirely: workflow stays waiting, approval is durable.
    h.workflow.failSendEvent = 1;
    await h.req(`/api/sessions/${id}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: 2, idempotencyKey: EXPECTED.demoApprovalKey },
    });
    // Simulate the workflow being restarted from its memoized state: the
    // fresh "check approval" step must see the durable approval.
    const inst = [...h.workflow.instances.values()][0]!;
    inst.timeoutWaits();
    await h.settle();
    expect((await h.repo.getSession(id))?.status).toBe("COMPLETED");
  });

  it("QA-16 approval wait timeout never approves or finalizes", async () => {
    h = await createHarness();
    const { id } = await seedAndSync(h);
    const inst = [...h.workflow.instances.values()][0]!;
    expect(inst.status).toBe("waiting");
    inst.timeoutWaits();
    await h.settle();
    const s = await h.repo.getSession(id);
    expect(s?.status).toBe("NEEDS_REVIEW");
    expect(await h.repo.getApprovalForSession(id)).toBeNull();
    expect(await h.repo.getFinalBundle(id)).toBeNull();
  });

  const variants: { variant: string; qa: string; status: string[] }[] = [
    { variant: "no-evidence", qa: "QA-23", status: ["NO_EVIDENCE", "WAITING_FOR_EVIDENCE"] },
    { variant: "upstream-error", qa: "QA-23", status: ["FAILED"] },
    { variant: "ambiguous", qa: "QA-22", status: ["AMBIGUOUS_MATCH"] },
    { variant: "bad-citation", qa: "QA-24", status: ["INCOMPLETE"] },
    { variant: "malformed-extraction", qa: "QA-24", status: ["INCOMPLETE"] },
    { variant: "instruction-in-transcript", qa: "QA-25", status: ["NEEDS_REVIEW"] },
    { variant: "partial-evidence", qa: "QA-03b", status: ["NEEDS_REVIEW"] },
  ];
  for (const v of variants) {
    it(`${v.qa} variant ${v.variant} → ${v.status.join("|")}, no rate/rule change`, async () => {
      h = await createHarness({ variant: v.variant });
      const { cookie, id } = await seedAndSync(h);
      const d = await detail(h, cookie, id);
      expect(v.status, `status=${d.session.status} reason=${d.session.statusReason}`).toContain(d.session.status);
      expect(d.finalized).toBe(false);
      if (d.session.status !== "NEEDS_REVIEW") {
        // no approvable fabricated bundle
        expect(d.bundle?.checks.canApprove ?? false).toBe(false);
        const a = await h.req(`/api/sessions/${id}/approve`, {
          method: "POST",
          cookie,
          body: { expectedRevision: Math.max(1, d.session.currentBundleRevision), idempotencyKey: `variant-${v.variant}-key` },
        });
        expect([404, 409, 422]).toContain(a.status);
      } else {
        const b = d.bundle!;
        expect(b.config.rate).toEqual(demoConfig.rate);
        expect(b.config.rules).toEqual(demoConfig.rules);
        expect(b.billing.hourlyRateCents).toBe(7500);
        expect(b.billing.amountCents).toBeNull();
        expect(b.billing.confirmedMinutes).toBeNull();
        expect(b.checks.canApprove).toBe(false);
        expect(b.appointment.providerId).toBe(DEMO_PROVIDER_ID);
        if (v.variant === "partial-evidence") {
          expect(b.provenance.evidenceCompleteness).toBe("partial");
          expect(b.provenance.evidenceWarnings.length).toBeGreaterThan(0);
        }
        if (v.variant === "instruction-in-transcript") {
          const p = await h.req(`/api/sessions/${id}/review`, {
            method: "PATCH",
            cookie,
            body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
          });
          expect(p.status, p.text).toBe(200);
          expect(p.json.data.billing.amountCents).toBe(EXPECTED.amountCents90);
        }
      }
      // ambiguous: competing appointment session must not be auto-attributed either
      if (v.variant === "ambiguous") {
        const all = await h.req("/api/sessions", { cookie });
        for (const s of all.json.data.sessions) expect(["COMPLETED", "APPROVED", "NEEDS_REVIEW"]).not.toContain(s.status);
      }
    });
  }
});

if (!ready) {
  describe("integration flow — NOT RUN", () => {
    it.skip(`missing: ${missing.join(", ")}`, () => {});
  });
}
