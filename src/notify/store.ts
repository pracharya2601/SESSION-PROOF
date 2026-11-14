/** D1 storage for notifications, preferences and the delivery log (migrations/0009_review_links.sql). */
import type { InboxNotification, NotificationKind, NotificationSettings } from "./types";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toNotification(r: Row): InboxNotification {
  return {
    id: String(r.id),
    kind: String(r.kind) as NotificationKind,
    sessionId: str(r.session_id),
    clientRef: str(r.client_ref),
    title: String(r.title),
    createdAt: String(r.created_at),
    readAt: str(r.read_at),
  };
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { email: null, emailOnReady: false, emailOnApproved: false };

export interface NotifyStore {
  /** INSERT OR IGNORE by dedupe key. Returns the notification and whether it was new. */
  add(n: {
    id: string;
    providerId: string;
    kind: NotificationKind;
    sessionId: string | null;
    clientRef: string | null;
    title: string;
    dedupeKey: string;
    createdAt: string;
  }): Promise<{ notification: InboxNotification; created: boolean }>;
  list(providerId: string, opts: { unreadOnly: boolean; limit: number }): Promise<InboxNotification[]>;
  unreadCount(providerId: string): Promise<number>;
  markRead(providerId: string, id: string, at: string): Promise<boolean>;
  markAllRead(providerId: string, at: string): Promise<number>;
  /** Marks the session's notifications of these kinds read (e.g. "ready" once it is approved). */
  markSessionRead(providerId: string, sessionId: string, kinds: NotificationKind[], at: string): Promise<void>;
  getSettings(providerId: string): Promise<NotificationSettings>;
  putSettings(providerId: string, s: NotificationSettings, at: string): Promise<NotificationSettings>;
  /** Claims a log row (INSERT OR IGNORE). false when the id already exists (already sent/claimed). */
  claimLog(l: { id: string; providerId: string; notificationId: string | null; channel: string; sender: string | null; at: string }): Promise<boolean>;
  finishLog(id: string, status: "sent" | "failed" | "skipped", code: string | null, messageId: string | null, at: string): Promise<void>;
}

export function createNotifyStore(db: D1Database): NotifyStore {
  return {
    async add(n) {
      const r = await db
        .prepare(
          `INSERT OR IGNORE INTO notifications (id, provider_id, kind, session_id, client_ref, title, dedupe_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(n.id, n.providerId, n.kind, n.sessionId, n.clientRef, n.title, n.dedupeKey, n.createdAt)
        .run();
      const created = (r.meta?.changes ?? 0) > 0;
      const row = await db
        .prepare(`SELECT id, kind, session_id, client_ref, title, created_at, read_at FROM notifications WHERE dedupe_key = ?`)
        .bind(n.dedupeKey)
        .first<Row>();
      if (!row) throw new Error("notification insert failed");
      return { notification: toNotification(row), created };
    },

    async list(providerId, opts) {
      const { results } = await db
        .prepare(
          `SELECT id, kind, session_id, client_ref, title, created_at, read_at FROM notifications
           WHERE provider_id = ? ${opts.unreadOnly ? "AND read_at IS NULL" : ""}
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(providerId, opts.limit)
        .all<Row>();
      return results.map(toNotification);
    },

    async unreadCount(providerId) {
      const r = await db
        .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE provider_id = ? AND read_at IS NULL`)
        .bind(providerId)
        .first<{ n: number }>();
      return Number(r?.n ?? 0);
    },

    async markRead(providerId, id, at) {
      const row = await db.prepare(`SELECT id FROM notifications WHERE id = ? AND provider_id = ?`).bind(id, providerId).first<Row>();
      if (!row) return false;
      await db.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND provider_id = ?`).bind(at, id, providerId).run();
      return true;
    },

    async markAllRead(providerId, at) {
      const r = await db.prepare(`UPDATE notifications SET read_at = ? WHERE provider_id = ? AND read_at IS NULL`).bind(at, providerId).run();
      return r.meta?.changes ?? 0;
    },

    async markSessionRead(providerId, sessionId, kinds, at) {
      if (kinds.length === 0) return;
      await db
        .prepare(
          `UPDATE notifications SET read_at = ? WHERE provider_id = ? AND session_id = ? AND read_at IS NULL AND kind IN (${kinds.map(() => "?").join(", ")})`,
        )
        .bind(at, providerId, sessionId, ...kinds)
        .run();
    },

    async getSettings(providerId) {
      const r = await db
        .prepare(`SELECT email, email_on_ready, email_on_approved FROM notification_settings WHERE provider_id = ?`)
        .bind(providerId)
        .first<Row>();
      if (!r) return { ...DEFAULT_NOTIFICATION_SETTINGS };
      return { email: str(r.email), emailOnReady: Number(r.email_on_ready) === 1, emailOnApproved: Number(r.email_on_approved) === 1 };
    },

    async putSettings(providerId, s, at) {
      await db
        .prepare(
          `INSERT INTO notification_settings (provider_id, email, email_on_ready, email_on_approved, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (provider_id) DO UPDATE SET email = excluded.email, email_on_ready = excluded.email_on_ready,
             email_on_approved = excluded.email_on_approved, updated_at = excluded.updated_at`,
        )
        .bind(providerId, s.email, s.emailOnReady ? 1 : 0, s.emailOnApproved ? 1 : 0, at)
        .run();
      return this.getSettings(providerId);
    },

    async claimLog(l) {
      const r = await db
        .prepare(
          `INSERT OR IGNORE INTO notification_log (id, provider_id, notification_id, channel, sender, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)`,
        )
        .bind(l.id, l.providerId, l.notificationId, l.channel, l.sender, l.at, l.at)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async finishLog(id, status, code, messageId, at) {
      await db
        .prepare(`UPDATE notification_log SET status = ?, code = ?, message_id = ?, updated_at = ? WHERE id = ?`)
        .bind(status, code, messageId, at, id)
        .run();
    },
  };
}
