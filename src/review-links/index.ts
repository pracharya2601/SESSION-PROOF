/**
 * Review links: `${origin}/r/<token>` opens one session's full review UI (checklist, corrections,
 * approve) without a cookie. Human review stays mandatory: opening a link never approves anything;
 * approve is a POST with the usual expectedRevision + idempotency key.
 *
 * Lifecycle (one open link per session review cycle):
 *  - ensureReviewLink reuses the newest open link (not revoked/closed/expired, at least
 *    REUSE_MIN_REMAINING_MS left), else mints a new one. Re-runs are idempotent.
 *  - Completion closes the session's links (closeSessionLinks). For CLOSED_GRACE_MS the link still
 *    shows the completed session (so the page can confirm); after that it is 410 REVIEW_LINK_USED.
 *  - An amended revision (NEEDS_REVIEW again) therefore gets a FRESH link the next time one is
 *    needed (phone inbox, test send); the closed link never reopens.
 *  - Revoked → 410 REVIEW_LINK_REVOKED; expired (7 days) → 410 REVIEW_LINK_EXPIRED;
 *    unknown/malformed → 401 INVALID_REVIEW_LINK. Lookup is by SHA-256(token) only.
 */
import { gateReviewBundle } from "../services/profile/index";
import type { SessionDetail } from "../contracts";
import type { Repository } from "../db/repository";
import { devicePublicOrigin } from "../devices/link";
import type { Env } from "../env";
import { createReviewLinkStore, type ReviewLinkRecord, type ReviewLinkStore } from "./store";
import { deriveReviewToken, hashReviewToken, isReviewToken, newReviewLinkId, reviewLinkSecret } from "./token";

export { createReviewLinkStore, type ReviewLinkRecord, type ReviewLinkStore } from "./store";
export { isReviewToken, hashReviewToken, deriveReviewToken, reviewLinkSecret, REVIEW_LINK_PREFIX } from "./token";

export const REVIEW_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A link with less than this left is not reused for a new notification. */
export const REUSE_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;
/** How long a closed link (session completed) still shows the completed session. */
export const CLOSED_GRACE_MS = 15 * 60 * 1000;

export type ReviewLinkState = "active" | "expired" | "revoked" | "used";

/** What the provider sees about a link (never the token or its hash). */
export interface ReviewLinkView extends ReviewLinkRecord {
  state: ReviewLinkState;
}

export interface ReviewLinkDeps {
  repo: Repository;
  env: Pick<Env, "DB" | "SESSION_SECRET" | "PUBLIC_APP_ORIGIN" | "PUBLIC_STREAM_ORIGIN" | "APP_ORIGIN">;
  clock: { now(): Date };
  store?: ReviewLinkStore;
}

const storeOf = (deps: ReviewLinkDeps) => deps.store ?? createReviewLinkStore(deps.env.DB);

export function reviewLinkUrl(env: ReviewLinkDeps["env"], token: string): string {
  return `${devicePublicOrigin(env)}/r/${token}`;
}

export function linkState(link: ReviewLinkRecord, now: Date): ReviewLinkState {
  if (link.revokedAt) return "revoked";
  if (Date.parse(link.expiresAt) <= now.getTime()) return "expired";
  if (link.closedAt) return "used";
  return "active";
}

export interface EnsuredLink {
  link: ReviewLinkRecord;
  token: string;
  url: string;
  created: boolean;
}

/**
 * The session's open review link (reused) or a new one. null when SESSION_SECRET is not set
 * (links cannot be signed) or the session is not the provider's.
 */
export async function ensureReviewLink(
  deps: ReviewLinkDeps,
  providerId: string,
  sessionId: string,
): Promise<EnsuredLink | null> {
  const secret = reviewLinkSecret(deps.env);
  if (!secret) return null;
  const session = await deps.repo.getSessionForProvider(providerId, sessionId);
  if (!session) return null;
  const store = storeOf(deps);
  const now = deps.clock.now();
  const open = await store.latestOpen(providerId, sessionId, new Date(now.getTime() + REUSE_MIN_REMAINING_MS).toISOString());
  if (open) {
    const token = await deriveReviewToken(secret, open.link.id);
    if ((await hashReviewToken(token)) === open.tokenHash) {
      return { link: open.link, token, url: reviewLinkUrl(deps.env, token), created: false };
    }
    // SESSION_SECRET was rotated: this link's URL cannot be rebuilt. Mint a fresh one below
    // (the old URL keeps working until it expires; its hash is still stored).
  }
  const id = newReviewLinkId();
  const token = await deriveReviewToken(secret, id);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + REVIEW_LINK_TTL_MS).toISOString();
  await store.create({ id, providerId, sessionId, tokenHash: await hashReviewToken(token), createdAt, expiresAt });
  const link: ReviewLinkRecord = {
    id,
    providerId,
    sessionId,
    createdAt,
    expiresAt,
    revokedAt: null,
    closedAt: null,
    usedAt: null,
    lastOpenedAt: null,
  };
  return { link, token, url: reviewLinkUrl(deps.env, token), created: true };
}

export type ResolvedLink =
  | { ok: true; link: ReviewLinkRecord; mutable: boolean }
  | { ok: false; status: 401 | 404 | 410; code: string; message: string };

const INVALID: ResolvedLink = {
  ok: false,
  status: 401,
  code: "INVALID_REVIEW_LINK",
  message: "This review link is not valid. Open the app and review the visit there.",
};

/**
 * Resolves a token to its link. `mutable` is false inside the closed grace window (the page may
 * show the completed session, but nothing can be changed through the link any more).
 */
export async function resolveReviewToken(deps: ReviewLinkDeps, token: string | undefined): Promise<ResolvedLink> {
  if (!isReviewToken(token)) return INVALID;
  const store = storeOf(deps);
  const link = await store.findByHash(await hashReviewToken(token));
  if (!link) return INVALID;
  const now = deps.clock.now();
  if (link.revokedAt) {
    return { ok: false, status: 410, code: "REVIEW_LINK_REVOKED", message: "This review link was turned off. Open the app to review the visit." };
  }
  if (Date.parse(link.expiresAt) <= now.getTime()) {
    return { ok: false, status: 410, code: "REVIEW_LINK_EXPIRED", message: "This review link has expired (links last 7 days). Open the app to review the visit." };
  }
  const session = await deps.repo.getSessionForProvider(link.providerId, link.sessionId);
  if (!session) return { ok: false, status: 404, code: "NOT_FOUND", message: "Session not found" };
  let closedAt = link.closedAt;
  if (!closedAt && session.status === "COMPLETED") {
    // Completed without the hook having closed the link (e.g. hook failure): close it now,
    // dated at the session's last update.
    closedAt = session.updatedAt;
    await store.closeForSession(link.sessionId, closedAt);
  }
  if (closedAt) {
    if (now.getTime() - Date.parse(closedAt) > CLOSED_GRACE_MS) {
      return { ok: false, status: 410, code: "REVIEW_LINK_USED", message: "This visit was already approved. Its final files are in the app." };
    }
    return { ok: true, link: { ...link, closedAt }, mutable: false };
  }
  return { ok: true, link, mutable: true };
}

export async function closeSessionLinks(deps: ReviewLinkDeps, sessionId: string): Promise<number> {
  return storeOf(deps).closeForSession(sessionId, deps.clock.now().toISOString());
}

export async function listReviewLinks(deps: ReviewLinkDeps, providerId: string, sessionId: string): Promise<ReviewLinkView[]> {
  const now = deps.clock.now();
  return (await storeOf(deps).listForSession(providerId, sessionId)).map((l) => ({ ...l, state: linkState(l, now) }));
}

export async function revokeReviewLink(deps: ReviewLinkDeps, providerId: string, id: string): Promise<ReviewLinkView | null> {
  const l = await storeOf(deps).revoke(providerId, id, deps.clock.now().toISOString());
  return l ? { ...l, state: linkState(l, deps.clock.now()) } : null;
}

/** Same shape and rules as GET /api/sessions/:id (src/api/sessions.ts). null → 404. */
export async function loadSessionDetail(repo: Repository, providerId: string, sessionId: string): Promise<SessionDetail | null> {
  const session = await repo.getSessionForProvider(providerId, sessionId);
  if (!session) return null;
  const [appointment, bundle, approval, final] = await Promise.all([
    repo.getAppointment(session.appointmentId),
    repo.getCurrentBundle(session.id),
    repo.getApprovalForSession(session.id),
    repo.getFinalBundle(session.id),
  ]);
  if (!appointment || appointment.providerId !== providerId) return null;
  const currentApproval = approval && approval.bundleRevision === session.currentBundleRevision ? approval : null;
  return {
    session,
    appointment,
    bundle: await gateReviewBundle(repo, providerId, bundle, session.status === "NEEDS_REVIEW"),
    approval: currentApproval,
    finalized:
      (final !== null && final.bundleRevision === session.currentBundleRevision) ||
      currentApproval?.finalizationStatus === "finalized",
  };
}
