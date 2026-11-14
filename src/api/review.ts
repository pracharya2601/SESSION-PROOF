/** Review, approval and approved-export routes (Agent 16). */
import { Hono, type Context } from "hono";
import { AmendRequest, ApprovalRequest, ReviewRequest, workflowInstanceId, type RunRecorder } from "../contracts";
import { exportJson, loadFinalForActor, renderExportHtml } from "../export/index";
import { apiError } from "../security/index";
import { ServiceError, approveSession, saveReview } from "../services/approval/index";
import { amendSession } from "../services/approval/amend";
import { safeRecord } from "../history/index";
import type { Actor, ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

type C = Context<AppBindings>;

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
  throw err;
}

type RecordInput = Parameters<RunRecorder["record"]>[0];

/** Records a review-route event on the session's current workflow run. Never throws. */
async function recordForSession(
  deps: ApiDeps,
  actor: Actor,
  sessionId: string,
  event: Pick<RecordInput, "stage" | "status" | "label" | "meta" | "idSuffix" | "at">,
): Promise<void> {
  if (!deps.recorder) return;
  try {
    const session = await deps.repo.getSessionForProvider(actor.providerId, sessionId);
    if (!session) return;
    await safeRecord(deps.recorder, {
      ...event,
      runId: workflowInstanceId(session.id, session.processingRevision),
      runKind: "processing",
      sessionId: session.id,
      providerId: actor.providerId,
      detail: null,
    });
  } catch {
    /* history never fails the request */
  }
}

function validId(id: string | undefined): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

export function reviewRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.patch("/api/sessions/:id/review", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const body = await readJson(c);
    if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
    const parsed = ReviewRequest.safeParse(body.value);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid review request", false);
    try {
      const bundle = await saveReview(deps, c.get("actor"), id, parsed.data);
      await recordForSession(deps, c.get("actor"), id, {
        stage: "review_saved",
        status: "succeeded",
        label: `Review saved (revision ${bundle.bundleRevision})`,
        meta: {
          bundleRevision: bundle.bundleRevision,
          amountCents: bundle.billing.amountCents ?? bundle.billing.estimateAmountCents ?? null,
          canApprove: bundle.checks.canApprove,
        },
        idSuffix: `r${bundle.bundleRevision}`,
      });
      return ok(c, bundle);
    } catch (err) {
      return fromServiceError(c, err);
    }
  });

  app.post("/api/sessions/:id/approve", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const body = await readJson(c);
    if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
    const parsed = ApprovalRequest.safeParse(body.value);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid approval request", false);
    try {
      const res = await approveSession(deps, c.get("actor"), id, parsed.data);
      // Same id as the workflow's "approved" event (deduped by the store).
      await recordForSession(deps, c.get("actor"), id, {
        stage: "approved",
        status: "succeeded",
        label: "Provider approved",
        meta: { bundleRevision: res.approval.bundleRevision },
        idSuffix: `r${res.approval.bundleRevision}`,
        // Stamp with the durable approval time so it orders before finalization events
        // (amendments finalize synchronously inside approveSession).
        at: res.approval.approvedAt,
      });
      return ok(c, res, res.finalization === "finalized" ? 200 : 202);
    } catch (err) {
      return fromServiceError(c, err);
    }
  });

  app.get("/api/sessions/:id/export", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const format = c.req.query("format") ?? "json";
    if (format !== "json" && format !== "html") {
      return apiError(c, 400, "INVALID_REQUEST", "format must be json or html", false);
    }
    try {
      const { final, approval } = await loadFinalForActor(deps.repo, c.get("actor"), id);
      const filename = `session-${id.replace(/[^A-Za-z0-9_-]/g, "")}-r${final.bundleRevision}`;
      if (format === "html") {
        return c.html(renderExportHtml(final, approval), 200, {
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        });
      }
      c.header("Content-Disposition", `attachment; filename="${filename}.json"`);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "no-store");
      return c.json(exportJson(final, approval), 200);
    } catch (err) {
      return fromServiceError(c, err);
    }
  });

  // Amend: reopen a COMPLETED session as a new revision that must be re-approved.
  app.post("/api/sessions/:id/amend", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Body must be JSON", false);
    const parsed = AmendRequest.safeParse(body.value);
    if (!parsed.success) {
      return apiError(c, 400, "INVALID_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), false);
    }
    try {
      return ok(c, await amendSession(deps, c.get("actor"), c.req.param("id"), parsed.data));
    } catch (err) {
      return fromServiceError(c, err);
    }
  });

  // Previously approved revisions replaced by amendments (audit trail).
  app.get("/api/sessions/:id/revisions", async (c) => {
    const actor = c.get("actor");
    const session = await deps.repo.getSessionForProvider(actor.providerId, c.req.param("id"));
    if (!session) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    return ok(c, await deps.repo.listSupersededRevisions(session.id));
  });

  return app;
}
