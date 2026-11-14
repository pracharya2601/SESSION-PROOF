/** GET /api/health — public, safe readiness metadata. No secrets or personal data. */
import { Hono } from "hono";
import { SCHEMA_VERSION, type HealthResponse } from "../contracts";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

export function healthRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get("/api/health", (c) => {
    const env = deps.env;
    const body: HealthResponse = {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      evidenceMode: env.EVIDENCE_MODE === "live" ? "live" : "fixture",
      extractionMode: env.EXTRACTION_MODE === "live" ? "live" : "fixture",
      runtimeMode: env.RUNTIME_MODE === "deployed" ? "deployed" : "local",
      authMode: env.AUTH_MODE === "access" ? "access" : "dev",
      bindings: {
        db: Boolean(env.DB),
        queue: Boolean(env.SESSION_QUEUE),
        workflow: Boolean(env.SESSION_WORKFLOW),
      },
    };
    return ok(c, body);
  });
  return app;
}
