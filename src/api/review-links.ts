/**
 * Review-link API.
 *
 * Token routes (no cookie; mounted BEFORE requireActor; the token is the credential):
 *   GET   /api/review-link/:token                   → SessionDetail (same shape as GET /api/sessions/:id)
 *   PATCH /api/review-link/:token/review            ReviewRequest   → SessionBundle
 *   POST  /api/review-link/:token/approve           ApprovalRequest → ApproveResponse (202 pending / 200 finalized)
 *   GET   /api/review-link/:token/documents/:kind   → DocModel
 * Mutations still pass the global originGuard (the review page is served from the same origin).
 * The actor is the link's provider ({ providerId, identity: "review-link:<id>" }); the same
 * services as the cookie routes run (saveReview, approveSession, loadDocModelInput), so revisions,
 * blockers and idempotency rules are identical. Errors: 401 INVALID_REVIEW_LINK,
 * 410 REVIEW_LINK_EXPIRED | REVIEW_LINK_REVOKED | REVIEW_LINK_USED, 409 REVIEW_LINK_READ_ONLY.
 * Handlers catch their own failures so a 500 never logs the path (it contains the token).
 *
 * Cookie routes (behind requireActor):
 *   GET    /api/sessions/:id/review-links  → ReviewLinkView[] (never a token or hash)
 *   DELETE /api/review-links/:id           → ReviewLinkView (revoked; idempotent; other provider → 404)
 */
import { Hono, type Context } from "hono";
import { ApprovalRequest, FILE_KINDS, FileKind, ReviewRequest, workflowInstanceId, type RunRecorder } from "../contracts";
import { buildDocModel } from "../documents/index";
import { safeRecord } from "../history/index";
import {
  listReviewLinks,
  loadSessionDetail,
  resolveReviewToken,
  revokeReviewLink,
  createReviewLinkStore,
  type ReviewLinkDeps,
  type ReviewLinkRecord,
} from "../review-links";
import { apiError, log } from "../security/index";
import { ServiceError, approveSession, saveReview } from "../services/approval/index";
import { loadDocModelInput } from "../services/documents/index";
import type { Actor, ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

type C = Context<AppBindings>;
type RecordInput = Parameters<RunRecorder["record"]>[0];

const linkDeps = (deps: ApiDeps): ReviewLinkDeps => ({ repo: deps.repo, env: deps.env, clock: deps.clock });

function actorFor(link: ReviewLinkRecord): Actor {
  return { providerId: link.providerId, identity: `review-link:${link.id}` };
}

async function readJson(c: C): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function fromServiceError(c: C, err: unknown): Response {
  if (err instanceof ServiceError) {
    return apiError(c, err.status, err.code, err.message, err.retryable, err.status === 422 ? err.details : undefined);
  }
  // Never let the generic handler log the path (it contains the token).
  log("error", "review_link.unhandled_error", { method: c.req.method, errorName: err instanceof Error ? err.name : "unknown" });
  return apiError(c, 500, "INTERNAL", "Unexpected error", true);
}

async function recordFor(deps: ApiDeps, link: ReviewLinkRecord, event: Pick<RecordInput, "stage" | "status" | "label" | "meta" | "idSuffix" | "at">) {
  if (!deps.recorder) return;
  try {
    const session = await deps.repo.getSessionForProvider(link.providerId, link.sessionId);
    if (!session) return;
    await safeRecord(deps.recorder, {
      ...event,
      runId: workflowInstanceId(session.id, session.processingRevision),
      runKind: "processing",
      sessionId: session.id,
      providerId: link.providerId,
      detail: null,
    });
  } catch {
    /* history never fails the request */
  }
}

export function reviewLinkRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const ld = linkDeps(deps);

  /** Resolves the token or answers with the link error. */
  async function withLink(c: C, needMutable: boolean, fn: (link: ReviewLinkRecord) => Promise<Response>): Promise<Response> {
    try {
      const r = await resolveReviewToken(ld, c.req.param("token"));
      if (!r.ok) return apiError(c, r.status, r.code, r.message, false);
      if (needMutable && !r.mutable) {
        return apiError(c, 409, "REVIEW_LINK_READ_ONLY", "This visit was already approved; nothing can be changed through this link.", false);
      }
      return await fn(r.link);
    } catch (err) {
      return fromServiceError(c, err);
    }
  }

  app.get("/api/review-link/:token", (c) =>
    withLink(c, false, async (link) => {
      const detail = await loadSessionDetail(deps.repo, link.providerId, link.sessionId);
      if (!detail) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
      try {
        await createReviewLinkStore(deps.env.DB).touchOpened(link.id, deps.clock.now().toISOString());
      } catch {
        /* best effort */
      }
      return ok(c, detail);
    }),
  );

  app.patch("/api/review-link/:token/review", (c) =>
    withLink(c, true, async (link) => {
      const body = await readJson(c);
      if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
      const parsed = ReviewRequest.safeParse(body.value);
      if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid review request", false);
      const bundle = await saveReview(deps, actorFor(link), link.sessionId, parsed.data);
      await recordFor(deps, link, {
        stage: "review_saved",
        status: "succeeded",
        label: `Review saved via review link (revision ${bundle.bundleRevision})`,
        meta: {
          bundleRevision: bundle.bundleRevision,
          amountCents: bundle.billing.amountCents ?? bundle.billing.estimateAmountCents ?? null,
          canApprove: bundle.checks.canApprove,
          reviewLinkId: link.id,
        },
        idSuffix: `r${bundle.bundleRevision}`,
      });
      return ok(c, bundle);
    }),
  );

  app.post("/api/review-link/:token/approve", (c) =>
    withLink(c, true, async (link) => {
      const body = await readJson(c);
      if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
      const parsed = ApprovalRequest.safeParse(body.value);
      if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid approval request", false);
      const res = await approveSession(deps, actorFor(link), link.sessionId, parsed.data);
      const rev = res.approval.bundleRevision;
      await createReviewLinkStore(deps.env.DB).markUsed(link.id, res.approval.approvedAt);
      // Same id as the workflow's / cookie route's "approved" event (deduped), plus how it was approved.
      await recordFor(deps, link, {
        stage: "approved",
        status: "succeeded",
        label: "Provider approved",
        meta: { bundleRevision: rev },
        idSuffix: `r${rev}`,
        at: res.approval.approvedAt,
      });
      await recordFor(deps, link, {
        stage: "approved",
        status: "info",
        label: "Approved via review link",
        meta: { bundleRevision: rev, reviewLinkId: link.id, approvalId: res.approval.id },
        idSuffix: `review-link:r${rev}`,
        at: res.approval.approvedAt,
      });
      log("info", "review_link.approved", { reviewLinkId: link.id, sessionId: link.sessionId, bundleRevision: rev });
      return ok(c, res, res.finalization === "finalized" ? 200 : 202);
    }),
  );

  app.get("/api/review-link/:token/documents/:kind", (c) =>
    withLink(c, false, async (link) => {
      const kind = FileKind.safeParse(c.req.param("kind"));
      if (!kind.success) return apiError(c, 400, "INVALID_REQUEST", `kind must be one of ${FILE_KINDS.join(", ")}`, false);
      const templateId = c.req.query("templateId") || undefined;
      if (templateId !== undefined && templateId.length > 128) return apiError(c, 400, "INVALID_REQUEST", "Invalid templateId", false);
      const input = await loadDocModelInput(deps, link.providerId, link.sessionId, kind.data, templateId);
      return ok(c, buildDocModel(kind.data, input));
    }),
  );

  return app;
}

/** Provider (cookie) management of a session's review links. Mount after requireActor. */
export function reviewLinkAdminRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const ld = linkDeps(deps);

  app.get("/api/sessions/:id/review-links", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    if (!id || id.length > 128 || !(await deps.repo.getSessionForProvider(actor.providerId, id))) {
      return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    }
    return ok(c, await listReviewLinks(ld, actor.providerId, id));
  });

  app.delete("/api/review-links/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || id.length > 64) return apiError(c, 404, "NOT_FOUND", "Review link not found", false);
    const out = await revokeReviewLink(ld, c.get("actor").providerId, id);
    if (!out) return apiError(c, 404, "NOT_FOUND", "Review link not found", false);
    log("info", "review_link.revoked", { reviewLinkId: id });
    return ok(c, out);
  });

  return app;
}
