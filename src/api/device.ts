/**
 * Device API: a paired phone (GlassCam) authenticates with `Authorization: Bearer vfad_…`
 * (no cookie, no Origin needed). Mounted BEFORE requireActor; the global originGuard skips
 * /api/device/* only when that bearer header is present (bearer auth is not CSRF-able).
 * Everything is scoped to the device's provider; another provider's visit is 404.
 *
 *   GET  /api/device/me                                   → DeviceMe
 *   GET  /api/device/clients                              → DeviceClient[]
 *   POST /api/device/visits   DeviceStartVisitRequest     → 201 StartVisitResponse
 *   POST /api/device/visits/:id/stop                      → StopVisitResponse
 *   GET  /api/device/visits/:id                           → VisitDetail
 *
 * Visit start/stop/detail reuse the cookie routes' logic (src/api/visits.ts).
 */
import { Hono, type Context } from "hono";
import { DeviceStartVisitRequest, type DeviceClient, type DeviceMe } from "../contracts/devices";
import type { StartVisitRequest } from "../contracts";
import { apiError } from "../security";
import { createDeviceStore, requireDevice, type DeviceBindings, type DeviceStore } from "../devices";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";
import { captureStatus, startVisitAs, stopVisitAs, visitDetailAs } from "./visits";

const CLIENT_LIMIT = 200;

/** The shared visit helpers take the plain app context; DeviceBindings only adds `device`. */
const asApp = (c: Context<DeviceBindings>) => c as unknown as Context<AppBindings>;

export function deviceRoutes(deps: ApiDeps, store: DeviceStore = createDeviceStore(deps.env.DB)): Hono<DeviceBindings> {
  const app = new Hono<DeviceBindings>();
  app.use("/api/device/*", requireDevice(deps, store));

  app.get("/api/device/me", async (c) => {
    const device = c.get("device");
    const identity = (await deps.repo.getProviderIdentity(device.providerId)) ?? "";
    const server = captureStatus(deps.env).transcriber;
    const res: DeviceMe = {
      device,
      provider: { id: device.providerId, identity },
      transcribers: server && server !== "device" ? [server, "device"] : ["device"],
    };
    return ok(asApp(c), res);
  });

  app.get("/api/device/clients", async (c) => {
    const providerId = c.get("actor").providerId;
    const [active, all, refs] = await Promise.all([
      deps.repo.listClients(providerId, { includeInactive: false, limit: CLIENT_LIMIT }),
      deps.repo.listClients(providerId, { includeInactive: true, limit: CLIENT_LIMIT }),
      store.appointmentClientRefs(providerId),
    ]);
    const out: DeviceClient[] = active.map(({ client }) => ({
      clientRef: client.clientRef,
      displayName: client.displayName,
      preferredName: client.preferredName,
    }));
    // Implicit clients: a ref with a (non-band) appointment but no stored record. Inactive records stay hidden.
    const known = new Set(all.map((s) => s.client.clientRef));
    for (const ref of refs) if (!known.has(ref)) out.push({ clientRef: ref, displayName: null, preferredName: null });
    return ok(asApp(c), out.slice(0, CLIENT_LIMIT));
  });

  app.post("/api/device/visits", async (c) => {
    const body = DeviceStartVisitRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", body.error.issues.map((i) => i.message).join("; "), false);
    const { transcriber, ...rest } = body.data;
    const req: StartVisitRequest = { ...rest, ...(transcriber === "device" ? { transcriber: "device" as const } : {}) };
    return startVisitAs(deps, asApp(c), c.get("actor").providerId, req);
  });

  app.post("/api/device/visits/:id/stop", (c) => stopVisitAs(deps, asApp(c), c.get("actor").providerId, c.req.param("id")));

  app.get("/api/device/visits/:id", (c) => visitDetailAs(deps, asApp(c), c.get("actor").providerId, c.req.param("id")));

  return app;
}
