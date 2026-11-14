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
  return app;
}
