/**
 * Device-key auth for /api/device/*: `Authorization: Bearer vfad_…`.
 * Looks the device up by SHA-256(key); revoked → 401 DEVICE_REVOKED at once.
 * Sets actor = { providerId, identity: "device:<id>" } and the device itself.
 * Keys are never logged.
 */
import type { MiddlewareHandler } from "hono";
import type { PairedDevice } from "../contracts/devices";
import type { ApiDeps, AppBindings } from "../api/deps";
import { apiError, log } from "../security";
import { bearerDeviceKey, hashDeviceKey, isDeviceKey } from "./key";
import type { DeviceStore } from "./store";

export type DeviceBindings = {
  Variables: AppBindings["Variables"] & { device: PairedDevice };
};

/** True when the request carries `Authorization: Bearer vfad_…` (used to exempt it from originGuard). */
export function hasDeviceBearer(authorization: string | undefined | null): boolean {
  return bearerDeviceKey(authorization) !== null;
}

export function requireDevice(deps: ApiDeps, store: DeviceStore): MiddlewareHandler<DeviceBindings> {
  return async (c, next) => {
    const key = bearerDeviceKey(c.req.header("Authorization"));
    if (!key || !isDeviceKey(key)) {
      return apiError(c, 401, "UNAUTHENTICATED", "Device key required (Authorization: Bearer vfad_…).", false);
    }
    const device = await store.findByKeyHash(await hashDeviceKey(key));
    if (!device) return apiError(c, 401, "UNAUTHENTICATED", "Unknown device key.", false);
    if (device.revokedAt) return apiError(c, 401, "DEVICE_REVOKED", "This device was removed. Pair it again in Settings → Devices.", false);
    // The provider must still exist (same idea as the cookie re-check in requireActor).
    if (!(await deps.repo.getProviderIdentity(device.providerId))) {
      return apiError(c, 401, "UNAUTHENTICATED", "Device provider is no longer valid.", false);
    }
    try {
      await store.touch(device.id, deps.clock.now());
    } catch {
      log("warn", "device.touch_failed", { deviceId: device.id });
    }
    c.set("device", device);
    c.set("actor", { providerId: device.providerId, identity: `device:${device.id}` });
    await next();
  };
}
