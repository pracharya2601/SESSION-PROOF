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
  type JobDeps,
} from "./jobs";
import { setWorkflowDepsFactory } from "./workflow";

export { SessionWorkflow } from "./workflow";

const clock: Clock = systemClock;

function jobDeps(env: Env): JobDeps {
  return {
    repo: createRepository(env.DB),
    workflow: env.SESSION_WORKFLOW,
    queue: env.SESSION_QUEUE,
    clock,
  };
}

setWorkflowDepsFactory((env: Env) => ({
  repo: createRepository(env.DB),
  // Live Vexo evidence needs an MCP client (separate MCP server, not wired here).
  // In live mode without one, retrieval fails loudly with "not_configured".
  evidence: createEvidenceSource(env),
  extractor: createExtractor(env),
  match: matchEvidence,
  assemble: assembleBundle,
  clock,
  runtimeMode: (env.RUNTIME_MODE ?? "local") as RuntimeMode,
}));

function apiDeps(env: Env): ApiDeps {
  const jobs = jobDeps(env);
  return {
    repo: jobs.repo,
    clock,
    env,
    assemble: assembleBundle,
    discover: () => discoverSessions(jobs),
    dispatch: () => dispatchPendingDeliveries(jobs),
    notifyApproval: (approval) => notifyApproval(jobs, approval),
    seed: env.AUTH_MODE === "dev" && env.RUNTIME_MODE !== "deployed" ? () => seedDemoData(jobs.repo) : undefined,
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

  async scheduled(_controller, env, ctx): Promise<void> {
    const jobs = jobDeps(env);
    ctx.waitUntil(
      (async () => {
        await discoverSessions(jobs);
        await dispatchPendingDeliveries(jobs);
      })(),
    );
  },

  async queue(batch, env): Promise<void> {
    await handleQueueBatch(batch as MessageBatch<unknown>, jobDeps(env));
  },
} satisfies ExportedHandler<Env>;
