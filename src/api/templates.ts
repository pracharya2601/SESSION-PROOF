/**
 * v3 template designer API (W4). Built-in templates are read-only and never
 * stored; custom templates are provider-scoped.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  FILE_KINDS,
  FileKind,
  PreviewTemplateRequest,
  TemplateInput,
  builtinTemplateId,
  type DocumentTemplate,
} from "../contracts";
import { SECTION_KEYS } from "../contracts";
import { BUILTIN_TEMPLATES, buildDocModel, normalizeTemplate, sampleDocModelInput } from "../documents/index";
import { apiError } from "../security/index";
import { ServiceError } from "../services/approval/index";
import { findTemplate, loadDocModelInput } from "../services/documents/index";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

const SetDefaultRequest = z.object({ templateId: z.string().min(1).max(128).nullable() }).strict();

function issuesMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ")
    .slice(0, 500);
}

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, "INVALID_REQUEST", "Body must be JSON", false) };
  }
  const r = schema.safeParse(body);
  if (!r.success) return { ok: false, res: apiError(c, 400, "INVALID_REQUEST", issuesMessage(r.error), false) };
  return { ok: true, data: r.data };
}

function normalize(c: Context<AppBindings>, input: TemplateInput): { ok: true; data: TemplateInput } | { ok: false; res: Response } {
  // Contract: every section key must belong to SECTION_KEYS[kind] (reject, don't silently drop).
  const allowed = SECTION_KEYS[input.kind] as readonly string[];
  const unknown = input.sections.map((s) => s.key).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      res: apiError(c, 400, "INVALID_REQUEST", `Unknown section(s) for ${input.kind}: ${unknown.join(", ")}`, false),
    };
  }
  try {
    return { ok: true, data: normalizeTemplate(input.kind, input) };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : "Invalid template";
    return { ok: false, res: apiError(c, 400, "INVALID_REQUEST", msg, false) };
  }
}

const isBuiltinId = (id: string) => id.startsWith("builtin:");
const validId = (id: string | undefined): id is string => typeof id === "string" && id.length > 0 && id.length <= 128;

function handleError(c: Context<AppBindings>, err: unknown): Response {
  if (err instanceof ServiceError) return apiError(c, err.status, err.code, err.message, err.retryable);
  throw err;
}

/** Effective default id for a kind (stored default if it still resolves, else the builtin). */
async function effectiveDefaultId(deps: ApiDeps, providerId: string, kind: FileKind): Promise<string> {
  const stored = await deps.repo.getDefaultTemplateId(providerId, kind);
  const t = await findTemplate(deps.repo, providerId, kind, stored);
  return t ? t.id : builtinTemplateId(kind);
}

export function templatesRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/templates", async (c) => {
    const actor = c.get("actor");
    const rawKind = c.req.query("kind");
    let kinds: readonly FileKind[] = FILE_KINDS;
    if (rawKind !== undefined && rawKind !== "") {
      const k = FileKind.safeParse(rawKind);
      if (!k.success) return apiError(c, 400, "INVALID_REQUEST", `kind must be one of ${FILE_KINDS.join(", ")}`, false);
      kinds = [k.data];
    }
    const custom = await deps.repo.listTemplates(actor.providerId, kinds.length === 1 ? kinds[0] : undefined);
    const out: DocumentTemplate[] = [];
    for (const kind of kinds) {
      const def = await effectiveDefaultId(deps, actor.providerId, kind);
      const builtin = BUILTIN_TEMPLATES[kind];
      out.push({ ...builtin, isDefault: builtin.id === def });
      for (const t of custom) if (t.kind === kind) out.push({ ...t, isDefault: t.id === def });
    }
    return ok(c, out);
  });

  // Specific paths first (they never collide with /:id, but keep the order explicit).
  app.put("/api/templates/default/:kind", async (c) => {
    const actor = c.get("actor");
    const k = FileKind.safeParse(c.req.param("kind"));
    if (!k.success) return apiError(c, 400, "INVALID_REQUEST", `kind must be one of ${FILE_KINDS.join(", ")}`, false);
    const body = await parseBody(c, SetDefaultRequest);
    if (!body.ok) return body.res;
    const templateId = body.data.templateId;
    if (templateId !== null) {
      const t = await findTemplate(deps.repo, actor.providerId, k.data, templateId);
      if (!t) return apiError(c, 404, "NOT_FOUND", "Template not found for this kind", false);
    }
    await deps.repo.setDefaultTemplateId(actor.providerId, k.data, templateId, deps.clock.now());
    return ok(c, { kind: k.data, templateId });
  });

  app.post("/api/templates/preview", async (c) => {
    const actor = c.get("actor");
    const body = await parseBody(c, PreviewTemplateRequest);
    if (!body.ok) return body.res;
    const n = normalize(c, body.data.template);
    if (!n.ok) return n.res;
    const template: DocumentTemplate = {
      ...n.data,
      id: "preview",
      builtin: false,
      isDefault: false,
      updatedAt: deps.clock.now().toISOString(),
    };
    try {
      const input = body.data.sessionId
        ? { ...(await loadDocModelInput(deps, actor.providerId, body.data.sessionId, template.kind)), template }
        : sampleDocModelInput(template);
      return ok(c, buildDocModel(template.kind, input));
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post("/api/templates", async (c) => {
    const actor = c.get("actor");
    const body = await parseBody(c, TemplateInput);
    if (!body.ok) return body.res;
    const n = normalize(c, body.data);
    if (!n.ok) return n.res;
    const created = await deps.repo.createTemplate(actor.providerId, `tpl_${crypto.randomUUID()}`, n.data, deps.clock.now());
    return ok(c, created, 201);
  });

  app.put("/api/templates/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Template not found", false);
    if (isBuiltinId(id)) return apiError(c, 409, "READ_ONLY", "Built-in templates are read-only; duplicate it to customize", false);
    const body = await parseBody(c, TemplateInput);
    if (!body.ok) return body.res;
    const existing = await deps.repo.getTemplate(actor.providerId, id);
    if (!existing) return apiError(c, 404, "NOT_FOUND", "Template not found", false);
    if (existing.kind !== body.data.kind) return apiError(c, 400, "INVALID_REQUEST", "Template kind cannot change", false);
    const n = normalize(c, body.data);
    if (!n.ok) return n.res;
    const updated = await deps.repo.updateTemplate(actor.providerId, id, n.data, deps.clock.now());
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Template not found", false);
    const def = await effectiveDefaultId(deps, actor.providerId, updated.kind);
    return ok(c, { ...updated, isDefault: updated.id === def });
  });

  app.delete("/api/templates/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Template not found", false);
    if (isBuiltinId(id)) return apiError(c, 409, "READ_ONLY", "Built-in templates cannot be deleted", false);
    const existing = await deps.repo.getTemplate(actor.providerId, id);
    if (!existing) return apiError(c, 404, "NOT_FOUND", "Template not found", false);
    const deleted = await deps.repo.deleteTemplate(actor.providerId, id);
    if (!deleted) return apiError(c, 404, "NOT_FOUND", "Template not found", false);
    if ((await deps.repo.getDefaultTemplateId(actor.providerId, existing.kind)) === id) {
      await deps.repo.setDefaultTemplateId(actor.providerId, existing.kind, null, deps.clock.now());
    }
    return ok(c, { deleted: true });
  });

  return app;
}
