/** Run history routes (W5). Actor-scoped: every read is filtered by providerId. */
import { Hono } from "hono";
import { RunSummary, type ListRunsResponse, type RunDetail, type RunEvent } from "../contracts";
import { apiError } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

export const RUNS_PAGE_LIMIT = 50;

/** Fallback summary aggregation (used when the repo has events but no summary row for the run). */
export function summarizeEvents(events: RunEvent[]): RunSummary | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const isDelivery = first.runKind === "delivery";
  const failed = sorted.some((e) => e.stage === "failed") || (isDelivery && last.status === "failed");
  const succeeded = sorted.some((e) => e.stage === "completed") || (isDelivery && last.status === "succeeded");
  const status: RunSummary["status"] = failed
    ? "failed"
    : succeeded
      ? "succeeded"
      : last.status === "waiting"
        ? "waiting"
        : "running";
  const ended = status === "failed" || status === "succeeded";
  const metaStr = (k: string) => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const v = sorted[i]!.meta[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  };
  return {
    runId: first.runId,
    runKind: first.runKind,
    sessionId: first.sessionId,
    clientRef: metaStr("clientRef"),
    status,
    currentStage: last.stage,
    startedAt: first.at,
    endedAt: ended ? last.at : null,
    durationMs: ended ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : null,
    eventCount: sorted.length,
    aiProvider: metaStr("aiProvider"),
    model: metaStr("model"),
  };
}

export function runsRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/runs", async (c) => {
    const actor = c.get("actor");
    const statusRaw = c.req.query("status");
    let status: RunSummary["status"] | undefined;
    if (statusRaw !== undefined && statusRaw !== "") {
      const parsed = RunSummary.shape.status.safeParse(statusRaw);
      if (!parsed.success) return apiError(c, 400, "BAD_REQUEST", "Invalid status filter", false);
      status = parsed.data;
    }
    const sessionIdRaw = c.req.query("sessionId");
    if (sessionIdRaw !== undefined && sessionIdRaw.length > 128) {
      return apiError(c, 400, "BAD_REQUEST", "Invalid sessionId", false);
    }
    const cursorRaw = c.req.query("cursor");
    if (cursorRaw !== undefined && cursorRaw.length > 512) {
      return apiError(c, 400, "BAD_REQUEST", "Invalid cursor", false);
    }
    const result = await deps.repo.listRuns(actor.providerId, {
      ...(status ? { status } : {}),
      ...(sessionIdRaw ? { sessionId: sessionIdRaw } : {}),
      limit: RUNS_PAGE_LIMIT,
      cursor: cursorRaw ? cursorRaw : null,
    });
    const body: ListRunsResponse = { runs: result.runs, nextCursor: result.nextCursor };
    return ok(c, body);
  });

  app.get("/api/runs/:runId", async (c) => {
    const actor = c.get("actor");
    const notFound = () => apiError(c, 404, "NOT_FOUND", "Run not found", false);
    // Hono decodes the URL-encoded path param.
    const runId = c.req.param("runId");
    if (!runId || runId.length > 200) return notFound();
    const events = await deps.repo.listRunEvents(runId, actor.providerId);
    // Defense in depth: only this provider's events.
    const own = events.filter((e) => e.providerId === actor.providerId && e.runId === runId);
    if (own.length === 0) return notFound();
    own.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let summary: RunSummary | null = null;
    try {
      const listed = await deps.repo.listRuns(actor.providerId, { sessionId: own[0]!.sessionId, limit: RUNS_PAGE_LIMIT, cursor: null });
      summary = listed.runs.find((r) => r.runId === runId) ?? null;
    } catch {
      summary = null;
    }
    const detail: RunDetail = { summary: summary ?? summarizeEvents(own)!, events: own };
    return ok(c, detail);
  });

  return app;
}
