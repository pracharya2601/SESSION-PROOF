/** POST /api/dev/seed — dev auth mode only (Agent 15). */
import { Hono } from "hono";
import { apiError } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

export function devRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.post("/api/dev/seed", async (c) => {
    if (deps.env.AUTH_MODE !== "dev" || deps.env.RUNTIME_MODE === "deployed" || !deps.seed) {
      return apiError(c, 404, "NOT_FOUND", "Not found", false);
    }
    await deps.seed();
    return ok(c, { seeded: true });
  });
  // DEV ONLY: reset one synthetic session back to "not yet discovered" (next sync re-creates it).
  app.post("/api/dev/reset-session/:id", async (c) => {
    if (deps.env.AUTH_MODE !== "dev" || deps.env.RUNTIME_MODE === "deployed") {
      return apiError(c, 404, "NOT_FOUND", "Not found", false);
    }
    const actor = c.get("actor");
    const session = await deps.repo.getSessionForProvider(actor.providerId, c.req.param("id"));
    if (!session) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    await deps.repo.devResetSession(session.id);
    return ok(c, { reset: true, sessionId: session.id });
  });

  return app;
}
