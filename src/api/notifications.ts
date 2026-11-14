/**
 * In-app notifications and Settings → Notifications (cookie auth, behind requireActor).
 *
 *   GET  /api/notifications?unread=1&limit=n      → { notifications, unreadCount }
 *   POST /api/notifications/:id/read              → { read: true }
 *   POST /api/notifications/read-all              → { updated }
 *   GET  /api/settings/notifications              → NotificationSettingsView
 *   PUT  /api/settings/notifications  NotificationSettings (strict) → NotificationSettingsView
 *   POST /api/settings/notifications/test         → TestNotificationResult
 *
 * The notification address is the provider's own, opt-in, and never logged.
 */
import { Hono } from "hono";
import { apiError } from "../security/index";
import {
  createNotifier,
  createNotifyStore,
  NotificationSettings,
  type ListNotificationsResponse,
  type NotificationSettingsView,
} from "../notify";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function notificationRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const store = () => createNotifyStore(deps.env.DB);
  const notifier = () =>
    createNotifier({ repo: deps.repo, env: deps.env, clock: deps.clock, fetch: deps.fetch, recorder: deps.recorder, store: store() });

  const view = async (providerId: string): Promise<NotificationSettingsView> => {
    const sender = notifier().emailSender();
    return { settings: await store().getSettings(providerId), email: { configured: !!sender, sender: sender?.kind ?? null } };
  };

  app.get("/api/notifications", async (c) => {
    const providerId = c.get("actor").providerId;
    const rawLimit = c.req.query("limit");
    const n = rawLimit && /^\d+$/.test(rawLimit) ? Math.min(Math.max(Number(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const unreadOnly = c.req.query("unread") === "1";
    const s = store();
    const [notifications, unreadCount] = await Promise.all([s.list(providerId, { unreadOnly, limit: n }), s.unreadCount(providerId)]);
    const body: ListNotificationsResponse = { notifications, unreadCount };
    return ok(c, body);
  });

  app.post("/api/notifications/read-all", async (c) => {
    const updated = await store().markAllRead(c.get("actor").providerId, deps.clock.now().toISOString());
    return ok(c, { updated });
  });

  app.post("/api/notifications/:id/read", async (c) => {
    const id = c.req.param("id");
    if (!id || id.length > 64) return apiError(c, 404, "NOT_FOUND", "Notification not found", false);
    const found = await store().markRead(c.get("actor").providerId, id, deps.clock.now().toISOString());
    if (!found) return apiError(c, 404, "NOT_FOUND", "Notification not found", false);
    return ok(c, { read: true });
  });

  app.get("/api/settings/notifications", async (c) => ok(c, await view(c.get("actor").providerId)));

  app.put("/api/settings/notifications", async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    // "" means "no email" in the form; normalize before strict validation.
    const input = raw && typeof raw === "object" && (raw as { email?: unknown }).email === "" ? { ...(raw as object), email: null } : raw;
    const parsed = NotificationSettings.safeParse(input);
    if (!parsed.success) {
      return apiError(c, 400, "INVALID_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), false);
    }
    const providerId = c.get("actor").providerId;
    await store().putSettings(providerId, parsed.data, deps.clock.now().toISOString());
    return ok(c, await view(providerId));
  });

  app.post("/api/settings/notifications/test", async (c) => ok(c, await notifier().sendTest(c.get("actor").providerId)));

  return app;
}
