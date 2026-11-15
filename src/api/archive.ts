/**
 * Archive / delete API (src/archive, migrations/0013_archive.sql). Cookie / public auth, after
 * requireActor; every call is scoped to the actor's provider (another provider's item → 404).
 *
 *   GET    /api/archive?kind=session|recording|run   → { items: ArchivedItemView[] } (recordings carry `recording`)
 *   POST   /api/archive/:kind/:id  { reason? }         → { item }            archive (idempotent)
 *   DELETE /api/archive/:kind/:id                       → { unarchived: true }
 *   DELETE /api/sessions/:id      → { deleted: true, kind, id }  409 ARCHIVE_ONLY (approved) | SESSION_BUSY
 *   DELETE /api/recordings/:id    → { deleted: true, kind, id }  409 RECORDING_ACTIVE | RECORDING_BUSY
 *   DELETE /api/runs/:runId       → { deleted: true, kind, id }  409 ARCHIVE_ONLY (processing run of a live session)
 *   GET    /api/audit?limit=      → { entries: AuditRow[] }  (ids, actions, counts; never content)
 *
 * List endpoints hide archived items: GET /api/sessions and GET /api/runs take ?includeArchived=1;
 * archived recordings are listed here (GET /api/archive?kind=recording).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Recording } from "../contracts";
import { ARCHIVE_KINDS, createArchiveService, type ArchiveKind, type ArchivedItem, type DeleteOutcome } from "../archive";
import { createRecordingStore } from "../recordings/store";
import { apiError, log } from "../security";
import type { AppBindings } from "./deps";
import type { RecordingApiDeps } from "./recordings";
import { ok } from "./respond";

export type ArchivedItemView = ArchivedItem & { recording?: Recording };

const ArchiveRequest = z.object({ reason: z.string().trim().max(200).optional() }).strict();
const Kind = z.enum(ARCHIVE_KINDS);
const MAX_ID = 200;

export function archiveRoutes(deps: RecordingApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const svc = () => createArchiveService(deps.env.DB, deps.clock);
  const recordings = () => deps.recordings?.store ?? createRecordingStore(deps.env.DB);
  const actorOf = (c: Context<AppBindings>) => c.get("actor");
  const notFound = (c: Context<AppBindings>, what = "Item") => apiError(c, 404, "NOT_FOUND", `${what} not found`, false);

  function parseKindId(c: Context<AppBindings>): { kind: ArchiveKind; id: string } | null {
    const k = Kind.safeParse(c.req.param("kind"));
    const id = c.req.param("id") ?? "";
    if (!k.success || !id || id.length > MAX_ID) return null;
    return { kind: k.data, id };
  }

  function deleted(c: Context<AppBindings>, kind: ArchiveKind, id: string, out: DeleteOutcome) {
    if (!out.ok) return apiError(c, out.status, out.code, out.message, false);
    log("info", "archive.deleted", { kind, id, providerId: actorOf(c).providerId, ...out.detail });
    return ok(c, { deleted: true as const, kind, id });
  }

  app.get("/api/archive", async (c) => {
    const raw = c.req.query("kind");
    const k = raw ? Kind.safeParse(raw) : null;
    if (k && !k.success) return apiError(c, 400, "BAD_REQUEST", "kind must be session, recording or run", false);
    const providerId = actorOf(c).providerId;
    const items: ArchivedItemView[] = await svc().listArchived(providerId, k ? k.data : null);
    const recIds = items.filter((i) => i.kind === "recording").map((i) => i.id);
    if (recIds.length) {
      const rows = await recordings().listByIds(providerId, recIds);
      const byId = new Map(rows.map((r) => [r.recording.id, r.recording]));
      for (const i of items) if (i.kind === "recording" && byId.has(i.id)) i.recording = byId.get(i.id);
    }
    return ok(c, { items });
  });

  app.post("/api/archive/:kind/:id", async (c) => {
    const ki = parseKindId(c);
    if (!ki) return notFound(c);
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return apiError(c, 400, "INVALID_REQUEST", "Body must be JSON", false);
      }
    }
    const parsed = ArchiveRequest.safeParse(body);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Only an optional reason (≤ 200 characters) is accepted", false);
    const actor = actorOf(c);
    const item = await svc().archive(actor.providerId, actor.providerId, ki.kind, ki.id, parsed.data.reason || null);
    return item ? ok(c, { item }) : notFound(c);
  });

  app.delete("/api/archive/:kind/:id", async (c) => {
    const ki = parseKindId(c);
    if (!ki) return notFound(c);
    const actor = actorOf(c);
    const done = await svc().unarchive(actor.providerId, actor.providerId, ki.kind, ki.id);
    return done ? ok(c, { unarchived: true as const }) : notFound(c, "Archived item");
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || id.length > 128) return notFound(c, "Session");
    const actor = actorOf(c);
    return deleted(c, "session", id, await svc().deleteSession(actor.providerId, actor.providerId, id));
  });

  app.delete("/api/recordings/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || id.length > 128) return notFound(c, "Recording");
    const actor = actorOf(c);
    return deleted(c, "recording", id, await svc().deleteRecording(actor.providerId, actor.providerId, id));
  });

  app.delete("/api/runs/:runId", async (c) => {
    const id = c.req.param("runId");
    if (!id || id.length > MAX_ID) return notFound(c, "Run");
    const actor = actorOf(c);
    return deleted(c, "run", id, await svc().deleteRun(actor.providerId, actor.providerId, id));
  });

  app.get("/api/audit", async (c) => {
    const n = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(n) ? Math.floor(n) : 100;
    return ok(c, { entries: await svc().listAudit(actorOf(c).providerId, limit) });
  });

  return app;
}
