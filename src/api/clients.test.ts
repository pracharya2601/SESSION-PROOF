import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ClientInput, ClientRecord, ClientStats, ClientSummary, SessionSummary } from "../contracts";
import type { Repository } from "../db/repository";
import { clientsRoutes } from "./clients";
import type { ApiDeps, AppBindings } from "./deps";

const P1 = "provider_a";
const P2 = "provider_b";
const NOW = "2026-11-13T12:00:00.000Z";

const input = (over: Partial<ClientInput> = {}): ClientInput => ({
  clientRef: "C-1",
  displayName: "Test Person (synthetic)",
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
  ...over,
});

const session = (id: string, clientRef: string, status: SessionSummary["status"], startAt: string, amountCents: number | null = null): SessionSummary => ({
  id,
  status,
  clientRef,
  serviceCode: "DEMO",
  startAt,
  endAt: startAt,
  timezone: "UTC",
  currentBundleRevision: 1,
  statusReason: null,
  evidenceMode: null,
  extractionMode: null,
  canApprove: null,
  amountCents,
});

const ZERO: ClientStats = { sessions: 0, completed: 0, needsReview: 0, billedCents: 0, billedMinutes: 0, lastServiceAt: null };

class FakeClientsRepo {
  clients = new Map<string, ClientRecord>(); // key providerId|ref
  sessions: Record<string, SessionSummary[]> = {};
  upserts: { providerId: string; input: ClientInput }[] = [];
  async listClients(providerId: string, opts: { includeInactive: boolean; search?: string; limit: number }) {
    const q = opts.search?.toLowerCase();
    return [...this.clients.values()]
      .filter((c) => c.providerId === providerId && (opts.includeInactive || c.active))
      .filter((c) => !q || c.clientRef.toLowerCase().includes(q) || (c.displayName ?? "").toLowerCase().includes(q))
      .slice(0, opts.limit)
      .map((client) => ({ client, stats: { ...ZERO, sessions: 7 } }));
  }
  async getClient(providerId: string, ref: string) {
    return this.clients.get(`${providerId}|${ref}`) ?? null;
  }
  async upsertClient(providerId: string, inp: ClientInput, now: Date) {
    this.upserts.push({ providerId, input: inp });
    const prev = this.clients.get(`${providerId}|${inp.clientRef}`);
    const rec: ClientRecord = {
      ...inp,
      providerId,
      rateVersion: prev ? prev.rateVersion + (prev.hourlyRateCents !== inp.hourlyRateCents ? 1 : 0) : 1,
      createdAt: prev?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.clients.set(`${providerId}|${inp.clientRef}`, rec);
    return rec;
  }
  async listSessionsForProvider(providerId: string, limit: number, cursor: string | null) {
    const all = this.sessions[providerId] ?? [];
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    return { sessions: page, nextCursor: start + limit < all.length ? String(start + limit) : null };
  }
}

function setup(repo = new FakeClientsRepo()) {
  const deps = { repo: repo as unknown as Repository, clock: { now: () => new Date(NOW) }, env: {} } as unknown as ApiDeps;
  const as = (providerId: string) => {
    const app = new Hono<AppBindings>();
    app.use("*", async (c, next) => {
      c.set("correlationId", "corr-1");
      c.set("actor", { providerId, identity: `${providerId}@example.test` });
      await next();
    });
    app.route("/", clientsRoutes(deps));
    return app;
  };
  const call = async (providerId: string, method: string, path: string, body?: unknown) => {
    const res = await as(providerId).request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } };
  };
  return { repo, call };
}

describe("clients API", () => {
  it("lists stored clients plus implicit clients seen only in sessions", async () => {
    const { repo, call } = setup();
    await repo.upsertClient(P1, input(), new Date(NOW));
    repo.sessions[P1] = [
      session("s1", "C-1", "COMPLETED", "2026-11-01T10:00:00.000Z", 5000),
      session("s2", "C-9", "COMPLETED", "2026-11-02T10:00:00.000Z", 11250),
      session("s3", "C-9", "NEEDS_REVIEW", "2026-11-05T10:00:00.000Z"),
    ];
    const r = await call(P1, "GET", "/api/clients");
    expect(r.status).toBe(200);
    const list = r.json.data as ClientSummary[];
    expect(list.map((s) => s.client.clientRef)).toEqual(["C-1", "C-9"]);
    expect(list[0]!.stats.sessions).toBe(7); // stored stats come from the repo
    const imp = list[1]!;
    expect(imp.client).toMatchObject({ providerId: P1, rateVersion: 1, displayName: null, hourlyRateCents: null, active: true, customFields: [] });
    expect(imp.client.createdAt).toBe("2026-11-02T10:00:00.000Z");
    expect(imp.stats).toEqual({ sessions: 2, completed: 1, needsReview: 1, billedCents: 11250, billedMinutes: 0, lastServiceAt: "2026-11-05T10:00:00.000Z" });
  });

  it("search filters implicit clients; inactive stored clients never reappear as implicit", async () => {
    const { repo, call } = setup();
    await repo.upsertClient(P1, input({ clientRef: "C-1", active: false }), new Date(NOW));
    repo.sessions[P1] = [session("s1", "C-1", "COMPLETED", NOW), session("s2", "X-5", "COMPLETED", NOW), session("s3", "C-7", "COMPLETED", NOW)];
    expect(((await call(P1, "GET", "/api/clients")).json.data as ClientSummary[]).map((s) => s.client.clientRef).sort()).toEqual(["C-7", "X-5"]);
    expect(((await call(P1, "GET", "/api/clients?includeInactive=1")).json.data as ClientSummary[]).map((s) => s.client.clientRef).sort()).toEqual(["C-1", "C-7", "X-5"]);
    expect(((await call(P1, "GET", "/api/clients?search=x-")).json.data as ClientSummary[]).map((s) => s.client.clientRef)).toEqual(["X-5"]);
  });

  it("GET /:ref returns stored, implicit, or 404", async () => {
    const { repo, call } = setup();
    await repo.upsertClient(P1, input(), new Date(NOW));
    repo.sessions[P1] = [session("s2", "C-9", "COMPLETED", NOW, 100)];
    const stored = await call(P1, "GET", "/api/clients/C-1");
    expect(stored.status).toBe(200);
    expect(stored.json.data.client.displayName).toBe("Test Person (synthetic)");
    expect(stored.json.data.stats.sessions).toBe(7);
    const imp = await call(P1, "GET", "/api/clients/C-9");
    expect(imp.status).toBe(200);
    expect(imp.json.data.stats.billedCents).toBe(100);
    const missing = await call(P1, "GET", "/api/clients/NOPE");
    expect(missing.status).toBe(404);
    expect(missing.json.error!.code).toBe("NOT_FOUND");
  });

  it("isolates providers", async () => {
    const { repo, call } = setup();
    await repo.upsertClient(P1, input(), new Date(NOW));
    repo.sessions[P1] = [session("s2", "C-9", "COMPLETED", NOW)];
    expect((await call(P2, "GET", "/api/clients/C-1")).status).toBe(404);
    expect((await call(P2, "GET", "/api/clients/C-9")).status).toBe(404);
    expect((await call(P2, "GET", "/api/clients")).json.data).toEqual([]);
    const put = await call(P2, "PUT", "/api/clients/C-1", input({ displayName: "Other" }));
    expect(put.status).toBe(200);
    expect(put.json.data.providerId).toBe(P2);
    expect(repo.clients.get(`${P1}|C-1`)!.displayName).toBe("Test Person (synthetic)");
  });

  it("PUT validates the body with field messages", async () => {
    const { repo, call } = setup();
    const bad = await call(P1, "PUT", "/api/clients/C-1", { ...input(), hourlyRateCents: -5 });
    expect(bad.status).toBe(400);
    expect(bad.json.error!.code).toBe("INVALID_REQUEST");
    expect(bad.json.error!.message).toContain("hourlyRateCents");
    expect((await call(P1, "PUT", "/api/clients/C-1", "{not json")).status).toBe(400);
    const { customFields: _c, ...missing } = input();
    expect((await call(P1, "PUT", "/api/clients/C-1", missing)).json.error!.message).toContain("customFields");
    expect(repo.upserts).toHaveLength(0);
  });

  it("PUT rejects a clientRef mismatch and any providerId in the body", async () => {
    const { repo, call } = setup();
    const mismatch = await call(P1, "PUT", "/api/clients/C-2", input({ clientRef: "C-1" }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error!.message).toContain("clientRef");
    const withProvider = await call(P1, "PUT", "/api/clients/C-1", { ...input(), providerId: P2 });
    expect(withProvider.status).toBe(400);
    const withVersion = await call(P1, "PUT", "/api/clients/C-1", { ...input(), rateVersion: 9 });
    expect(withVersion.status).toBe(400);
    expect(repo.upserts).toHaveLength(0);
  });

  it("PUT upserts for the actor and the rate version bump is visible", async () => {
    const { call } = setup();
    const first = await call(P1, "PUT", "/api/clients/C-1", input({ hourlyRateCents: 8000 }));
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ providerId: P1, clientRef: "C-1", hourlyRateCents: 8000, rateVersion: 1 });
    const same = await call(P1, "PUT", "/api/clients/C-1", input({ hourlyRateCents: 8000, notes: "n" }));
    expect(same.json.data.rateVersion).toBe(1);
    const bumped = await call(P1, "PUT", "/api/clients/C-1", input({ hourlyRateCents: 9000 }));
    expect(bumped.json.data.rateVersion).toBe(2);
    const got = await call(P1, "GET", "/api/clients/C-1");
    expect(got.json.data.client).toMatchObject({ hourlyRateCents: 9000, rateVersion: 2 });
  });
});
