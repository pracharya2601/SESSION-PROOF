/** POST /api/sync — manual discovery + dispatch (Agent 15). */
import { Hono } from "hono";
import { apiError, log } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

export function syncRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.post("/api/sync", async (c) => {
    try {
      const discovery = await deps.discover();
      const dispatch = await deps.dispatch();
      return ok(c, { discovery, dispatch }, 202);
    } catch (err) {
      log("warn", "sync.failed", {
        correlationId: c.get("correlationId"),
        errorName: err instanceof Error ? err.name : "unknown",
      });
      return apiError(c, 503, "DEPENDENCY_UNAVAILABLE", "Sync temporarily unavailable", true);
    }
  });
  return app;
}
