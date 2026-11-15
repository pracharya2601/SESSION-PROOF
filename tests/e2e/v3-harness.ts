/**
 * W9 — v3 in-process harness. Wraps the v2 harness (real repo over Miniflare D1
 * with ALL migrations, fake Queue/Workflow, clock, recording FakeCloud) and adds:
 *   - the v3 routers (clients, templates, documents, runs) unless createApi already mounts them
 *   - a real RunRecorder (src/history) injected into api / jobs / workflow / delivery deps
 *   - workflow `resolveClient` (repo.getClient by appointment.clientRef)
 *   - extractor `resolveKnownTerms` (clientKnownTerms → PII scrubber NAME terms)
 * mirroring the v3 composition root (src/index.ts) wiring described in docs/interfaces-v3.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createV2Harness, type V2Harness } from "./v2-harness";

const ROOT = resolve(__dirname, "../..");

export const V3_MODULES = {
  migration: { path: "migrations/0004_v3.sql", owner: "W1" },
  documents: { path: "src/documents/index.ts", owner: "W2" },
  clients: { path: "src/clients/index.ts", owner: "W3" },
  clientsApi: { path: "src/api/clients.ts", owner: "W3" },
  docService: { path: "src/services/documents/index.ts", owner: "W4" },
  templatesApi: { path: "src/api/templates.ts", owner: "W4" },
  documentsApi: { path: "src/api/documents.ts", owner: "W4" },
  history: { path: "src/history/index.ts", owner: "W5" },
  runsApi: { path: "src/api/runs.ts", owner: "W5" },
} as const;

export function missingV3Modules(): string[] {
  return Object.values(V3_MODULES)
    .filter((m) => !existsSync(resolve(ROOT, m.path)))
    .map((m) => `${m.path} (${m.owner})`);
}

export interface V3Harness extends V2Harness {
  v3: Record<string, any>;
  recorder: { record(e: any): Promise<void> };
  /** Which v3 routers createApi already mounts (Agent 01), so the harness did not. */
  v3MountedByCreateApi: Record<string, boolean>;
  /** Whether src/index.ts wires each v3 composition hook (informational). */
  indexWiring: Record<string, boolean>;
  responses: string[];
  req(
    path: string,
    o?: { method?: string; body?: unknown; cookie?: string | null; origin?: string | null },
  ): Promise<{ status: number; json: any; text: string; headers: Headers; bytes: Uint8Array }>;
}

export async function createV3Harness(opts: { variant?: string } = {}): Promise<V3Harness> {
  const h = (await createV2Harness(opts)) as V2Harness & { responses: string[] };
  const v3 = {
    documents: await import("../../src/documents"),
    clients: await import("../../src/clients"),
    clientsApi: await import("../../src/api/clients"),
    docService: await import("../../src/services/documents"),
    templatesApi: await import("../../src/api/templates"),
    documentsApi: await import("../../src/api/documents"),
    history: await import("../../src/history"),
    runsApi: await import("../../src/api/runs"),
  } as Record<string, any>;

  const { repo, clock, env, mods, jobs } = h;
  const recorder = v3.history.createRunRecorder(repo, clock);
  const resolveClient = async (appt: { providerId: string; clientRef: string }) =>
    appt?.clientRef ? repo.getClient(appt.providerId, appt.clientRef) : null;
  const resolveKnownTerms = async (a: any, b?: string) => {
    // Accept (appointment) or (providerId, clientRef).
    const providerId = typeof a === "string" ? a : a?.providerId;
    const clientRef = typeof a === "string" ? b : a?.clientRef;
    if (!providerId || !clientRef) return [];
    return v3.clients.clientKnownTerms(await repo.getClient(providerId, clientRef));
  };

  // api deps (same object the routers captured) + jobs deps
  h.apiDeps.recorder = recorder;
  jobs.recorder = recorder;
  const deliveryDeps = { repo, env, clock, fetch: h.cloud.fetch, recorder };
  jobs.processFileDelivery = (deliveryId: string) => h.v2.delivery.processFileDelivery(deliveryDeps, deliveryId);
  // Mirrors src/index.ts: amended revisions finalize without a live workflow.
  const amendMod = await import("../../src/services/approval/amend");
  jobs.finalizeDirect = (approval: any) =>
    amendMod.finalizeDirect(
      { repo, clock, recorder, resolveClient: resolveClient as any, onCompleted: (sid: string) => h.v2.delivery.onSessionCompleted(deliveryDeps, sid) },
      approval,
    );

  const recordingsMod = await import("../../src/recordings");
  const scheduleMod = await import("../../src/schedule");
  const makeExtractor = () =>
    mods.ai.createExtractor(env, {
      fetch: h.cloud.fetch,
      retryDelayMs: 0,
      resolveSettings: async (pid: string) => (await repo.getAiSettings(pid)) ?? h.v2.settings.defaultAiSettings(env),
      resolveKnownTerms,
    });
  const workflowDeps = {
    repo,
    evidence: mods.vexo.createEvidenceSource(env),
    extractor: {
      get mode() {
        return makeExtractor().mode;
      },
      extractFacts: (ctx: unknown) => makeExtractor().extractFacts(ctx),
    },
    match: mods.domain.matchEvidence,
    assemble: mods.domain.assembleBundle,
    clock,
    runtimeMode: "local",
    onCompleted: (sessionId: string) => h.v2.delivery.onSessionCompleted(deliveryDeps, sessionId),
    recorder,
    resolveClient,
    // Mirrors src/index.ts: calendar appointments (appt_cal_*) get Drive + visit context; others null.
    resolveDriveContext: recordingsMod.driveContextResolver(new scheduleMod.DemoDriveSource()),
    resolveVisitContext: recordingsMod.visitContextResolver({ store: recordingsMod.createRecordingStore(h.db), calendar: new scheduleMod.DemoCalendarSource({ clock }) }),
  };
  h.workflow.run = (params, step) => mods.workflow.runSessionWorkflow(workflowDeps, params, step);

  const apiSrc = readFileSync(resolve(ROOT, "src/api/index.ts"), "utf8");
  const v3MountedByCreateApi = {
    clients: /clientsRoutes\s*\(/.test(apiSrc),
    templates: /templatesRoutes\s*\(/.test(apiSrc),
    documents: /documentsRoutes\s*\(/.test(apiSrc),
    runs: /runsRoutes\s*\(/.test(apiSrc),
  };
  // No request has been made yet, so Hono's matcher is still unbuilt — safe to add routes.
  const app = h.app as any;
  if (!v3MountedByCreateApi.clients) app.route("/", v3.clientsApi.clientsRoutes(h.apiDeps));
  if (!v3MountedByCreateApi.templates) app.route("/", v3.templatesApi.templatesRoutes(h.apiDeps));
  if (!v3MountedByCreateApi.documents) app.route("/", v3.documentsApi.documentsRoutes(h.apiDeps));
  if (!v3MountedByCreateApi.runs) app.route("/", v3.runsApi.runsRoutes(h.apiDeps));

  const idxSrc = readFileSync(resolve(ROOT, "src/index.ts"), "utf8");
  const indexWiring = {
    recorder: /createRunRecorder\s*\(/.test(idxSrc),
    resolveClient: /resolveClient/.test(idxSrc),
    resolveKnownTerms: /resolveKnownTerms|clientKnownTerms/.test(idxSrc),
  };

  return Object.assign(h, { v3, recorder, v3MountedByCreateApi, indexWiring }) as unknown as V3Harness;
}
