/** v2 delivery routes: list, Drive upload, email draft (Agent V7). Drafts are never sent. */
import { Hono, type Context } from "hono";
import { DriveUploadRequest, EmailDraftRequest } from "../contracts";
import { apiError } from "../security/index";
import { ServiceError } from "../services/approval/index";
import { createEmailDraft, uploadToDrive } from "../services/delivery/index";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

type C = Context<AppBindings>;

function validId(id: string | undefined): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

async function readJson(c: C): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const text = await c.req.text();
    return { ok: true, value: text.trim() === "" ? {} : JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function fromServiceError(c: C, err: unknown): Response {
  if (err instanceof ServiceError) return apiError(c, err.status, err.code, err.message, err.retryable);
  throw err;
}

export function deliveryRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/sessions/:id/deliveries", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const session = await deps.repo.getSessionForProvider(c.get("actor").providerId, id);
    if (!session) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    return ok(c, await deps.repo.listFileDeliveries(id));
  });

  app.post("/api/sessions/:id/deliveries/drive", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const body = await readJson(c);
    if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
    const parsed = DriveUploadRequest.safeParse(body.value);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid drive upload request", false);
    try {
      return ok(c, await uploadToDrive(deps, c.get("actor"), id, parsed.data), 201);
    } catch (err) {
      return fromServiceError(c, err);
    }
  });

  app.post("/api/sessions/:id/deliveries/email-draft", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const body = await readJson(c);
    if (!body.ok) return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
    const parsed = EmailDraftRequest.safeParse(body.value);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid email draft request", false);
    try {
      return ok(c, await createEmailDraft(deps, c.get("actor"), id, parsed.data), 201);
    } catch (err) {
      return fromServiceError(c, err);
    }
  });

  return app;
}
