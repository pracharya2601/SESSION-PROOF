/** HTTP composition (Agent 15): security middleware, routers, error handling. */
import { Hono } from "hono";
import { authRoutes, correlationId, log, originGuard, requireActor } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { devRoutes } from "./dev";
import { healthRoutes } from "./health";
import { reviewRoutes } from "./review";
import { sessionRoutes } from "./sessions";
import { syncRoutes } from "./sync";

export { ok } from "./respond";
export { healthRoutes } from "./health";
export { sessionRoutes } from "./sessions";
export { syncRoutes } from "./sync";
export { devRoutes } from "./dev";

export function createApi(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", correlationId());
  // Session data (excerpts, facts, billing) must never be cached by browsers or proxies.
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  });
  app.use("*", originGuard(deps));

  app.route("/", authRoutes(deps));
  app.route("/", healthRoutes(deps));

  app.use("/api/*", requireActor(deps));

  app.route("/", sessionRoutes(deps));
  app.route("/", syncRoutes(deps));
  app.route("/", devRoutes(deps));
  app.route("/", reviewRoutes(deps));

  app.notFound((c) => {
    const cid = c.get("correlationId") ?? "";
    if (c.req.path.startsWith("/api/") || c.req.path === "/api" || c.req.path.startsWith("/auth/")) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found", retryable: false, correlationId: cid } }, 404);
    }
    return c.text("Not found", 404);
  });

  app.onError((err, c) => {
    const cid = c.get("correlationId") ?? "";
    // Expected service failures (Agent 16's ServiceError) map to their safe envelope.
    const se = err as { name?: unknown; status?: unknown; code?: unknown; message?: unknown; retryable?: unknown };
    if (
      se.name === "ServiceError" &&
      typeof se.status === "number" &&
      se.status >= 400 &&
      se.status < 600 &&
      typeof se.code === "string"
    ) {
      return c.json(
        {
          error: {
            code: se.code,
            message: typeof se.message === "string" ? se.message : "Request failed",
            retryable: se.retryable === true,
            correlationId: cid,
          },
        },
        se.status as 400,
      );
    }
    log("error", "api.unhandled_error", {
      correlationId: cid,
      method: c.req.method,
      path: c.req.path,
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return c.json(
      { error: { code: "INTERNAL", message: "Unexpected error", retryable: true, correlationId: cid } },
      500,
    );
  });

  return app;
}
