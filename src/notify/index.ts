/**
 * Notifier: tells the provider when a visit needs them, without ever bypassing review.
 *
 * Channels:
 *  - in-app inbox (always): `notifications` rows, GET /api/notifications, Today "Approvals waiting".
 *  - phone: GET /api/device/inbox lists NEEDS_REVIEW sessions with their review-link URL
 *    (computed on request; see src/api/device.ts).
 *  - email (opt-in, off unless the server has a sender AND the provider set an address + toggle).
 *
 * Content is limited to client ref, service date, minutes, blocker count and the review link.
 * Logs and run events carry ids, statuses and reason codes only. Every channel is idempotent:
 * notifications dedupe by key, emails by `email:<notification id>`.
 */
import type { Appointment, RunRecorder, SessionBundle } from "../contracts";
import { workflowInstanceId } from "../contracts";
import type { Repository } from "../db/repository";
import type { Env } from "../env";
import { safeRecord } from "../history";
import { closeSessionLinks, ensureReviewLink, type ReviewLinkDeps } from "../review-links";
import { devicePublicOrigin } from "../devices/link";
import { approvedEmail, approvedTitle, readyEmail, readyTitle, testEmail, visitSentTitle } from "./content";
import { createEmailSender, type EmailSender, type OutboundEmail } from "./email";
import { createNotifyStore, type NotifyStore } from "./store";
import type { EmailOutcome, NotificationSettings, TestNotificationResult } from "./types";

export { createNotifyStore, DEFAULT_NOTIFICATION_SETTINGS, type NotifyStore } from "./store";
export { createEmailSender, resendSender, cloudflareSender, RESEND_ENDPOINT, type EmailSender, type OutboundEmail } from "./email";
export * from "./types";

export type NotifierEnv = ReviewLinkDeps["env"] &
  Pick<Env, "RESEND_API_KEY" | "NOTIFY_FROM" | "NOTIFY_EMAIL" | "NOTIFY_EMAIL_PROVIDER">;

export interface NotifierDeps {
  repo: Repository;
  env: NotifierEnv;
  clock: { now(): Date };
  fetch?: typeof fetch;
  recorder?: RunRecorder;
  /** Override the configured sender (tests). undefined → from env; null → email off. */
  sender?: EmailSender | null;
  store?: NotifyStore;
}

export interface Notifier {
  sessionNeedsReview(sessionId: string): Promise<{ notified: boolean; email: EmailOutcome | null }>;
  sessionCompleted(sessionId: string): Promise<{ notified: boolean; email: EmailOutcome | null }>;
  visitSent(appointment: Pick<Appointment, "providerId" | "clientRef">, sessionId: string): Promise<void>;
  sendTest(providerId: string): Promise<TestNotificationResult>;
  emailSender(): EmailSender | null;
}

function log(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

function rid(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function minutesOf(bundle: SessionBundle): { value: number | null; confirmed: boolean } {
  const t = bundle.documents.timeSummary;
  if (t.confirmedMinutes !== null) return { value: t.confirmedMinutes, confirmed: true };
  return { value: t.evidenceWindowMinutes ?? t.scheduledMinutes ?? null, confirmed: false };
}

export function blockingCountOf(bundle: SessionBundle): number {
  return bundle.checks.issues.filter((i) => i.blocking).length;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const store = deps.store ?? createNotifyStore(deps.env.DB);
  const linkDeps: ReviewLinkDeps = { repo: deps.repo, env: deps.env, clock: deps.clock };
  let sender: EmailSender | null | undefined = deps.sender;
  const getSender = () => {
    if (sender === undefined) sender = createEmailSender(deps.env, { fetch: deps.fetch });
    return sender;
  };
  const nowIso = () => deps.clock.now().toISOString();

  async function email(
    providerId: string,
    logId: string,
    notificationId: string | null,
    wanted: (s: NotificationSettings) => boolean,
    build: () => Omit<OutboundEmail, "to">,
  ): Promise<{ status: EmailOutcome; code: string | null }> {
    const settings = await store.getSettings(providerId);
    if (!settings.email) return { status: "no_address", code: null };
    if (!wanted(settings)) return { status: "disabled", code: null };
    const s = getSender();
    if (!s) return { status: "not_configured", code: null };
    const at = nowIso();
    if (!(await store.claimLog({ id: logId, providerId, notificationId, channel: "email", sender: s.kind, at }))) {
      return { status: "already_sent", code: null };
    }
    const res = await s.send({ to: settings.email, ...build() });
    await store.finishLog(logId, res.ok ? "sent" : "failed", res.ok ? null : res.code, res.ok ? res.messageId : null, nowIso());
    log("notify.email", { notificationId, logId, sender: s.kind, status: res.ok ? "sent" : "failed", code: res.ok ? null : res.code });
    return res.ok ? { status: "sent", code: null } : { status: "failed", code: res.code };
  }

  return {
    emailSender: getSender,

    async sessionNeedsReview(sessionId) {
      const session = await deps.repo.getSession(sessionId);
      if (!session || session.status !== "NEEDS_REVIEW") return { notified: false, email: null };
      const [appointment, bundle] = await Promise.all([
        deps.repo.getAppointment(session.appointmentId),
        deps.repo.getCurrentBundle(session.id),
      ]);
      if (!appointment || !bundle) return { notified: false, email: null };
      const link = await ensureReviewLink(linkDeps, session.providerId, session.id);
      const { notification, created } = await store.add({
        id: rid("ntf"),
        providerId: session.providerId,
        kind: "ready_for_review",
        sessionId: session.id,
        clientRef: appointment.clientRef,
        title: readyTitle(appointment.clientRef),
        dedupeKey: `ready:${session.id}:r${bundle.bundleRevision}`,
        createdAt: nowIso(),
      });
      let outcome: { status: EmailOutcome; code: string | null } | null = null;
      if (created) {
        outcome = link
          ? await email(session.providerId, `email:${notification.id}`, notification.id, (s) => s.emailOnReady, () =>
              readyEmail({
                clientRef: appointment.clientRef,
                startAt: appointment.startAt,
                timezone: appointment.timezone,
                minutes: minutesOf(bundle),
                blockingCount: blockingCountOf(bundle),
                url: link.url,
                expiresAt: link.link.expiresAt,
              }),
            )
          : { status: "not_configured", code: "no_link_secret" };
        await safeRecord(deps.recorder, {
          runId: workflowInstanceId(session.id, session.processingRevision),
          runKind: "processing",
          sessionId: session.id,
          providerId: session.providerId,
          stage: "approval_wait",
          status: "info",
          label: outcome.status === "sent" ? "Review link sent (in-app and email)" : "Review link ready (in-app)",
          detail: null,
          meta: {
            bundleRevision: bundle.bundleRevision,
            notificationId: notification.id,
            reviewLinkId: link?.link.id ?? null,
            reviewLinkCreated: link?.created ?? false,
            email: outcome.status,
          },
          idSuffix: `notify:r${bundle.bundleRevision}`,
        });
      }
      log("notify.ready_for_review", {
        sessionId: session.id,
        notificationId: notification.id,
        created,
        reviewLinkId: link?.link.id ?? null,
        email: outcome?.status ?? null,
      });
      return { notified: created, email: outcome?.status ?? null };
    },

    async sessionCompleted(sessionId) {
      await closeSessionLinks(linkDeps, sessionId);
      const session = await deps.repo.getSession(sessionId);
      if (!session || session.status !== "COMPLETED") return { notified: false, email: null };
      const [appointment, bundle] = await Promise.all([
        deps.repo.getAppointment(session.appointmentId),
        deps.repo.getCurrentBundle(session.id),
      ]);
      if (!appointment || !bundle) return { notified: false, email: null };
      const at = nowIso();
      await store.markSessionRead(session.providerId, session.id, ["ready_for_review"], at);
      const { notification, created } = await store.add({
        id: rid("ntf"),
        providerId: session.providerId,
        kind: "approved",
        sessionId: session.id,
        clientRef: appointment.clientRef,
        title: approvedTitle(appointment.clientRef),
        dedupeKey: `approved:${session.id}:r${bundle.bundleRevision}`,
        createdAt: at,
      });
      let outcome: { status: EmailOutcome; code: string | null } | null = null;
      if (created) {
        outcome = await email(session.providerId, `email:${notification.id}`, notification.id, (s) => s.emailOnApproved, () =>
          approvedEmail({
            clientRef: appointment.clientRef,
            startAt: appointment.startAt,
            timezone: appointment.timezone,
            confirmedMinutes: bundle.billing.confirmedMinutes,
            bundleRevision: bundle.bundleRevision,
          }),
        );
      }
      log("notify.approved", { sessionId: session.id, notificationId: notification.id, created, email: outcome?.status ?? null });
      return { notified: created, email: outcome?.status ?? null };
    },

    async visitSent(appointment, sessionId) {
      const session = await deps.repo.getSession(sessionId);
      if (!session || session.providerId !== appointment.providerId) return;
      const { notification, created } = await store.add({
        id: rid("ntf"),
        providerId: session.providerId,
        kind: "visit_sent",
        sessionId: session.id,
        clientRef: appointment.clientRef,
        title: visitSentTitle(appointment.clientRef),
        dedupeKey: `visit_sent:${session.id}:p${session.processingRevision}`,
        createdAt: nowIso(),
      });
      log("notify.visit_sent", { sessionId: session.id, notificationId: notification.id, created });
    },

    async sendTest(providerId) {
      const at = nowIso();
      const { notification } = await store.add({
        id: rid("ntf"),
        providerId,
        kind: "test",
        sessionId: null,
        clientRef: null,
        title: "Test notification",
        dedupeKey: rid("test"),
        createdAt: at,
      });
      const res = await email(providerId, rid("test"), notification.id, () => true, () => testEmail(devicePublicOrigin(deps.env)));
      return { inApp: true, email: { status: res.status, sender: getSender()?.kind ?? null, code: res.code } };
    },
  };
}

/** Runs a notifier call without ever failing the caller (ids-only log on failure). */
export async function safeNotify(event: string, sessionId: string | null, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log("notify.failed", { event, sessionId, error: err instanceof Error ? err.name : "unknown" });
  }
}
