/**
 * Notification contracts (in-app inbox, Settings → Notifications, phone inbox).
 * Titles and email bodies carry the client REF only: never names, transcript text or other PII.
 */
import { z } from "zod";

export const NotificationKind = z.enum(["ready_for_review", "visit_sent", "approved", "test"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export interface InboxNotification {
  id: string;
  kind: NotificationKind;
  sessionId: string | null;
  clientRef: string | null;
  title: string;
  createdAt: string;
  readAt: string | null;
}

export interface ListNotificationsResponse {
  notifications: InboxNotification[];
  unreadCount: number;
}

/** Strict, conservative address check (server and UI): one plain mailbox, no display name. */
export const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

export function isValidNotifyEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value) && !value.includes("..");
}

export const NotificationSettings = z
  .object({
    /** The provider's own address for notifications. null = no email (default). */
    email: z
      .string()
      .trim()
      .max(254)
      .refine(isValidNotifyEmail, "Enter a single email address like name@example.com")
      .nullable(),
    emailOnReady: z.boolean(),
    emailOnApproved: z.boolean(),
  })
  .strict();
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export type EmailSenderKind = "resend" | "cloudflare";

export interface NotificationSettingsView {
  settings: NotificationSettings;
  /** What the server can send with (secrets never included). */
  email: { configured: boolean; sender: EmailSenderKind | null };
}

export type EmailOutcome =
  | "sent"
  | "not_configured"
  | "no_address"
  | "disabled"
  | "failed"
  | "already_sent";

export interface TestNotificationResult {
  inApp: true;
  email: { status: EmailOutcome; sender: EmailSenderKind | null; code: string | null };
}

/** GET /api/device/inbox item: one visit waiting for the provider's review. */
export interface DeviceInboxItem {
  sessionId: string;
  clientRef: string;
  /** Appointment start (ISO) and its IANA timezone. */
  serviceStartAt: string;
  timezone: string;
  bundleRevision: number;
  blockingCount: number;
  minutesEstimate: number | null;
  /** Ready-made text for a local notification, e.g. "Visit for C-104 is ready — tap to review". */
  title: string;
  /** `${origin}/r/<token>`: opens the full review page. null when links can't be signed (no SESSION_SECRET). */
  reviewUrl: string | null;
  reviewUrlExpiresAt: string | null;
  /** When the session last changed (draft saved). */
  updatedAt: string;
}

export interface DeviceInboxResponse {
  items: DeviceInboxItem[];
  generatedAt: string;
}
