/**
 * Q2 — v2 in-process harness. Wraps the v1 harness (tests/e2e/harness.ts:
 * real repo over Miniflare D1 with ALL migrations, fake Queue/Workflow, clock)
 * and adds:
 *   - a recording fake `fetch` (Google / Microsoft / AI vendors) injected as ApiDeps.fetch
 *   - a Hono app = createApi(deps) + the v2 routers (unless createApi already mounts them)
 *   - OAuth client + AI key secrets in env
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, ORIGIN, type Harness } from "./harness";
import { DEMO_PROVIDER_IDENTITY } from "../../fixtures/scenario";
import { FakeCloud } from "./v2-fake-fetch";

const ROOT = resolve(__dirname, "../..");

export const V2_MODULES = {
  migration: { path: "migrations/0003_v2.sql", owner: "V1" },
  providers: { path: "src/ai/providers/index.ts", owner: "V2" },
  privacy: { path: "src/privacy/index.ts", owner: "V3" },
  artifacts: { path: "src/artifacts/index.ts", owner: "V4" },
  connections: { path: "src/connections/index.ts", owner: "V5" },
  cloud: { path: "src/integrations/cloud/index.ts", owner: "V6" },
  delivery: { path: "src/services/delivery/index.ts", owner: "V7" },
  files: { path: "src/api/files.ts", owner: "V7" },
  deliveries: { path: "src/api/deliveries.ts", owner: "V7" },
  settings: { path: "src/api/settings-v2.ts", owner: "V8" },
} as const;

export function missingV2Modules(): string[] {
  return Object.values(V2_MODULES)
    .filter((m) => !existsSync(resolve(ROOT, m.path)))
    .map((m) => `${m.path} (${m.owner})`);
}

export const SECRETS = {
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret-QQ",
  MS_CLIENT_ID: "test-ms-client-id-0000",
  MS_CLIENT_SECRET: "test-ms-client-secret-QQ",
  MS_TENANT: "common",
  TOKEN_ENCRYPTION_KEY: "cTItdjItaW50ZWdyYXRpb24tdGVzdC1rZXktMzJieXQ=",
  ANTHROPIC_API_KEY: "sk-ant-test-key-ANTHROPIC-0001",
  OPENAI_API_KEY: "sk-test-key-OPENAI-0001",
  GEMINI_API_KEY: "test-key-GEMINI-0001",
  MISTRAL_API_KEY: "test-key-MISTRAL-0001",
} as const;

export interface V2Harness extends Harness {
  cloud: FakeCloud;
  apiDeps: Record<string, any>;
  v2: Record<string, any>;
  /** true when the v2 routers were mounted by createApi (Agent 01) rather than by this harness. */
  mountedByCreateApi: boolean;
}

export async function createV2Harness(opts: { variant?: string } = {}): Promise<V2Harness> {
  const base = await createHarness(opts);
  const cloud = new FakeCloud();
  Object.assign(base.env, SECRETS);

  const v2 = {
    delivery: await import("../../src/services/delivery"),
    files: await import("../../src/api/files"),
    deliveries: await import("../../src/api/deliveries"),
    connections: await import("../../src/connections"),
    settings: await import("../../src/api/settings-v2"),
    artifacts: await import("../../src/artifacts"),
    security: await import("../../src/security"),
  } as Record<string, any>;

  const mods = base.mods;
  const jobs = base.jobs;
  const apiDeps: Record<string, any> = {
    repo: base.repo,
    clock: base.clock,
    env: base.env,
    assemble: mods.domain.assembleBundle,
    discover: () => mods.jobs.discoverSessions(jobs),
    dispatch: () => mods.jobs.dispatchPendingDeliveries(jobs),
    notifyApproval: (approval: unknown) => mods.jobs.notifyApproval(jobs, approval),
    seed: () => mods.seed.seedDemoData(base.repo, { variant: opts.variant ?? "normal" }),
    fetch: cloud.fetch,
  };

  // Mirror the v2 composition root (src/index.ts): file_delivery in jobs, the
  // completion hook + per-provider AI settings in the workflow deps.
  const deliveryDeps = { repo: base.repo, env: base.env, clock: base.clock, fetch: cloud.fetch };
  jobs.processFileDelivery = (deliveryId: string) => v2.delivery.processFileDelivery(deliveryDeps, deliveryId);
  const makeExtractor = () =>
    mods.ai.createExtractor(base.env, {
      fetch: cloud.fetch,
      retryDelayMs: 0,
      resolveSettings: async (pid: string) => (await base.repo.getAiSettings(pid)) ?? v2.settings.defaultAiSettings(base.env),
    });
  const workflowDeps = {
    repo: base.repo,
    evidence: mods.vexo.createEvidenceSource(base.env),
    // Built per call so a test can flip env.EXTRACTION_MODE after harness creation.
    extractor: {
      get mode() {
        return makeExtractor().mode;
      },
      extractFacts: (ctx: unknown) => makeExtractor().extractFacts(ctx),
    },
    match: mods.domain.matchEvidence,
    assemble: mods.domain.assembleBundle,
    clock: base.clock,
    runtimeMode: "local",
    onCompleted: (sessionId: string) => v2.delivery.onSessionCompleted(deliveryDeps, sessionId),
  };
  base.workflow.run = (params, step) => mods.workflow.runSessionWorkflow(workflowDeps, params, step);

  const apiSrc = readFileSync(resolve(ROOT, "src/api/index.ts"), "utf8");
  const mountedByCreateApi = /filesRoutes\s*\(/.test(apiSrc) && /deliveryRoutes\s*\(/.test(apiSrc);
  const app = mods.api.createApi(apiDeps);
  if (!mountedByCreateApi) {
    // Must be registered before the first request (Hono builds its matcher lazily).
    app.route("/", v2.files.filesRoutes(apiDeps));
    app.route("/", v2.deliveries.deliveryRoutes(apiDeps));
    app.route("/", v2.connections.connectionsRoutes(apiDeps));
    if (!/settingsV2Routes\s*\(/.test(apiSrc)) app.route("/", v2.settings.settingsV2Routes(apiDeps));
  }

  async function req(
    path: string,
    o: { method?: string; body?: unknown; cookie?: string | null; origin?: string | null } = {},
  ) {
    const headers: Record<string, string> = {};
    if (o.cookie) headers["cookie"] = o.cookie;
    if (o.origin !== null) headers["origin"] = o.origin ?? ORIGIN;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(
      `${ORIGIN}${path}`,
      { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) },
      base.env,
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("latin1").decode(buf);
    let json: any = null;
    try {
      json = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      /* non-json */
    }
    responses.push(text);
    return { status: res.status, json, text, headers: res.headers, bytes: buf };
  }
  const responses: string[] = [];

  async function login(identity = DEMO_PROVIDER_IDENTITY): Promise<string> {
    const r = await app.request(
      `${ORIGIN}/auth/dev-login`,
      { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ identity }) },
      base.env,
    );
    if (r.status >= 300) throw new Error(`dev-login failed ${r.status}: ${await r.text()}`);
    const cookies: string[] =
      typeof (r.headers as any).getSetCookie === "function" ? (r.headers as any).getSetCookie() : [r.headers.get("set-cookie") ?? ""];
    const cookie = cookies.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("dev-login returned no cookie");
    return cookie;
  }

  return Object.assign(base, { cloud, apiDeps, v2, mountedByCreateApi, app, req, login, responses }) as V2Harness & {
    responses: string[];
  };
}
