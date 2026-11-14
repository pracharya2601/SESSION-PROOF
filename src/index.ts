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
import { getScenarioLookup, loadScenarioLookup } from "./band/scenarios-registry";
import { withScenarioExtraction } from "./band/scenario-extractor";
import type { Repository } from "./db/repository";
import { createNotifier, safeNotify } from "./notify";
import { createOfflineStore } from "./offline/store";
import { runOfflineTranscription, sweepOfflineAudio, type OfflineJobDeps } from "./offline/job";

export { SessionWorkflow } from "./workflow";

const clock: Clock = systemClock;

function deliveryDeps(env: Env): DeliveryDeps {
  const repo = createRepository(env.DB);
  return { repo, env, clock, recorder: createRunRecorder(repo, clock) };
}

/** Approval hand-off (review links + inbox + optional email). Never fails the caller. */
function notifier(env: Env) {
  const repo = createRepository(env.DB);
  return createNotifier({ repo, env, clock, recorder: createRunRecorder(repo, clock) });
}
/** Completion hook: close review links + "approved" notification, then the delivery hook. */
async function onCompleted(env: Env, sessionId: string): Promise<unknown> {
  await safeNotify("completed", sessionId, () => notifier(env).sessionCompleted(sessionId));
  return onSessionCompleted(deliveryDeps(env), sessionId);
}

/** Stop-visit hand-off: enqueue the session, then the "visit sent" notification. */
async function enqueueVisit(env: Env, jobs: JobDeps, appt: Parameters<typeof enqueueAppointment>[1]) {
  const r = await enqueueAppointment(jobs, appt);
  await safeNotify("visit_sent", r.sessionId, () => notifier(env).visitSent(appt, r.sessionId));
  return r;
}

/** Offline recordings (src/offline): R2 temp audio → transcript → the same hand-off as a stopped visit. */
function offlineDeps(env: Env, jobs: JobDeps): OfflineJobDeps {
  return {
    store: createOfflineStore(env.DB),
    visits: createVisitStore(env.DB),
    repo: jobs.repo,
    bucket: env.AUDIO_TMP,
    env,
    clock,
    enqueueAppointment: (appt) => enqueueVisit(env, jobs, appt),
  };
}

function jobDeps(env: Env): JobDeps {
  const delivery = deliveryDeps(env);
  const jobs: JobDeps = {
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
          onCompleted: (sessionId) => onCompleted(env, sessionId),
        },
        approval,
      ),
    transcribeOffline: (job, attempt) => runOfflineTranscription(offlineDeps(env, jobs), job, attempt),
  };
  return jobs;
}

/**
 * DEV ONLY: synthetic band scenarios (fixtures/band) for simulated visits. Loaded lazily
 * and never registered when deployed, so production never plays a scenario.
 */
function ensureDevScenarios(env: Env): void {
  if (env.RUNTIME_MODE === "deployed") return;
  void loadScenarioLookup(async () => {
    try {
      const mod = await import("../fixtures/band/scenarios");
      return (id: string) => {
        const s = mod.getBandScenario(id);
        return s ? { script: s.script, extraction: s.extraction } : null;
      };
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", event: "dev.scenarios_unavailable", errorName: err instanceof Error ? err.name : "unknown" }));
      return null;
    }
  });
}

/** DEV ONLY: demo seed plus the synthetic band-scenario clients (fixtures/band/seed.ts). */
async function seedDev(repo: Repository): Promise<void> {
  await seedDemoData(repo);
  try {
    const mod = await import("../fixtures/band/seed");
    await mod.seedBandScenarios(repo);
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", event: "dev.scenario_seed_failed", errorName: err instanceof Error ? err.name : "unknown" }));
  }
}

setWorkflowDepsFactory((env: Env) => {
  ensureDevScenarios(env);
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
  // Fixture mode only: a band visit playing a dev scenario uses that scenario's extraction (still validated).
  extractor: withScenarioExtraction(
    createExtractor(env, {
      resolveSettings: async (providerId: string) => (await repo.getAiSettings(providerId)) ?? defaultAiSettings(env),
      // Client names on file are always scrubbed before inference.
      resolveKnownTerms: async (appt) => clientKnownTerms(await repo.getClient(appt.providerId, appt.clientRef)),
    }),
    createVisitStore(env.DB),
    getScenarioLookup,
  ),
  // Run history ("see the agents working") + per-client hourly rate frozen into drafts.
  recorder: createRunRecorder(repo, clock),
  resolveClient: (appt) => repo.getClient(appt.providerId, appt.clientRef),
  match: matchEvidence,
  assemble: assembleBundle,
  clock,
  runtimeMode: (env.RUNTIME_MODE ?? "local") as RuntimeMode,
  onCompleted: (sessionId: string) => onCompleted(env, sessionId),
  onNeedsReview: (sessionId: string) => notifier(env).sessionNeedsReview(sessionId),
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
    seed: env.AUTH_MODE === "dev" && env.RUNTIME_MODE !== "deployed" ? () => seedDev(jobs.repo) : undefined,
    visits: {
      store: createVisitStore(env.DB),
      enqueueAppointment: (appt) => enqueueVisit(env, jobs, appt),
    },
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    ensureDevScenarios(env);
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
      // Offline recordings: delete expired temp audio, fail stuck transcriptions (never throws the heartbeat).
      await sweepOfflineAudio(offlineDeps(env, jobs)).catch((err: unknown) =>
        console.log(JSON.stringify({ level: "warn", event: "offline.sweep_failed", errorName: err instanceof Error ? err.name : "unknown" })),
      );
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
