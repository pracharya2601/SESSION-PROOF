/**
 * Phone inbox (GET /api/device/inbox): the provider's sessions waiting for review, newest first,
 * each with its review-link URL. The link is reused while open (same URL on every poll) and
 * minted when missing, e.g. after an amendment reopened a completed session.
 */
import type { Repository } from "../db/repository";
import { ensureReviewLink, type ReviewLinkDeps } from "../review-links";
import { readyPhoneTitle } from "./content";
import { blockingCountOf, minutesOf } from "./index";
import type { DeviceInboxItem, DeviceInboxResponse } from "./types";

export const DEVICE_INBOX_LIMIT = 20;

export async function pendingReviewSessionIds(db: D1Database, providerId: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM sessions WHERE provider_id = ? AND status = 'NEEDS_REVIEW' ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .bind(providerId, limit)
    .all<{ id: string }>();
  return results.map((r) => String(r.id));
}

export async function buildDeviceInbox(
  deps: ReviewLinkDeps & { repo: Repository },
  providerId: string,
): Promise<DeviceInboxResponse> {
  const ids = await pendingReviewSessionIds(deps.env.DB, providerId, DEVICE_INBOX_LIMIT);
  const items: DeviceInboxItem[] = [];
  for (const id of ids) {
    const session = await deps.repo.getSessionForProvider(providerId, id);
    if (!session || session.status !== "NEEDS_REVIEW") continue;
    const [appointment, bundle] = await Promise.all([
      deps.repo.getAppointment(session.appointmentId),
      deps.repo.getCurrentBundle(session.id),
    ]);
    if (!appointment || appointment.providerId !== providerId || !bundle) continue;
    const link = await ensureReviewLink(deps, providerId, session.id);
    items.push({
      sessionId: session.id,
      clientRef: appointment.clientRef,
      serviceStartAt: appointment.startAt,
      timezone: appointment.timezone,
      bundleRevision: bundle.bundleRevision,
      blockingCount: blockingCountOf(bundle),
      minutesEstimate: minutesOf(bundle).value,
      title: readyPhoneTitle(appointment.clientRef),
      reviewUrl: link?.url ?? null,
      reviewUrlExpiresAt: link?.link.expiresAt ?? null,
      updatedAt: session.updatedAt,
    });
  }
  return { items, generatedAt: deps.clock.now().toISOString() };
}
