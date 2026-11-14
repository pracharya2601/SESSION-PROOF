import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppBindings } from "./deps";
import { reviewRoutes } from "./review";
import { FakeRepo, makeDeps, PROVIDER, SESSION } from "../services/approval/testkit";

function appFor(repo = new FakeRepo(), notify?: Parameters<typeof makeDeps>[1]) {
  const { deps } = makeDeps(repo, notify);
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-1");
    c.set("actor", { providerId: PROVIDER, identity: "p@example.test" });
    await next();
  });
  app.route("/", reviewRoutes(deps));
  return { app, repo };
}

const send = (app: Hono<AppBindings>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const review = (app: Hono<AppBindings>, body: unknown) => send(app, "PATCH", `/api/sessions/${SESSION}/review`, body);
const approve = (app: Hono<AppBindings>, body: unknown) => send(app, "POST", `/api/sessions/${SESSION}/approve`, body);

describe("review routes", () => {
  it("PATCH review returns the new revision; stale revision 409", async () => {
    const { app } = appFor();
    const r = await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { bundleRevision: number; billing: { amountCents: number } }; correlationId: string };
    expect(j.data.bundleRevision).toBe(2);
    expect(j.data.billing.amountCents).toBe(11250);
    const stale = await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 60 } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("STALE_REVISION");
  });

  it("unknown edit fields, unknown top-level fields, and malformed JSON are 400", async () => {
    const { app } = appFor();
    for (const body of [
      { expectedRevision: 1, edits: { rateCents: 1 } },
      { expectedRevision: 1, edits: { confirmedMinutes: 60, hourlyRateCents: 1 } },
      { expectedRevision: 1, edits: { confirmedMinutes: 60 }, actorProviderId: "evil" },
      { expectedRevision: 1, edits: {} },
      "{not json",
    ]) {
      const r = await review(app, body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
    }
  });

  it("approval body with a client-supplied provider id is rejected; actor comes from context", async () => {
    const { app, repo } = appFor();
    await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    const bad = await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001", approverProviderId: "evil" });
    expect(bad.status).toBe(400);
    const okRes = await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    expect(okRes.status).toBe(202);
    expect(repo.approvals[0]!.approverProviderId).toBe(PROVIDER);
    expect(repo.bundles.get(`${SESSION}:2`)!.attestations[0]!.actorProviderId).toBe(PROVIDER);
  });

  it("edits after approval are 409", async () => {
    const { app } = appFor();
    await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    const r = await review(app, { expectedRevision: 2, edits: { confirmedMinutes: 60 } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("INVALID_STATE");
  });

  it("approve with blockers is 422 with details", async () => {
    const { app } = appFor();
    const r = await approve(app, { expectedRevision: 1, idempotencyKey: "key-00000001" });
    expect(r.status).toBe(422);
    const j = (await r.json()) as { error: { code: string; details: unknown[]; correlationId: string } };
    expect(j.error.code).toBe("DOCUMENTATION_BLOCKERS");
    expect(j.error.details).toHaveLength(1);
  });

  it("approve twice with same key: same approval, one persist; same key other revision 409; finalized replay 200", async () => {
    const { app, repo } = appFor();
    await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    const a = await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    const b = await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const ja = (await a.json()) as { data: { approval: unknown } };
    const jb = (await b.json()) as { data: { approval: unknown } };
    expect(jb.data.approval).toEqual(ja.data.approval);
    expect(repo.persistCalls).toBe(1);
    const c = await approve(app, { expectedRevision: 1, idempotencyKey: "key-00000001" });
    expect(c.status).toBe(409);
    expect(((await c.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
    repo.finalize(SESSION);
    const d = await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    expect(d.status).toBe(200);
  });

  it("notification failure still returns 202 with a durable approval", async () => {
    const notify = vi.fn(async () => {
      throw new Error("send failed with secret token abc");
    });
    const { app, repo } = appFor(new FakeRepo(), notify);
    await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    const r = await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    expect(r.status).toBe(202);
    expect(repo.approvals).toHaveLength(1);
    expect(repo.deliveries).toHaveLength(1);
  });

  it("unknown session is 404", async () => {
    const { app } = appFor();
    const r = await send(app, "PATCH", "/api/sessions/nope/review", { expectedRevision: 1, edits: { confirmedMinutes: 5 } });
    expect(r.status).toBe(404);
  });
});

describe("export route", () => {
  async function finalizedApp() {
    const { app, repo } = appFor();
    await review(app, { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: "<img src=x onerror=alert(1)>" } });
    await approve(app, { expectedRevision: 2, idempotencyKey: "key-00000001" });
    return { app, repo };
  }

  it("export before finalization is 409 NOT_FINALIZED", async () => {
    const { app } = await finalizedApp();
    const r = await send(app, "GET", `/api/sessions/${SESSION}/export?format=json`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("NOT_FINALIZED");
  });

  it("JSON export equals the approved revision even after later bundle changes", async () => {
    const { app, repo } = await finalizedApp();
    const final = repo.finalize(SESSION);
    // Simulate an unrelated later current bundle: export must not follow it.
    repo.bundles.set(`${SESSION}:3`, { ...final.bundle, bundleRevision: 3 });
    repo.sessions.get(SESSION)!.currentBundleRevision = 3;
    const r = await send(app, "GET", `/api/sessions/${SESSION}/export?format=json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment;/);
    const j = (await r.json()) as { schemaVersion: string; finalized: { bundleRevision: number; bundle: { bundleRevision: number } }; modes: { evidenceMode: string }; approval: { bundleRevision: number } };
    expect(j.schemaVersion).toBe("1");
    expect(j.finalized.bundleRevision).toBe(2);
    expect(j.finalized.bundle.bundleRevision).toBe(2);
    expect(j.approval.bundleRevision).toBe(2);
    expect(j.modes.evidenceMode).toBe("fixture");
  });

  it("HTML export escapes untrusted text and sets CSP headers", async () => {
    const { app, repo } = await finalizedApp();
    repo.finalize(SESSION);
    const r = await send(app, "GET", `/api/sessions/${SESSION}/export?format=html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await r.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("FIXTURE");
    expect(html).toContain("Documentation checks (not a compliance determination)");
    expect(html).toContain("key-00000001");
  });

  it("foreign provider export is 404; bad format 400", async () => {
    const { app } = appFor();
    expect((await send(app, "GET", `/api/sessions/${SESSION}/export?format=pdf`)).status).toBe(400);
    expect((await send(app, "GET", `/api/sessions/other/export`)).status).toBe(404);
  });
});
