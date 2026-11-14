import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunSummary } from "../contracts";
import type { ApiDeps, AppBindings } from "./deps";
import { runsRoutes, summarizeEvents } from "./runs";

const ev = (over: Partial<RunEvent>): RunEvent => ({
  id: `${over.runId ?? "wf-s1-r1"}:${over.stage ?? "load"}:${over.status ?? "succeeded"}`,
  runId: "wf-s1-r1",
  runKind: "processing",
  sessionId: "s1",
  providerId: "prov-1",
  stage: "load",
  status: "succeeded",
  label: "x",
  detail: null,
  meta: {},
  at: "2026-11-13T12:00:00.000Z",
  ...over,
});

class FakeRepo {
  events: RunEvent[] = [
    ev({ stage: "workflow_started", status: "started", meta: { clientRef: "client-1" } }),
    ev({ stage: "extraction", at: "2026-11-13T12:00:05.000Z", meta: { aiProvider: "openai", model: "gpt-4.1" } }),
    ev({ stage: "completed", at: "2026-11-13T12:00:10.000Z" }),
    ev({ runId: "wf-s9-r1", sessionId: "s9", providerId: "prov-2", stage: "load" }),
  ];
  listCalls: { providerId: string; opts: unknown }[] = [];
  async listRunEvents(runId: string, providerId: string) {
    return this.events.filter((e) => e.runId === runId && e.providerId === providerId);
  }
  async listRuns(providerId: string, opts: { status?: RunSummary["status"]; sessionId?: string; cursor: string | null }) {
    this.listCalls.push({ providerId, opts });
    const runIds = [...new Set(this.events.filter((e) => e.providerId === providerId).map((e) => e.runId))];
    const runs = runIds
      .map((id) => summarizeEvents(this.events.filter((e) => e.runId === id))!)
      .filter((r) => (!opts.status || r.status === opts.status) && (!opts.sessionId || r.sessionId === opts.sessionId));
    return { runs, nextCursor: null };
  }
}

function appFor(providerId = "prov-1") {
  const repo = new FakeRepo();
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-1");
    c.set("actor", { providerId, identity: "p@example.test" });
    await next();
  });
  app.route("/", runsRoutes({ repo } as unknown as ApiDeps));
  return { app, repo };
}

describe("runs routes", () => {
  it("lists only the actor's runs, passing filters", async () => {
    const { app, repo } = appFor();
    const r = await app.request("/api/runs?status=succeeded&sessionId=s1&cursor=abc");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { runs: RunSummary[]; nextCursor: string | null } };
    expect(j.data.runs.map((x) => x.runId)).toEqual(["wf-s1-r1"]);
    expect(j.data.runs[0]).toMatchObject({ status: "succeeded", clientRef: "client-1", aiProvider: "openai", model: "gpt-4.1", durationMs: 10000, eventCount: 3 });
    expect(repo.listCalls[0]).toEqual({ providerId: "prov-1", opts: { status: "succeeded", sessionId: "s1", limit: 50, cursor: "abc" } });
  });

  it("rejects an invalid status filter", async () => {
    const { app } = appFor();
    expect((await app.request("/api/runs?status=bogus")).status).toBe(400);
  });

  it("returns run detail with ordered events; 404 for another provider's run or unknown run", async () => {
    const { app } = appFor();
    const r = await app.request(`/api/runs/${encodeURIComponent("wf-s1-r1")}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { summary: RunSummary; events: RunEvent[] } };
    expect(j.data.events.map((e) => e.stage)).toEqual(["workflow_started", "extraction", "completed"]);
    expect(j.data.summary.runId).toBe("wf-s1-r1");
    expect((await app.request("/api/runs/wf-s9-r1")).status).toBe(404);
    expect((await app.request("/api/runs/nope")).status).toBe(404);
  });

  it("decodes URL-encoded delivery run ids", async () => {
    const { app, repo } = appFor();
    repo.events.push(
      ev({ runId: "delivery:fd_1", runKind: "delivery", stage: "delivery_drive", status: "started" }),
      ev({ runId: "delivery:fd_1", runKind: "delivery", stage: "delivery_drive", status: "failed", at: "2026-11-13T12:00:01.000Z" }),
    );
    const r = await app.request(`/api/runs/${encodeURIComponent("delivery:fd_1")}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { summary: RunSummary } };
    expect(j.data.summary).toMatchObject({ runKind: "delivery", status: "failed" });
  });
});
