/**
 * v3 clients API (W3). All routes are scoped to the authenticated actor;
 * providerId is never read from the request.
 *
 *   GET /api/clients?search&includeInactive=1 → ClientSummary[]
 *   GET /api/clients/:ref                     → ClientSummary (404 if not the actor's)
 *   PUT /api/clients/:ref   ClientInput       → ClientRecord  (body clientRef must equal :ref)
 *
 * "Implicit" clients: a clientRef that appears in the provider's sessions but has
 * no stored client record is still listed (and readable via GET /:ref) with a
 * default record shape — rateVersion 1, all optional fields null, no custom
 * fields, active — so the list is useful before the provider has entered any
 * client details. Their createdAt/updatedAt are the earliest/latest session
 * start. Their stats are computed from session summaries; billedMinutes is 0
 * because confirmed minutes are not part of a session summary. A PUT turns an
 * implicit client into a stored record.
 */
import { Hono, type Context } from "hono";
import type { z } from "zod";
import { ClientInput, type ClientRecord, type ClientStats, type ClientSummary, type SessionSummary } from "../contracts";
import { apiError } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

const LIST_LIMIT = 200;
const SESSION_PAGE = 50;
const MAX_SESSION_PAGES = 20;

function issuesMessage(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

async function providerSessions(deps: ApiDeps, providerId: string): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_SESSION_PAGES; i++) {
    const page = await deps.repo.listSessionsForProvider(providerId, SESSION_PAGE, cursor);
    out.push(...page.sessions);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function statsFrom(sessions: SessionSummary[]): ClientStats {
  let completed = 0;
  let needsReview = 0;
  let billedCents = 0;
  let last: string | null = null;
  for (const s of sessions) {
    if (s.status === "COMPLETED") {
      completed++;
      billedCents += Math.max(0, s.amountCents ?? 0);
    }
    if (s.status === "NEEDS_REVIEW") needsReview++;
    if (!last || Date.parse(s.startAt) > Date.parse(last)) last = s.startAt;
  }
  return { sessions: sessions.length, completed, needsReview, billedCents, billedMinutes: 0, lastServiceAt: last };
}

/** Default record for a clientRef seen only in sessions. */
export function implicitClient(providerId: string, clientRef: string, sessions: SessionSummary[]): ClientSummary {
  const starts = sessions.map((s) => s.startAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const first = starts[0] ?? new Date(0).toISOString();
  const lastAt = starts[starts.length - 1] ?? first;
  const client: ClientRecord = {
    clientRef,
    providerId,
    displayName: null,
    preferredName: null,
    hourlyRateCents: null,
    fundingSource: null,
    authorizationNumber: null,
    fiscalIntermediary: null,
    authorizedHours: null,
    caseManager: null,
    customFields: [],
    templates: { session_note: null, invoice: null, approval_record: null },
    notes: null,
    active: true,
    rateVersion: 1,
    createdAt: first,
    updatedAt: lastAt,
  };
  return { client, stats: statsFrom(sessions) };
}

function groupByRef(sessions: SessionSummary[]): Map<string, SessionSummary[]> {
  const m = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const list = m.get(s.clientRef);
    if (list) list.push(s);
    else m.set(s.clientRef, [s]);
  }
  return m;
}

function readRef(c: Context<AppBindings>): string | null {
  const ref = c.req.param("ref") ?? "";
  return ClientInput.shape.clientRef.safeParse(ref).success ? ref.trim() : null;
}

export function clientsRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/clients", async (c) => {
    const providerId = c.get("actor").providerId;
    const search = c.req.query("search")?.trim() || undefined;
    const includeInactive = c.req.query("includeInactive") === "1";
    const [stored, sessions] = await Promise.all([
      deps.repo.listClients(providerId, { includeInactive, search, limit: LIST_LIMIT }),
      providerSessions(deps, providerId),
    ]);
    // Known refs include inactive records so an inactive client never reappears as implicit.
    const known = new Set(stored.map((s) => s.client.clientRef));
    if (!includeInactive || search) {
      const all = await deps.repo.listClients(providerId, { includeInactive: true, limit: LIST_LIMIT });
      for (const s of all) known.add(s.client.clientRef);
    }
    const needle = search?.toLowerCase();
    const implicit: ClientSummary[] = [];
    for (const [ref, list] of groupByRef(sessions)) {
      if (known.has(ref)) continue;
      if (needle && !ref.toLowerCase().includes(needle)) continue;
      implicit.push(implicitClient(providerId, ref, list));
    }
    implicit.sort((a, b) => Date.parse(b.stats.lastServiceAt ?? "") - Date.parse(a.stats.lastServiceAt ?? "") || a.client.clientRef.localeCompare(b.client.clientRef));
    const result: ClientSummary[] = [...stored, ...implicit].slice(0, LIST_LIMIT);
    return ok(c, result);
  });

  app.get("/api/clients/:ref", async (c) => {
    const providerId = c.get("actor").providerId;
    const ref = readRef(c);
    if (!ref) return apiError(c, 404, "NOT_FOUND", "Client not found", false);
    const client = await deps.repo.getClient(providerId, ref);
    if (client) {
      const listed = await deps.repo.listClients(providerId, { includeInactive: true, search: ref, limit: LIST_LIMIT });
      const hit = listed.find((s) => s.client.clientRef === ref);
      if (hit) return ok(c, { client, stats: hit.stats } satisfies ClientSummary);
      const sessions = (await providerSessions(deps, providerId)).filter((s) => s.clientRef === ref);
      return ok(c, { client, stats: statsFrom(sessions) } satisfies ClientSummary);
    }
    const sessions = (await providerSessions(deps, providerId)).filter((s) => s.clientRef === ref);
    if (sessions.length === 0) return apiError(c, 404, "NOT_FOUND", "Client not found", false);
    return ok(c, implicitClient(providerId, ref, sessions));
  });

  app.put("/api/clients/:ref", async (c) => {
    const providerId = c.get("actor").providerId;
    const ref = readRef(c);
    if (!ref) return apiError(c, 400, "INVALID_REQUEST", "clientRef: Use letters, numbers, . _ -", false);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, "INVALID_REQUEST", "Body must be JSON.", false);
    }
    const parsed = ClientInput.safeParse(body);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", issuesMessage(parsed.error), false);
    if (parsed.data.clientRef !== ref) {
      return apiError(c, 400, "INVALID_REQUEST", "clientRef: must match the client in the URL", false);
    }
    const saved = await deps.repo.upsertClient(providerId, parsed.data, deps.clock.now());
    return ok(c, saved);
  });

  return app;
}
