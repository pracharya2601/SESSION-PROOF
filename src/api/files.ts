/** v2 Files dashboard + PDF downloads (Agent V7). */
import { Hono } from "hono";
import { FILE_LABELS, FileKind, type CompletedSessionFiles, type ListFilesResponse } from "../contracts";
import { sessionFiles } from "../artifacts/index";
import { buildDocModel, renderDocModelPdf } from "../documents/index";
import { apiError } from "../security/index";
import { ServiceError } from "../services/approval/index";
import { loadCompletedForActor } from "../services/delivery/index";
import { loadDocModelInputForSession } from "../services/documents/index";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

const PAGE_SIZE = 20;

function validId(id: string | undefined): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200);
  return cleaned.length > 0 ? cleaned : "file.pdf";
}

export function filesRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/files", async (c) => {
    const actor = c.get("actor");
    const cursor = c.req.query("cursor") || null;
    if (cursor !== null && cursor.length > 256) return apiError(c, 400, "INVALID_REQUEST", "Invalid cursor", false);
    const page = await deps.repo.listCompletedForProvider(actor.providerId, PAGE_SIZE, cursor);
    const items: CompletedSessionFiles[] = [];
    for (const { session, final, approval } of page.items) {
      const b = final.bundle;
      items.push({
        sessionId: session.id,
        clientRef: b.appointment.clientRef,
        serviceCode: b.appointment.serviceCode,
        startAt: b.appointment.startAt,
        endAt: b.appointment.endAt,
        timezone: b.appointment.timezone,
        bundleRevision: final.bundleRevision,
        approvedAt: approval.approvedAt,
        approverProviderId: approval.approverProviderId,
        amountCents: b.billing.amountCents,
        confirmedMinutes: b.documents.timeSummary.confirmedMinutes ?? b.billing.confirmedMinutes,
        evidenceMode: b.provenance.evidenceMode,
        files: sessionFiles(session.id, final),
        deliveries: await deps.repo.listFileDeliveries(session.id),
      });
    }
    const body: ListFilesResponse = { items, nextCursor: page.nextCursor };
    return ok(c, body);
  });

  app.get("/api/sessions/:id/files/:kind", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const kind = FileKind.safeParse(c.req.param("kind"));
    if (!kind.success) {
      return apiError(c, 400, "INVALID_REQUEST", `kind must be one of ${Object.keys(FILE_LABELS).join(", ")}`, false);
    }
    try {
      const ctx = await loadCompletedForActor(deps, c.get("actor"), id);
      // v3: resolved template (client → provider default → builtin) + frozen client snapshot.
      const model = buildDocModel(kind.data, await loadDocModelInputForSession(deps, ctx.session, kind.data));
      const bytes = await renderDocModelPdf(model);
      const filename = safeFilename(model.filename);
      const disposition = c.req.query("inline") === "1" ? "inline" : "attachment";
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `${disposition}; filename="${filename}"`,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Correlation-Id": c.get("correlationId") ?? "",
        },
      });
    } catch (err) {
      if (err instanceof ServiceError) return apiError(c, err.status, err.code, err.message, err.retryable);
      throw err;
    }
  });

  return app;
}
