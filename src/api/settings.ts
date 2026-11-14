/** GET/PUT /api/settings/sync — provider-controlled automatic sync schedule. */
import { Hono } from "hono";
import { SYNC_HEARTBEAT_MINUTES, SyncSettings, type SyncSettingsView } from "../contracts";
import { apiError } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

async function view(deps: ApiDeps, providerId: string): Promise<SyncSettingsView> {
  const { settings, lastRunAt } = await deps.repo.getSyncSettings(providerId);
  let nextRunAt: string | null = null;
  if (settings.enabled) {
    const base = lastRunAt ? Date.parse(lastRunAt) + settings.intervalMinutes * 60_000 : deps.clock.now().getTime();
    // Runs on the first heartbeat at or after the due time.
    const hb = SYNC_HEARTBEAT_MINUTES * 60_000;
    nextRunAt = new Date(Math.ceil(Math.max(base, deps.clock.now().getTime()) / hb) * hb).toISOString();
  }
  return { settings, lastRunAt, nextRunAt, heartbeatMinutes: SYNC_HEARTBEAT_MINUTES };
}

export function settingsRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/settings/sync", async (c) => ok(c, await view(deps, c.get("actor").providerId)));

  app.put("/api/settings/sync", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, "INVALID_REQUEST", "Body must be JSON.", false);
    }
    const parsed = SyncSettings.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, "INVALID_REQUEST", parsed.error.issues.map((i) => i.message).join("; "), false);
    }
    const providerId = c.get("actor").providerId;
    await deps.repo.saveSyncSettings(providerId, parsed.data, deps.clock.now());
    return ok(c, await view(deps, providerId));
  });

  return app;
}
