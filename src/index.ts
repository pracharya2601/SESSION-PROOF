/**
 * Composition root (Agent 01). Wires modules only — no business logic here.
 * One Worker: HTTP (API + static assets), scheduled (discovery + recovery),
 * queue consumer (session processing handoff), and the SessionWorkflow class.
 */
import { systemClock, type Clock, type RuntimeMode } from "./contracts";
import type { Env } from "./env";
import { createRepository } from "./db/d1";
import { createApi } from "./api";
import type { ApiDeps } from "./api/deps";
import { assembleBundle, matchEvidence } from "./domain";
import { createEvidenceSource } from "./integrations/vexo";
import { createExtractor } from "./ai";
import { seedDemoData } from "./calendar/seed";
import {
  discoverSessions,
  dispatchPendingDeliveries,
  handleQueueBatch,
  notifyApproval,
  runScheduledSync,
  enqueueAppointment,
  type JobDeps,
} from "./jobs";
import { setWorkflowDepsFactory } from "./workflow";
import { onSessionCompleted, processFileDelivery, type DeliveryDeps } from "./services/delivery";
import { defaultAiSettings } from "./api/settings-v2";
import { createRunRecorder } from "./history";
import { clientKnownTerms } from "./clients";
import { finalizeDirect } from "./services/approval/amend";
import { createVisitStore } from "./band/store";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "./band/evidence";

export { SessionWorkflow } from "./workflow";

const clock: Clock = systemClock;

function deliveryDeps(env: Env): DeliveryDeps {
  const repo = createRepository(env.DB);
  return { repo, env, clock, recorder: createRunRecorder(repo, clock) };
}

function jobDeps(env: Env): JobDeps {
  const delivery = deliveryDeps(env);
  return {
    repo: delivery.repo,
    workflow: env.SESSION_WORKFLOW,
    queue: env.SESSION_QUEUE,
    clock,
    recorder: delivery.recorder,
    processFileDelivery: (deliveryId) => processFileDelivery(delivery, deliveryId),
    // Amended revisions finalize without a live workflow (same steps, idempotent).
    finalizeDirect: (approval) =>
      finalizeDirect(
        {
          repo: delivery.repo,
          clock,
          recorder: delivery.recorder,
          resolveClient: (appt) => delivery.repo.getClient(appt.providerId, appt.clientRef),
          onCompleted: (sessionId) => onSessionCompleted(delivery, sessionId),
        },
        approval,
      ),
  };
}

setWorkflowDepsFactory((env: Env) => {
  const repo = createRepository(env.DB);
  return {
  repo,
  // Live Vexo evidence needs an MCP client (separate MCP server, not wired here).
  // In live mode without one, retrieval fails loudly with "not_configured".
  // Band-visit appointments read their own recorded transcript; all others use EVIDENCE_MODE.
  evidence: new VisitRoutingEvidenceSource(
    new BandEvidenceSource(createVisitStore(env.DB), () => clock.now()),
    createEvidenceSource(env),
  ),
  // Each provider's own AI settings (vendor, model, privacy toggles); PII scrubbing runs before any call.
  extractor: createExtractor(env, {
    resolveSettings: async (providerId: string) => (await repo.getAiSettings(providerId)) ?? defaultAiSettings(env),
    // Client names on file are always scrubbed before inference.
    resolveKnownTerms: async (appt) => clientKnownTerms(await repo.getClient(appt.providerId, appt.clientRef)),
  }),
  // Run history ("see the agents working") + per-client hourly rate frozen into drafts.
  recorder: createRunRecorder(repo, clock),
  resolveClient: (appt) => repo.getClient(appt.providerId, appt.clientRef),
  match: matchEvidence,
  assemble: assembleBundle,
  clock,
  runtimeMode: (env.RUNTIME_MODE ?? "local") as RuntimeMode,
  onCompleted: (sessionId: string) => onSessionCompleted(deliveryDeps(env), sessionId),
  };
});

function apiDeps(env: Env): ApiDeps {
  const jobs = jobDeps(env);
  return {
    repo: jobs.repo,
    clock,
    env,
    recorder: jobs.recorder,
    assemble: assembleBundle,
    discover: (opts) => discoverSessions(jobs, opts),
    dispatch: () => dispatchPendingDeliveries(jobs),
    notifyApproval: (approval) => notifyApproval(jobs, approval),
    seed: env.AUTH_MODE === "dev" && env.RUNTIME_MODE !== "deployed" ? () => seedDemoData(jobs.repo) : undefined,
    visits: {
      store: createVisitStore(env.DB),
      enqueueAppointment: (appt) => enqueueAppointment(jobs, appt),
    },
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return createApi(apiDeps(env)).fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env): Promise<void> {
    const jobs = jobDeps(env);
    console.log(JSON.stringify({ level: "info", event: "heartbeat.start", cron: controller.cron }));
    try {
      // Heartbeat: discovery only for providers whose own schedule is due…
      const sync = await runScheduledSync(jobs);
      // …but delivery recovery always runs, independent of user settings.
      const dispatch = await dispatchPendingDeliveries(jobs);
      console.log(JSON.stringify({ level: "info", event: "heartbeat.done", providersRun: sync.providersRun, enqueued: sync.enqueued, dispatched: dispatch.succeeded }));
    } catch (err) {
      console.log(JSON.stringify({ level: "error", event: "heartbeat.failed", error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown" }));
      throw err;
    }
  },

  async queue(batch, env): Promise<void> {
    await handleQueueBatch(batch as MessageBatch<unknown>, jobDeps(env));
  },
} satisfies ExportedHandler<Env>;
