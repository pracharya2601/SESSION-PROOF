/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import type { Appointment, ApprovalRecord, SessionRecord, SessionSummary } from "../contracts";
import type { Repository } from "../db/repository";
import type { Env } from "../env";
import type { ApiDeps } from "./deps";
import { createApi } from "./index";

const ORIGIN = "http://localhost:8787";
const SECRET = "test-session-secret-that-is-long-enough-0123456789";
const NOW = new Date("2026-11-13T20:00:00.000Z");

const P1 = { id: "provider_demo_001", identity: "demo.provider@example.invalid" };
const P2 = { id: "provider_other_002", identity: "other.provider@example.invalid" };

function appt(id: string, providerId: string): Appointment {
  return {
    id,
    occurrenceId: `occ_${id}`,
    providerId,
    clientRef: "C-104",
    startAt: "2026-11-13T18:00:00.000Z",
    endAt: "2026-11-13T19:00:00.000Z",
    timezone: "America/Los_Angeles",
    serviceCode: "DEMO-ILS",
    planVersion: "plan_demo_v1",
    ruleVersion: "rules_demo_v1",
    rateVersion: "rate_demo_v1",
    canceled: false,
  };
}

function session(id: string, a: Appointment): SessionRecord {
  return {
    id,
    providerId: a.providerId,
    appointmentId: a.id,
    occurrenceId: a.occurrenceId,
    status: "NEEDS_REVIEW",
    processingRevision: 1,
    currentBundleRevision: 0,
    workflowId: null,
    statusReason: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function fakeRepo(): Repository {
  const providers = new Map<string, string>([
    [P1.identity, P1.id],
    [P2.identity, P2.id],
  ]);
  const a1 = appt("appointment_demo_001", P1.id);
  const a2 = appt("appointment_other_001", P2.id);
  const appointments = new Map([a1, a2].map((a) => [a.id, a]));
  const sessions = new Map<string, SessionRecord>([
    ["sess_demo_001", session("sess_demo_001", a1)],
    ["sess_other_001", session("sess_other_001", a2)],
  ]);
  const summary = (s: SessionRecord): SessionSummary => {
    const a = appointments.get(s.appointmentId)!;
    return {
      id: s.id,
      status: s.status,
      clientRef: a.clientRef,
      serviceCode: a.serviceCode,
      startAt: a.startAt,
      endAt: a.endAt,
      timezone: a.timezone,
      currentBundleRevision: s.currentBundleRevision,
      statusReason: s.statusReason,
      evidenceMode: null,
      extractionMode: null,
      canApprove: null,
      amountCents: null,
    };
  };
  const notImpl = () => {
    throw new Error("not implemented in fake");
  };
  const repo: Partial<Repository> = {
    findProviderByIdentity: async (identity) => providers.get(identity) ?? null,
    getSyncSettings: async () => ({ settings: { enabled: true, intervalMinutes: 15, lookbackDays: 7 }, lastRunAt: null }),
    getAppointment: async (id) => appointments.get(id) ?? null,
    getSessionForProvider: async (pid, sid) => {
      const s = sessions.get(sid);
      return s && s.providerId === pid ? s : null;
    },
    getSession: async (sid) => sessions.get(sid) ?? null,
    listSessionsForProvider: async (pid, limit) => ({
      sessions: [...sessions.values()].filter((s) => s.providerId === pid).slice(0, limit).map(summary),
      nextCursor: null,
    }),
    getCurrentBundle: async () => null,
    getApprovalForSession: async () => null as ApprovalRecord | null,
    getFinalBundle: async () => null,
  };
  return new Proxy(repo as Repository, {
    get: (t, k) => (k in t ? t[k as keyof Repository] : notImpl),
  });
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SESSION_QUEUE: {} as Queue<never>,
    SESSION_WORKFLOW: {} as Workflow<never>,
    ASSETS: {} as Fetcher,
    EVIDENCE_MODE: "fixture",
    EXTRACTION_MODE: "fixture",
    AI_MODEL: "test-model",
    AUTH_MODE: "dev",
    APP_ORIGIN: ORIGIN,
    RUNTIME_MODE: "local",
    AI_API_KEY: "sk-super-secret-ai-key",
    TOKEN_ENCRYPTION_KEY: "c3VwZXItc2VjcmV0LWVuY3J5cHRpb24ta2V5LTMyYnl0ZXM=",
    SESSION_SECRET: SECRET,
    ...overrides,
  } as Env;
}

function makeDeps(overrides: Partial<ApiDeps> = {}, env: Partial<Env> = {}): ApiDeps {
  return {
    repo: fakeRepo(),
    clock: { now: () => NOW },
    env: makeEnv(env),
    assemble: (() => {
      throw new Error("not used");
    }) as unknown as ApiDeps["assemble"],
    discover: async () => ({ examined: 2, created: 1, enqueued: 1, skipped: 1 }),
    dispatch: async () => ({ attempted: 1, succeeded: 1, failed: 0, exhausted: 0 }),
    notifyApproval: async () => {},
    seed: async () => {},
    ...overrides,
  };
}

async function login(app: ReturnType<typeof createApi>, identity: string): Promise<string> {
  const res = await app.request(`${ORIGIN}/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ identity }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}

describe("createApi", () => {
  it("serves public health with modes and binding presence, no secret values", async () => {
    const app = createApi(makeDeps());
    const res = await app.request(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.correlationId).toEqual(expect.any(String));
    expect(body.data).toMatchObject({
      ok: true,
      evidenceMode: "fixture",
      extractionMode: "fixture",
      runtimeMode: "local",
      authMode: "dev",
      bindings: { db: true, queue: true, workflow: true },
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("sk-super-secret-ai-key");
    expect(text).not.toContain("c3VwZXItc2VjcmV0");
  });

  it("rejects session list without a cookie (401)", async () => {
    const app = createApi(makeDeps());
    const res = await app.request(`${ORIGIN}/api/sessions`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("dev-login then list shows only own sessions; detail returns SessionDetail", async () => {
    const app = createApi(makeDeps());
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/sessions?limit=500`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.sessions.map((s: { id: string }) => s.id)).toEqual(["sess_demo_001"]);
    expect(body.data.nextCursor).toBeNull();

    const det = await app.request(`${ORIGIN}/api/sessions/sess_demo_001`, { headers: { Cookie: cookie } });
    expect(det.status).toBe(200);
    const d = ((await det.json()) as any).data;
    expect(d.session.id).toBe("sess_demo_001");
    expect(d.appointment.providerId).toBe(P1.id);
    expect(d.bundle).toBeNull();
    expect(d.approval).toBeNull();
    expect(d.finalized).toBe(false);
  });

  it("caps list limit at 50 and rejects invalid limit", async () => {
    const deps = makeDeps();
    const spy = vi.spyOn(deps.repo, "listSessionsForProvider");
    const app = createApi(deps);
    const cookie = await login(app, P1.identity);
    await app.request(`${ORIGIN}/api/sessions?limit=500`, { headers: { Cookie: cookie } });
    expect(spy).toHaveBeenLastCalledWith(P1.id, 50, null);
    await app.request(`${ORIGIN}/api/sessions?cursor=abc`, { headers: { Cookie: cookie } });
    expect(spy).toHaveBeenLastCalledWith(P1.id, 20, "abc");
    const bad = await app.request(`${ORIGIN}/api/sessions?limit=-1`, { headers: { Cookie: cookie } });
    expect(bad.status).toBe(400);
  });

  it("returns 404 (not 403) for another provider's session", async () => {
    const app = createApi(makeDeps());
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/sessions/sess_other_001`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(body)).not.toContain(P2.id);
  });

  it("rejects POST /api/sync with a bad Origin (403)", async () => {
    const app = createApi(makeDeps());
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/sync`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/sync returns 202 with discovery and dispatch summaries", async () => {
    const app = createApi(makeDeps());
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/sync`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.data.discovery).toEqual({ examined: 2, created: 1, enqueued: 1, skipped: 1 });
    expect(body.data.dispatch).toEqual({ attempted: 1, succeeded: 1, failed: 0, exhausted: 0 });
  });

  it("sync dependency failure maps to 503 retryable", async () => {
    const app = createApi(
      makeDeps({
        discover: async () => {
          throw new Error("D1 down: secret-detail");
        },
      }),
    );
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/sync`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error.retryable).toBe(true);
    expect(text).not.toContain("secret-detail");
  });

  it("seed works in dev mode and is 404 in access mode", async () => {
    const seed = vi.fn(async () => {});
    const devApp = createApi(makeDeps({ seed }));
    const cookie = await login(devApp, P1.identity);
    const ok = await devApp.request(`${ORIGIN}/api/dev/seed`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).data).toEqual({ seeded: true });
    expect(seed).toHaveBeenCalledOnce();

    const accessSeed = vi.fn(async () => {});
    const accessApp = createApi(makeDeps({ seed: accessSeed }, { AUTH_MODE: "access" }));
    const res = await accessApp.request(`${ORIGIN}/api/dev/seed`, {
      method: "POST",
      headers: { "Cf-Access-Authenticated-User-Email": P1.identity, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
    expect(accessSeed).not.toHaveBeenCalled();
  });

  it("unknown /api route returns 404 envelope", async () => {
    const app = createApi(makeDeps());
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/nope`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toMatchObject({ code: "NOT_FOUND", retryable: false, correlationId: expect.any(String) });
  });

  it("thrown error becomes a safe 500 envelope without stack", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    deps.repo.listSessionsForProvider = async () => {
      throw new Error("boom at secret internals");
    };
    const app = createApi(deps);
    const cookie = await login(app, P1.identity);
    const res = await app.request(`${ORIGIN}/api/sessions`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Unexpected error",
      retryable: true,
      correlationId: expect.any(String),
    });
    expect(text).not.toContain("boom");
    expect(text).not.toMatch(/at .*\.ts/);
    errSpy.mockRestore();
  });
});
