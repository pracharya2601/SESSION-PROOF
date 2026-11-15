/** HTTP composition (Agent 15): security middleware, routers, error handling. */
import { Hono } from "hono";
import { authRoutes, correlationId, log, originGuard, requireActor } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { devRoutes } from "./dev";
import { healthRoutes } from "./health";
import { reviewRoutes } from "./review";
import { assistantRoutes } from "./assistant";
import { sessionRoutes } from "./sessions";
import { syncRoutes } from "./sync";
import { settingsRoutes } from "./settings";
import { settingsV2Routes } from "./settings-v2";
import { filesRoutes } from "./files";
import { deliveryRoutes } from "./deliveries";
import { connectionsRoutes } from "../connections";
import { clientsRoutes } from "./clients";
import { templatesRoutes } from "./templates";
import { documentsRoutes } from "./documents";
import { runsRoutes } from "./runs";
import { visitsRoutes, visitStreamRoutes } from "./visits";
import { deviceRoutes } from "./device";
import { offlineVisitRoutes } from "./offline-visits";
import { recordingDeviceRoutes, recordingStreamRoutes, recordingWebRoutes } from "./recordings";
import { devicesRoutes } from "./devices";
import { hasDeviceBearer } from "../devices";
import { reviewLinkAdminRoutes, reviewLinkRoutes } from "./review-links";
import { notificationRoutes } from "./notifications";
import { archiveRoutes } from "./archive";
import { recordingTimelineRoutes } from "./recording-timeline";

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
  // CSRF guard. Exception: the device API with `Authorization: Bearer vfad_…` (a native app;
  // bearer auth is not CSRF-able). Without that header /api/device/* is guarded like the rest.
  const guard = originGuard(deps);
  app.use("*", (c, next) =>
    c.req.path.startsWith("/api/device/") && hasDeviceBearer(c.req.header("Authorization")) ? next() : guard(c, next),
  );

  app.route("/", authRoutes(deps));
  app.route("/", healthRoutes(deps));
  // Band audio stream: authenticates itself (stream token for native bridges, or cookie + Origin).
  app.route("/", visitStreamRoutes(deps));
  // Paired-device API (GlassCam): device-key bearer auth, no cookie.
  app.route("/", deviceRoutes(deps));
  app.route("/", offlineVisitRoutes(deps)); // offline recordings (device key): docs/offline-recording.md
  app.route("/", recordingDeviceRoutes(deps)); // client-less recordings (device key) + stream token: docs/recordings.md
  app.route("/", recordingStreamRoutes(deps));
  // Review links (/r/<token>): the token is the credential, no cookie. Mutations keep originGuard.
  app.route("/", reviewLinkRoutes(deps));

  app.use("/api/*", requireActor(deps));

  app.route("/", sessionRoutes(deps));
  app.route("/", syncRoutes(deps));
  app.route("/", settingsRoutes(deps));
  app.route("/", devRoutes(deps));
  app.route("/", reviewRoutes(deps));
  app.route("/", assistantRoutes(deps)); // review assistant: proposes edits only (src/assistant)
  // v2: files, deliveries (drive + email drafts), settings, cloud connections.
  // connectionsRoutes also serves GET /auth/connect/:provider/callback, which is
  // outside /api/* and therefore not behind requireActor (state row carries identity).
  app.route("/", settingsV2Routes(deps));
  app.route("/", filesRoutes(deps));
  app.route("/", deliveryRoutes(deps));
  app.route("/", connectionsRoutes(deps));
  // v3: clients + per-client rate, document templates, HTML/PDF document model.
  app.route("/", clientsRoutes(deps));
  app.route("/", templatesRoutes(deps));
  app.route("/", documentsRoutes(deps));
  app.route("/", runsRoutes(deps));
  // Band visits: record a visit with a Vexo band; the transcript becomes the session evidence.
  app.route("/", visitsRoutes(deps));
  app.route("/", recordingWebRoutes(deps)); // recordings + partition outcome (web)
  app.route("/", recordingTimelineRoutes(deps)); // recording detail: calendar lanes
  app.route("/", archiveRoutes(deps)); // archive / unarchive / delete + audit (src/archive)
  // Paired devices: pair / list / revoke (Settings → Devices).
  app.route("/", devicesRoutes(deps));
  // Approval hand-off: in-app inbox, Settings → Notifications, review-link management.
  app.route("/", notificationRoutes(deps));
  app.route("/", reviewLinkAdminRoutes(deps));

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
