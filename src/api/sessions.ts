/** Provider-scoped session list/detail (Agent 15). */
import { Hono } from "hono";
import type { ListSessionsResponse, SessionDetail } from "../contracts";
import { apiError } from "../security";
import { gateReviewBundle } from "../services/profile/index";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

export function sessionRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/sessions", async (c) => {
    const actor = c.get("actor");
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return apiError(c, 400, "BAD_REQUEST", "limit must be a positive integer", false);
    const cursorRaw = c.req.query("cursor");
    if (cursorRaw !== undefined && cursorRaw.length > 512) {
      return apiError(c, 400, "BAD_REQUEST", "Invalid cursor", false);
    }
    const cursor = cursorRaw ? cursorRaw : null;
    // Archived sessions are hidden unless ?includeArchived=1 (src/archive).
    const includeArchived = c.req.query("includeArchived") === "1";
    const result = includeArchived
      ? await deps.repo.listSessionsForProvider(actor.providerId, limit, cursor, { includeArchived })
      : await deps.repo.listSessionsForProvider(actor.providerId, limit, cursor);
    const body: ListSessionsResponse = { sessions: result.sessions, nextCursor: result.nextCursor };
    return ok(c, body);
  });

  app.get("/api/sessions/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const notFound = () => apiError(c, 404, "NOT_FOUND", "Session not found", false);
    if (!id || id.length > 128) return notFound();
    const session = await deps.repo.getSessionForProvider(actor.providerId, id);
    if (!session) return notFound();
    const [appointment, bundle, approval, final] = await Promise.all([
      deps.repo.getAppointment(session.appointmentId),
      deps.repo.getCurrentBundle(session.id),
      deps.repo.getApprovalForSession(session.id),
      deps.repo.getFinalBundle(session.id),
    ]);
    // Defense in depth: appointment must belong to the same provider.
    if (!appointment || appointment.providerId !== actor.providerId) return notFound();
    // Only the CURRENT revision's approval/final count: after an amendment the previous
    // approval belongs to a superseded revision (see /revisions).
    const currentApproval = approval && approval.bundleRevision === session.currentBundleRevision ? approval : null;
    const detail: SessionDetail = {
      session,
      appointment,
      bundle: await gateReviewBundle(deps.repo, actor.providerId, bundle, session.status === "NEEDS_REVIEW"),
      approval: currentApproval,
      finalized:
        (final !== null && final.bundleRevision === session.currentBundleRevision) ||
        currentApproval?.finalizationStatus === "finalized",
    };
    return ok(c, detail);
  });

  return app;
}
