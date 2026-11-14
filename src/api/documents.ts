/** v3 document model route (W4): the same DocModel the PDF is rendered from, for HTML preview. */
import { Hono } from "hono";
import { FILE_KINDS, FileKind } from "../contracts";
import { buildDocModel } from "../documents/index";
import { apiError } from "../security/index";
import { ServiceError } from "../services/approval/index";
import { loadDocModelInput } from "../services/documents/index";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

const validId = (id: string | undefined): id is string => typeof id === "string" && id.length > 0 && id.length <= 128;

export function documentsRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/sessions/:id/documents/:kind", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const kind = FileKind.safeParse(c.req.param("kind"));
    if (!kind.success) return apiError(c, 400, "INVALID_REQUEST", `kind must be one of ${FILE_KINDS.join(", ")}`, false);
    const templateId = c.req.query("templateId") || undefined;
    if (templateId !== undefined && templateId.length > 128) {
      return apiError(c, 400, "INVALID_REQUEST", "Invalid templateId", false);
    }
    try {
      const input = await loadDocModelInput(deps, c.get("actor").providerId, id, kind.data, templateId);
      return ok(c, buildDocModel(kind.data, input));
    } catch (err) {
      if (err instanceof ServiceError) return apiError(c, err.status, err.code, err.message, err.retryable);
      throw err;
    }
  });

  return app;
}
