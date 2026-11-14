/**
 * Agent 20 — in-process integration harness.
 *
 * Wires the REAL modules (repository over Miniflare D1, seed, jobs, workflow
 * body, fixture evidence/extraction, domain, API) with three fakes that stand
 * in for Cloudflare platform bindings only:
 *   - FakeQueue      captures sent messages (consumed via handleQueueBatch)
 *   - FakeWorkflow   create() runs runSessionWorkflow with a memoizing StepLike
 *   - mutable clock  starts at FIXTURE_CLOCK_NOW, can be advanced
 *
 * Modules are imported dynamically so a missing module is reported with its
 * owner instead of crashing the whole suite.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import type { Clock, QueuePayload, WorkflowParams } from "../../src/contracts";
import type { Repository } from "../../src/db/repository";
import { FIXTURE_CLOCK_NOW, DEMO_PROVIDER_IDENTITY } from "../../fixtures/scenario";

const ROOT = resolve(__dirname, "../..");

export const MODULES = {
  d1: { path: "src/db/d1.ts", owner: "04" },
  migration: { path: "migrations/0001_init.sql", owner: "04" },
  seed: { path: "src/calendar/seed.ts", owner: "05" },
  variants: { path: "fixtures/variants.ts", owner: "05" },
  vexo: { path: "src/integrations/vexo/index.ts", owner: "07" },
  domain: { path: "src/domain/index.ts", owner: "11" },
  matching: { path: "src/domain/matching/index.ts", owner: "08" },
  jobs: { path: "src/jobs/index.ts", owner: "09" },
  ai: { path: "src/ai/index.ts", owner: "10" },
  workflow: { path: "src/workflow/run.ts", owner: "14" },
  api: { path: "src/api/index.ts", owner: "15" },
  review: { path: "src/api/review.ts", owner: "16" },
  approval: { path: "src/services/approval/index.ts", owner: "16" },
  exporter: { path: "src/export/index.ts", owner: "16" },
  security: { path: "src/security/index.ts", owner: "19" },
} as const;

export function missingModules(): string[] {
  return Object.values(MODULES)
    .filter((m) => !existsSync(resolve(ROOT, m.path)))
    .map((m) => `${m.path} (Agent ${m.owner})`);
}

// ------------------------------------------------------------------ clock
export class MutableClock implements Clock {
  private t = new Date(FIXTURE_CLOCK_NOW).getTime();
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ------------------------------------------------------------------ queue
export class FakeQueue {
  sent: QueuePayload[] = [];
  pending: QueuePayload[] = [];
  failNextSend = 0;
  async send(body: QueuePayload): Promise<void> {
    if (this.failNextSend > 0) {
      this.failNextSend--;
      throw new Error("FakeQueue: injected send failure");
    }
    this.sent.push(structuredClone(body));
    this.pending.push(structuredClone(body));
  }
  async sendBatch(msgs: Iterable<{ body: QueuePayload }>): Promise<void> {
    for (const m of msgs) await this.send(m.body);
  }
}

let msgSeq = 0;
export function fakeBatch(bodies: unknown[]) {
  const acks: string[] = [];
  const retries: string[] = [];
  const messages = bodies.map((body) => {
    const id = `msg-${++msgSeq}`;
    return {
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => acks.push(id),
      retry: () => retries.push(id),
    };
  });
  return {
    batch: {
      queue: "vexo-session-processing",
      messages,
      ackAll: () => messages.forEach((m) => acks.push(m.id)),
      retryAll: () => messages.forEach((m) => retries.push(m.id)),
    } as unknown as MessageBatch<unknown>,
    acks,
    retries,
  };
}

// ------------------------------------------------------------------ workflow
type InstStatus = "queued" | "running" | "waiting" | "complete" | "errored" | "terminated";

class TimeoutError extends Error {
  constructor(name: string) {
    super(`waitForEvent '${name}' timed out`);
    this.name = "WorkflowTimeoutError";
  }
}

export class FakeInstance {
  status: InstStatus = "queued";
  error: unknown = null;
  output: unknown = null;
  cache = new Map<string, unknown>();
  stepLog: string[] = [];
  bufferedEvents: { type: string; payload: unknown }[] = [];
  waiters: { name: string; type: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  eventsSent: { type: string; payload: unknown }[] = [];
  done: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly params: WorkflowParams,
    private readonly owner: FakeWorkflow,
  ) {}

  step() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const inst = this;
    return {
      async do<T>(name: string, a: unknown, b?: unknown): Promise<T> {
        const fn = (typeof a === "function" ? a : b) as () => Promise<T>;
        if (inst.cache.has(name)) return structuredClone(inst.cache.get(name)) as T;
        inst.stepLog.push(name);
        const v = await fn();
        inst.cache.set(name, v === undefined ? undefined : structuredClone(v));
        return v;
      },
      async waitForEvent<T>(name: string, opts: { type: string; timeout: string | number }): Promise<{ payload: T }> {
        if (inst.cache.has(name)) return structuredClone(inst.cache.get(name)) as { payload: T };
        inst.stepLog.push(`wait:${name}`);
        const idx = inst.bufferedEvents.findIndex((e) => e.type === opts.type);
        let ev: { payload: T; type: string; timestamp: Date };
        if (idx >= 0) {
          const [e] = inst.bufferedEvents.splice(idx, 1);
          ev = { payload: e!.payload as T, type: e!.type, timestamp: new Date() };
        } else {
          inst.status = "waiting";
          try {
            ev = (await new Promise<unknown>((res, rej) => {
              inst.waiters.push({ name, type: opts.type, resolve: res, reject: rej });
            })) as typeof ev;
          } finally {
            // A timeout rejection resumes the workflow too (it re-checks durable approval).
            inst.status = "running";
          }
        }
        inst.cache.set(name, structuredClone(ev));
        return ev;
      },
      async sleep(): Promise<void> {},
      async sleepUntil(): Promise<void> {},
    };
  }

  start(): void {
    this.status = "running";
    this.done = (async () => {
      try {
        this.output = await this.owner.run(this.params, this.step());
        this.status = "complete";
      } catch (e) {
        this.error = e;
        this.status = "errored";
      }
    })();
  }

  /** Re-run the body with the memoized step cache (models a Workflow retry/resume). */
  restart(): Promise<void> {
    this.start();
    return this.done;
  }

  deliver(type: string, payload: unknown): void {
    this.eventsSent.push({ type, payload });
    const w = this.waiters.findIndex((x) => x.type === type);
    if (w >= 0) {
      const [waiter] = this.waiters.splice(w, 1);
      waiter!.resolve({ payload, type, timestamp: new Date() });
    } else {
      this.bufferedEvents.push({ type, payload });
    }
  }

  timeoutWaits(): void {
    const ws = this.waiters.splice(0);
    ws.forEach((w) => w.reject(new TimeoutError(w.name)));
  }

  handle() {
    return {
      id: this.id,
      status: async () => ({ status: this.status, error: this.error ? String(this.error) : undefined, output: this.output }),
      sendEvent: async (ev: { type: string; payload: unknown }) => {
        if (this.owner.failSendEvent > 0) {
          this.owner.failSendEvent--;
          throw new Error("FakeWorkflow: injected sendEvent failure");
        }
        this.deliver(ev.type, ev.payload);
      },
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {
        this.status = "terminated";
      },
      restart: async () => {
        void this.restart();
      },
    };
  }
}

export class FakeWorkflow {
  instances = new Map<string, FakeInstance>();
  createCalls = 0;
  duplicateCreates = 0;
  failSendEvent = 0;
  run: (params: WorkflowParams, step: ReturnType<FakeInstance["step"]>) => Promise<unknown> = async () => {
    throw new Error("FakeWorkflow.run not wired");
  };

  async create(opts?: { id?: string; params?: WorkflowParams }) {
    this.createCalls++;
    const id = opts?.id ?? `auto-${this.createCalls}`;
    if (this.instances.has(id)) {
      this.duplicateCreates++;
      throw new Error(`instance.already_exists: Workflow instance '${id}' already exists`);
    }
    const inst = new FakeInstance(id, opts!.params as WorkflowParams, this);
    this.instances.set(id, inst);
    inst.start();
    return inst.handle();
  }
  async createBatch(list: { id?: string; params?: WorkflowParams }[]) {
    return Promise.all(list.map((o) => this.create(o)));
  }
  async get(id: string) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`instance.not_found: ${id}`);
    return inst.handle();
  }
}

// ------------------------------------------------------------------ migrations
function splitSql(sql: string): string[] {
  const noComments = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const part of noComments.split(/(;)/)) {
    if (part === ";") {
      buf += ";";
      if (depth === 0) {
        if (buf.trim() !== ";") out.push(buf.trim());
        buf = "";
      }
      continue;
    }
    depth += (part.match(/\bBEGIN\b/gi) ?? []).length;
    depth -= (part.match(/\bEND\b/gi) ?? []).length;
    if (depth < 0) depth = 0;
    buf += part;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ------------------------------------------------------------------ harness
export interface Harness {
  mf: Miniflare;
  db: D1Database;
  repo: Repository;
  clock: MutableClock;
  queue: FakeQueue;
  workflow: FakeWorkflow;
  env: Record<string, unknown>;
  mods: Record<string, any>;
  app: { request: (path: string, init?: RequestInit, env?: unknown) => Promise<Response> | Response };
  jobs: any;
  /** Process queue + let workflows run until every instance is idle. */
  settle(): Promise<void>;
  login(identity?: string): Promise<string>;
  req(path: string, init?: { method?: string; body?: unknown; cookie?: string | null; origin?: string | null }): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  dispose(): Promise<void>;
}

export const ORIGIN = "http://localhost:8787";

export async function createHarness(opts: { variant?: string } = {}): Promise<Harness> {
  const variant = opts.variant ?? "normal";
  const mods = {
    d1: await import("../../src/db/d1"),
    seed: await import("../../src/calendar/seed"),
    jobs: await import("../../src/jobs"),
    workflow: await import("../../src/workflow/run"),
    vexo: await import("../../src/integrations/vexo"),
    ai: await import("../../src/ai"),
    domain: await import("../../src/domain"),
    api: await import("../../src/api"),
  } as Record<string, any>;

  const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  // Apply every migration in order, exactly as `wrangler d1 migrations apply` would.
  const migDir = resolve(ROOT, "migrations");
  for (const f of readdirSync(migDir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(migDir, f), "utf8");
    for (const stmt of splitSql(sql)) await db.prepare(stmt).run();
  }

  const repo: Repository = mods.d1.createRepository(db);
  const clock = new MutableClock();
  const queue = new FakeQueue();
  const workflow = new FakeWorkflow();

  const env: Record<string, unknown> = {
    DB: db,
    SESSION_QUEUE: queue,
    SESSION_WORKFLOW: workflow,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    EVIDENCE_MODE: "fixture",
    EXTRACTION_MODE: "fixture",
    AI_MODEL: "fixture-model",
    AUTH_MODE: "dev",
    APP_ORIGIN: ORIGIN,
    RUNTIME_MODE: "local",
    FIXTURE_VARIANT: variant,
    SESSION_SECRET: "integration-test-session-secret-0123456789abcdef",
    TOKEN_ENCRYPTION_KEY: "aW50ZWdyYXRpb24tdGVzdC1rZXktMDEyMzQ1Njc4OWFi",
  };

  const workflowDeps = {
    repo,
    evidence: mods.vexo.createEvidenceSource(env),
    extractor: mods.ai.createExtractor(env),
    match: mods.domain.matchEvidence,
    assemble: mods.domain.assembleBundle,
    clock,
    runtimeMode: "local",
  };
  workflow.run = (params, step) => mods.workflow.runSessionWorkflow(workflowDeps, params, step);

  const jobs = { repo, workflow, queue, clock };
  const apiDeps = {
    repo,
    clock,
    env,
    assemble: mods.domain.assembleBundle,
    discover: () => mods.jobs.discoverSessions(jobs),
    dispatch: () => mods.jobs.dispatchPendingDeliveries(jobs),
    notifyApproval: (approval: unknown) => mods.jobs.notifyApproval(jobs, approval),
    seed: () => mods.seed.seedDemoData(repo, { variant }),
  };
  const app = mods.api.createApi(apiDeps);

  const tick = () => new Promise((r) => setTimeout(r, 5));
  async function settle(): Promise<void> {
    let idle = 0;
    for (let i = 0; i < 400; i++) {
      if (queue.pending.length) {
        const bodies = queue.pending.splice(0);
        await mods.jobs.handleQueueBatch(fakeBatch(bodies).batch, jobs);
        idle = 0;
        continue;
      }
      await tick();
      const busy = [...workflow.instances.values()].some((x) => x.status === "running" || x.status === "queued");
      idle = busy ? 0 : idle + 1;
      if (idle >= 3) return;
    }
    throw new Error("settle(): workflows did not become idle");
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
      env,
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  async function login(identity = DEMO_PROVIDER_IDENTITY): Promise<string> {
    const r = await app.request(
      `${ORIGIN}/auth/dev-login`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ identity }),
      },
      env,
    );
    if (r.status >= 300) throw new Error(`dev-login failed ${r.status}: ${await r.text()}`);
    const cookies: string[] =
      typeof (r.headers as any).getSetCookie === "function"
        ? (r.headers as any).getSetCookie()
        : [r.headers.get("set-cookie") ?? ""];
    const cookie = cookies
      .filter(Boolean)
      .map((c) => c.split(";")[0])
      .join("; ");
    if (!cookie) throw new Error("dev-login returned no cookie");
    return cookie;
  }

  return {
    mf,
    db,
    repo,
    clock,
    queue,
    workflow,
    env,
    mods,
    app,
    jobs,
    settle,
    login,
    req,
    dispose: () => mf.dispose(),
  };
}
