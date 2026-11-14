/**
 * Amendments + dev reset (Agent 01): reopen an approved, completed session as a new
 * revision, keep the old approval/final for audit, re-approve, finalize without the
 * original workflow, and documents reflect the amendment. Real modules + Miniflare D1.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED } from "../../fixtures/scenario";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function completeDemo(hh: V3Harness): Promise<{ cookie: string; id: string }> {
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  expect((await hh.req("/api/sync", { method: "POST", cookie })).status).toBe(202);
  await hh.settle();
  const list = await hh.req("/api/sessions", { cookie });
  const id = list.json.data.sessions[0].id as string;
  const r = await hh.req(`/api/sessions/${id}/review`, {
    method: "PATCH",
    cookie,
    body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
  });
  expect(r.status, r.text).toBe(200);
  const a = await hh.req(`/api/sessions/${id}/approve`, { method: "POST", cookie, body: { expectedRevision: 2, idempotencyKey: "approve-r2-key-0001" } });
  expect([200, 202]).toContain(a.status);
  await hh.settle();
  const d = await hh.req(`/api/sessions/${id}`, { cookie });
  expect(d.json.data.session.status).toBe("COMPLETED");
  return { cookie, id };
}

describe("amend an approved session", () => {
  it("reopens as r3, keeps r2 for audit, re-approves and finalizes again", async () => {
    h = await createV3Harness();
    const { cookie, id } = await completeDemo(h);

    // validation + stale guard
    expect((await h.req(`/api/sessions/${id}/amend`, { method: "POST", cookie, body: { expectedRevision: 2 } })).status).toBe(400);
    expect((await h.req(`/api/sessions/${id}/amend`, { method: "POST", cookie, body: { expectedRevision: 1, reason: "Wrong duration" } })).status).toBe(409);

    const am = await h.req(`/api/sessions/${id}/amend`, { method: "POST", cookie, body: { expectedRevision: 2, reason: "Visit actually ran 75 minutes" } });
    expect(am.status, am.text).toBe(200);
    expect(am.json.data.bundleRevision).toBe(3);

    let d = await h.req(`/api/sessions/${id}`, { cookie });
    expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
    expect(d.json.data.session.currentBundleRevision).toBe(3);
    expect(d.json.data.finalized).toBe(false);
    // attestations carried over + amendment reason; rate stays frozen
    const fields = d.json.data.bundle.attestations.map((x: { field: string }) => x.field).sort();
    expect(fields).toEqual(["amendment_reason", "duration", "progress"]);
    expect(d.json.data.bundle.billing.amountCents).toBe(11250);

    // amending again while open is rejected; files no longer exported for the open revision
    expect((await h.req(`/api/sessions/${id}/amend`, { method: "POST", cookie, body: { expectedRevision: 3, reason: "again" } })).status).toBe(409);

    // audit trail
    const revs = await h.req(`/api/sessions/${id}/revisions`, { cookie });
    expect(revs.status).toBe(200);
    expect(revs.json.data).toHaveLength(1);
    expect(revs.json.data[0]).toMatchObject({ bundleRevision: 2, supersededByRevision: 3, reason: "Visit actually ran 75 minutes", amountCents: 11250 });

    // edit + re-approve r4
    const r = await h.req(`/api/sessions/${id}/review`, { method: "PATCH", cookie, body: { expectedRevision: 3, edits: { confirmedMinutes: 75 } } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.billing.amountCents).toBe(9375);
    const a = await h.req(`/api/sessions/${id}/approve`, { method: "POST", cookie, body: { expectedRevision: 4, idempotencyKey: "approve-r4-key-0001" } });
    expect([200, 202], a.text).toContain(a.status);
    await h.settle();
    await h.jobs && h.mods.jobs.dispatchPendingDeliveries(h.jobs);

    d = await h.req(`/api/sessions/${id}`, { cookie });
    expect(d.json.data.session.status).toBe("COMPLETED");
    expect(d.json.data.finalized).toBe(true);
    expect(d.json.data.approval.bundleRevision).toBe(4);

    // documents + PDF reflect the amended revision
    const doc = await h.req(`/api/sessions/${id}/documents/invoice`, { cookie });
    expect(doc.status).toBe(200);
    expect(JSON.stringify(doc.json.data.blocks)).toContain("Amended revision r4");
    const pdf = await h.req(`/api/sessions/${id}/files/invoice`, { cookie });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-disposition")).toContain("_r4.pdf");

    // history records the amendment
    const runs = await h.req(`/api/runs?sessionId=${encodeURIComponent(id)}`, { cookie });
    const detail = await h.req(`/api/runs/${encodeURIComponent(runs.json.data.runs[0].runId)}`, { cookie });
    expect(detail.json.data.events.map((e: { stage: string }) => e.stage)).toContain("amended");
  });

  it("only completed sessions can be amended; other providers get 404", async () => {
    h = await createV3Harness();
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    const cookie = await h.login();
    await h.req("/api/sync", { method: "POST", cookie });
    await h.settle();
    const id = (await h.req("/api/sessions", { cookie })).json.data.sessions[0].id;
    expect((await h.req(`/api/sessions/${id}/amend`, { method: "POST", cookie, body: { expectedRevision: 1, reason: "nope" } })).status).toBe(409);
    const other = await h.login("other.provider@example.invalid");
    expect((await h.req(`/api/sessions/${id}/amend`, { method: "POST", cookie: other, body: { expectedRevision: 1, reason: "nope" } })).status).toBe(404);
    expect((await h.req(`/api/sessions/${id}/revisions`, { cookie: other })).status).toBe(404);
  });

  it("dev reset removes the session; next sync re-creates it as a fresh draft", async () => {
    h = await createV3Harness();
    const { cookie, id } = await completeDemo(h);
    const reset = await h.req(`/api/dev/reset-session/${id}`, { method: "POST", cookie });
    expect(reset.status, reset.text).toBe(200);
    const after = await h.req(`/api/sessions/${id}`, { cookie });
    expect(after.json.data.session.status).toBe("WAITING_FOR_EVIDENCE");
    expect(after.json.data.bundle).toBeNull();
    await h.req("/api/sync", { method: "POST", cookie });
    await h.settle();
    const d = await h.req(`/api/sessions/${id}`, { cookie });
    expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
    expect(d.json.data.session.currentBundleRevision).toBe(1);
    expect(d.json.data.session.processingRevision).toBe(2); // new workflow instance id
  });
});
