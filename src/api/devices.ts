/**
 * Paired devices, web (cookie) management. Mounted after requireActor.
 *
 *   GET    /api/devices                       → PairedDevice[] (never a key or hash)
 *   POST   /api/devices   PairDeviceRequest   → 201 PairDeviceResponse (key + pairing link, shown once)
 *   DELETE /api/devices/:id                   → { revoked: true } (the key stops working at once)
 *
 * Max MAX_ACTIVE_DEVICES active devices per provider (409 TOO_MANY_DEVICES). Contract:
 * src/contracts/devices.ts. Keys are never logged.
 */
import { Hono } from "hono";
import { PairDeviceRequest, type PairDeviceResponse } from "../contracts/devices";
import { apiError, log } from "../security";
import {
  MAX_ACTIVE_DEVICES,
  createDeviceStore,
  devicePublicOrigin,
  generateDeviceKey,
  hashDeviceKey,
  pairingLink,
  type DeviceStore,
} from "../devices";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

export function devicesRoutes(deps: ApiDeps, store: DeviceStore = createDeviceStore(deps.env.DB)): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/devices", async (c) => ok(c, await store.list(c.get("actor").providerId)));

  app.post("/api/devices", async (c) => {
    const providerId = c.get("actor").providerId;
    const body = PairDeviceRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", "Give the phone a name (1–60 characters).", false);
    if ((await store.countActive(providerId)) >= MAX_ACTIVE_DEVICES) {
      return apiError(c, 409, "TOO_MANY_DEVICES", `At most ${MAX_ACTIVE_DEVICES} paired devices. Remove one first.`, false);
    }
    const key = generateDeviceKey();
    const device = await store.create({
      id: `dev_${crypto.randomUUID().replace(/-/g, "")}`,
      providerId,
      name: body.data.name,
      keyHash: await hashDeviceKey(key),
      createdAt: deps.clock.now().toISOString(),
    });
    log("info", "device.paired", { providerId, deviceId: device.id });
    const res: PairDeviceResponse = {
      device,
      key,
      pairingLink: pairingLink({ server: devicePublicOrigin(deps.env), key, name: device.name }),
    };
    return ok(c, res, 201);
  });

  app.delete("/api/devices/:id", async (c) => {
    const providerId = c.get("actor").providerId;
    const revoked = await store.revoke(providerId, c.req.param("id"), deps.clock.now().toISOString());
    if (!revoked) return apiError(c, 404, "NOT_FOUND", "Device not found", false);
    log("info", "device.revoked", { providerId, deviceId: revoked.id });
    return ok(c, { revoked: true as const });
  });

  return app;
}
