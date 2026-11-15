/**
 * Band visits API. A provider starts a visit for a client, streams the Vexo
 * band's audio (browser or GlassCam bridge), stops it, and the visit's
 * transcript becomes the evidence for a normal session.
 *
 *   GET  /api/visits/capture-status   → CaptureStatus
 *   GET  /api/visits                  → Visit[] (the actor's, newest first)
 *   POST /api/visits                  StartVisitRequest → 201 StartVisitResponse
 *                                     (transcriber "device" → visit.transcriber "device"; else the server's choice)
 *   GET  /api/visits/:id              → VisitDetail
 *   GET  /api/visits/:id/status       → { visit } (cookie, or `Authorization: Bearer <streamToken>`)
 *   POST /api/visits/:id/stop         → StopVisitResponse (hands the visit to processing; cookie, or Bearer stream token)
 *   GET  /api/visits/:id/stream       WebSocket; stream auth below
 *
 * Stream auth (docs/band-bridge.md §1). The stream URL carries NO token, because Cloudflare logs
 * full request URLs (docs/deploy.md §13). In order of preference:
 *   1. `Sec-WebSocket-Protocol: vfa-stream, vfa-token.<streamToken>`; the 101 echoes `vfa-stream`.
 *   2. The first text message `{"type":"auth","token":"…"}` within 5 s (STREAM_AUTH_TIMEOUT_MS);
 *      anything else first, or nothing in time → close 1008.
 *   3. Browser cookie + same Origin (visits only).
 *   Deprecated for one release: `?token=` on stream/stop/status still works, and each use logs
 *   `stream.legacy_query_token` with a counter (never the token).
 *
 * The token routes are mounted before requireActor (a bridge has no cookie) and authenticate
 * themselves. POST still passes the global originGuard, so a bridge sends
 * `Origin: <scheme://host:port>` of the URL it calls. Audio is never stored. A paired device uses
 * the same start/stop/detail logic through src/api/device.ts (startVisitAs, stopVisitAs, visitDetailAs).
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  Appointment,
  StartVisitRequest,
  VISIT_APPOINTMENT_PREFIX,
  type CaptureStatus,
  type StartVisitResponse,
  type StopVisitResponse,
  type Transcriber,
  type Visit,
  type VisitDetail,
} from "../contracts";
import { apiError, log, requireActor } from "../security";
import { CaptureSession } from "../band/capture";
import type { VisitStore } from "../band/store";
import { signStreamToken, verifyStreamToken } from "../band/token";
import { openDeepgram, openSimulated, type TranscriberEvents, type TranscriberSession } from "../band/transcriber";
import { getScenarioLookup, scenarioLookupReady } from "../band/scenarios-registry";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

/** Band appointments stay open (not discoverable) until stopped; this is the safety cap. */
const OPEN_VISIT_HOURS = 12;

export interface VisitDeps {
  store: VisitStore;
  /** Ensure + enqueue the session for an appointment (jobs.enqueueAppointment). */
  enqueueAppointment: (appt: Appointment) => Promise<{ sessionId: string }>;
  /** Override for tests. */
  openTranscriber?: (kind: Transcriber, events: TranscriberEvents, visit: Visit) => Promise<TranscriberSession>;
  /** Override for tests: first-message auth deadline (default STREAM_AUTH_TIMEOUT_MS). */
  streamAuthTimeoutMs?: number;
}

export function captureStatus(env: ApiDeps["env"]): CaptureStatus {
  if (env.DEEPGRAM_API_KEY) return { transcriber: "deepgram", reason: null };
  if (env.RUNTIME_MODE !== "deployed") {
    return { transcriber: "simulated", reason: "No DEEPGRAM_API_KEY: local dev uses a simulated, synthetic transcript." };
  }
  return { transcriber: null, reason: "Transcription is not configured (DEEPGRAM_API_KEY)." };
}

function defaultOpen(deps: ApiDeps) {
  return (kind: Transcriber, events: TranscriberEvents, visit: Visit): Promise<TranscriberSession> => {
    if (kind === "simulated") {
      if (deps.env.RUNTIME_MODE === "deployed") return Promise.reject(new Error("simulated transcriber is dev only"));
      if (visit.scenario) {
        // Dev scenario: play its synthetic script. Unknown id (or no lookup registered) fails loudly.
        const id = visit.scenario;
        return scenarioLookupReady().then(() => {
          const scenario = getScenarioLookup()?.(id);
          if (!scenario) throw new Error(`Unknown scenario "${id}"`);
          return openSimulated(events, scenario.script);
        });
      }
      return Promise.resolve(openSimulated(events));
    }
    const key = deps.env.DEEPGRAM_API_KEY;
    if (!key) return Promise.reject(new Error("DEEPGRAM_API_KEY missing"));
    return openDeepgram(key, events, deps.fetch ?? fetch);
  };
}

/**
 * The configured PUBLIC_STREAM_ORIGIN as `ws(s)://host[:port]`, or null when unset or invalid
 * (invalid is logged, then the request host is used).
 */
export function publicStreamOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    if ((u.protocol === "ws:" || u.protocol === "wss:") && u.host) return `${u.protocol}//${u.host}`;
  } catch {
    /* fall through */
  }
  log("warn", "visit.public_stream_origin_invalid", { reason: "expected ws:// or wss:// origin" });
  return null;
}

export function wsOrigin(deps: ApiDeps, c: Context<AppBindings>): string {
  const configured = publicStreamOrigin(deps.env.PUBLIC_STREAM_ORIGIN);
  if (configured) return configured;
  const u = new URL(c.req.url);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
}

/**
 * Start a visit for one provider. Shared by the cookie route (POST /api/visits) and the
 * device-key route (POST /api/device/visits), so both behave identically.
 * `req.transcriber === "device"`: the phone transcribes; no server transcriber is needed.
 */
export async function startVisitAs(deps: ApiDeps, c: Context<AppBindings>, providerId: string, req: StartVisitRequest) {
  const v = deps.visits;
  if (!v) return unavailable(c);
  let transcriber: Transcriber;
  if (req.transcriber === "device") {
    if (req.scenario) {
      return apiError(c, 400, "SCENARIO_DEV_ONLY", "Synthetic scenarios only run with the simulated transcriber in local dev.", false);
    }
    transcriber = "device";
  } else {
    const status = captureStatus(deps.env);
    if (!status.transcriber) return apiError(c, 503, "TRANSCRIPTION_NOT_CONFIGURED", status.reason ?? "Unavailable", false);
    transcriber = status.transcriber;
    if (req.scenario && (transcriber !== "simulated" || deps.env.RUNTIME_MODE === "deployed")) {
      return apiError(c, 400, "SCENARIO_DEV_ONLY", "Synthetic scenarios only run with the simulated transcriber in local dev.", false);
    }
    if (req.scenario) {
      await scenarioLookupReady();
      const lookup = getScenarioLookup();
      // No lookup registered (e.g. tests without fixtures) → let the stream open decide.
      if (lookup && !lookup(req.scenario)) {
        return apiError(c, 400, "UNKNOWN_SCENARIO", `Unknown scenario "${req.scenario}".`, false);
      }
    }
  }
  const template = await v.store.latestAppointmentForClient(providerId, req.clientRef);
  if (!template) {
    return apiError(c, 422, "NO_SERVICE_PLAN", "This client has no service plan on file yet (no earlier appointment to copy it from).", false);
  }
  const secret = deps.env.SESSION_SECRET;
  if (!secret) return apiError(c, 503, "AUTH_NOT_CONFIGURED", "SESSION_SECRET is not configured.", false);
  const now = deps.clock.now();
  const id = crypto.randomUUID().replace(/-/g, "");
  const appointmentId = `${VISIT_APPOINTMENT_PREFIX}${id}`;
  const appointment = Appointment.parse({
    ...template,
    id: appointmentId,
    occurrenceId: appointmentId,
    startAt: now.toISOString(),
    endAt: new Date(now.getTime() + OPEN_VISIT_HOURS * 3600_000).toISOString(),
    timezone: req.timezone ?? template.timezone,
    canceled: false,
  });
  const visit = await v.store.createVisit({
    id: `visit_${id}`,
    providerId,
    appointment,
    bandNumber: req.bandNumber,
    transport: req.transport,
    transcriber,
    startedAt: now.toISOString(),
    scenario: req.scenario ?? null,
  });
  const t = await signStreamToken({ providerId, visitId: visit.id, nowMs: now.getTime() }, secret);
  const res: StartVisitResponse = {
    visit,
    streamUrl: `${wsOrigin(deps, c)}/api/visits/${encodeURIComponent(visit.id)}/stream`,
    streamToken: t.token,
    streamTokenExpiresAt: t.expiresAt,
  };
  return ok(c, res, 201);
}

/** Visit + its segments, only when it is the provider's (404 otherwise). */
export async function visitDetailAs(deps: ApiDeps, c: Context<AppBindings>, providerId: string, visitId: string) {
  const v = deps.visits;
  if (!v) return unavailable(c);
  const visit = await v.store.getVisit(providerId, visitId);
  if (!visit) return apiError(c, 404, "NOT_FOUND", "Visit not found", false);
  const res: VisitDetail = { visit, segments: await v.store.listSegments(visit.id) };
  return ok(c, res);
}

/**
 * Stop a visit (idempotent) and hand it to processing. Shared by the cookie route and the
 * token route (phone bridge), so both behave identically.
 */
export async function stopVisitAs(deps: ApiDeps, c: Context<AppBindings>, providerId: string, visitId: string) {
  const v = deps.visits;
  if (!v) return unavailable(c);
  const stopped = await v.store.stopVisit(providerId, visitId, deps.clock.now().toISOString());
  if (!stopped) return apiError(c, 404, "NOT_FOUND", "Visit not found", false);
  let sessionId = stopped.sessionId;
  if (!sessionId) {
    const appt = await deps.repo.getAppointment(stopped.appointmentId);
    if (!appt) return apiError(c, 500, "INTERNAL", "Visit appointment missing", true);
    // An offline recording (src/offline) keeps its appointment canceled until its transcript is stored.
    if (appt.canceled) {
      return apiError(c, 409, "VISIT_PENDING_UPLOAD", "This offline recording is still being uploaded or transcribed.", true);
    }
    sessionId = (await v.enqueueAppointment(appt)).sessionId;
    await v.store.setSession(stopped.id, sessionId);
  }
  const visit = (await v.store.getVisit(providerId, stopped.id)) ?? stopped;
  const res: StopVisitResponse = { visit, sessionId };
  return ok(c, res);
}

async function visitStatusAs(deps: ApiDeps, c: Context<AppBindings>, providerId: string, visitId: string) {
  const v = deps.visits;
  if (!v) return unavailable(c);
  const visit = await v.store.getVisit(providerId, visitId);
  if (!visit) return apiError(c, 404, "NOT_FOUND", "Visit not found", false);
  return ok(c, { visit });
}

/** Provider id for a valid stream token for this visit, or null. */
async function tokenProvider(deps: ApiDeps, token: string, visitId: string): Promise<string | null> {
  const secret = deps.env.SESSION_SECRET;
  return secret ? await verifyStreamToken(token, visitId, secret, deps.clock.now().getTime()) : null;
}

// ------------------------------------------------------------------ stream auth

/** The subprotocol a stream client offers, and the server echoes in the 101. */
export const STREAM_SUBPROTOCOL = "vfa-stream";
/** `vfa-token.<streamToken>`: the token as a second offered subprotocol (never echoed). */
export const STREAM_TOKEN_PROTOCOL_PREFIX = "vfa-token.";
/** A socket without header auth must send `{"type":"auth","token":"…"}` first, within this. */
export const STREAM_AUTH_TIMEOUT_MS = 5_000;
/** WebSocket close code for missing, late or invalid auth (policy violation). */
export const CLOSE_POLICY = 1008;

/** Per-isolate count of deprecated `?token=` uses, by route (logged; never the token). */
const legacyQueryTokenUses: Record<string, number> = {};
export function legacyQueryTokenCount(route: string): number {
  return legacyQueryTokenUses[route] ?? 0;
}
function noteLegacyQueryToken(route: string): void {
  const uses = (legacyQueryTokenUses[route] ?? 0) + 1;
  legacyQueryTokenUses[route] = uses;
  log("warn", "stream.legacy_query_token", { route, uses });
}

export interface StreamCredential {
  /** The stream token from the subprotocol header or (deprecated) the query, else null. */
  token: string | null;
  /** `vfa-stream` when the client offered it: echo it in the 101, or the client fails the upgrade. */
  protocol: string | null;
}

/** Reads the stream token from `Sec-WebSocket-Protocol`, else from the deprecated `?token=`. */
export function streamCredential(c: Context<AppBindings>, route: string): StreamCredential {
  const offered = (c.req.header("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const protocol = offered.includes(STREAM_SUBPROTOCOL) ? STREAM_SUBPROTOCOL : null;
  const fromHeader = offered.find((p) => p.startsWith(STREAM_TOKEN_PROTOCOL_PREFIX))?.slice(STREAM_TOKEN_PROTOCOL_PREFIX.length);
  if (fromHeader) return { token: fromHeader, protocol };
  const fromQuery = c.req.query("token");
  if (fromQuery) {
    noteLegacyQueryToken(route);
    return { token: fromQuery, protocol };
  }
  return { token: null, protocol };
}

/**
 * Stream token for stop/status: `Authorization: Bearer <streamToken>`, else the deprecated
 * `?token=`. A device key (`vfad_…`) is not a stream token.
 */
function httpStreamToken(c: Context<AppBindings>, route: string): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
  if (m && !m[1]!.startsWith("vfad_")) return m[1]!;
  const q = c.req.query("token");
  if (q) {
    noteLegacyQueryToken(route);
    return q;
  }
  return null;
}

/** `{"type":"auth","token":"…"}` → the token, else null. */
function authMessageToken(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const m = JSON.parse(raw) as { type?: unknown; token?: unknown };
    return m && m.type === "auth" && typeof m.token === "string" && m.token ? m.token : null;
  } catch {
    return null;
  }
}

function isAuthMessage(raw: string): boolean {
  if (raw.length > 4096 || !raw.includes('"auth"')) return false;
  try {
    return (JSON.parse(raw) as { type?: unknown })?.type === "auth";
  } catch {
    return false;
  }
}

function unavailable(c: Context<AppBindings>) {
  return apiError(c, 503, "VISITS_NOT_CONFIGURED", "Band visits are not configured on this server.", false);
}

/** Routes needing the cookie actor (mounted after requireActor). */
export function visitsRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/visits/capture-status", (c) => ok(c, captureStatus(deps.env)));

  app.get("/api/visits", async (c) => {
    const v = deps.visits;
    if (!v) return unavailable(c);
    return ok(c, await v.store.listVisits(c.get("actor").providerId, 50));
  });

  app.post("/api/visits", async (c) => {
    const body = StartVisitRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", body.error.issues.map((i) => i.message).join("; "), false);
    return startVisitAs(deps, c, c.get("actor").providerId, body.data);
  });

  app.get("/api/visits/:id", (c) => visitDetailAs(deps, c, c.get("actor").providerId, c.req.param("id")));

  app.get("/api/visits/:id/status", (c) => visitStatusAs(deps, c, c.get("actor").providerId, c.req.param("id")));

  app.post("/api/visits/:id/stop", (c) => stopVisitAs(deps, c, c.get("actor").providerId, c.req.param("id")));

  return app;
}

/** The WebSocket route; mounted BEFORE requireActor. */
export function visitStreamRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const cookieAuth = requireActor(deps);

  /** The cookie actor's provider id, or null (no response is sent on failure). */
  const cookieProvider = async (c: Context<AppBindings>): Promise<string | null> => {
    let passed = false;
    await cookieAuth(c, async () => {
      passed = true;
    });
    return passed ? c.get("actor").providerId : null;
  };

  // Phone bridge (no cookie): stop / status with a Bearer stream token (or the deprecated ?token=).
  // Without one, fall through to the cookie routes in visitsRoutes (behind requireActor).
  const withToken =
    (run: typeof stopVisitAs, route: string): MiddlewareHandler<AppBindings> =>
    async (c, next) => {
      const token = httpStreamToken(c, route);
      if (!token) return next();
      const visitId = c.req.param("id") ?? "";
      const providerId = await tokenProvider(deps, token, visitId);
      if (!providerId) return apiError(c, 401, "UNAUTHENTICATED", "Invalid or expired stream token.", false);
      c.set("actor", { providerId, identity: `visit:${visitId}` });
      return run(deps, c, providerId, visitId);
    };
  app.post("/api/visits/:id/stop", withToken(stopVisitAs, "visits.stop"));
  app.get("/api/visits/:id/status", withToken(visitStatusAs, "visits.status"));

  app.get("/api/visits/:id/stream", async (c) => {
    const v = deps.visits;
    if (!v) return unavailable(c);
    const visitId = c.req.param("id");
    const cred = streamCredential(c, "visits.stream");
    let providerId: string | null = null;
    if (cred.token) {
      providerId = await tokenProvider(deps, cred.token, visitId);
      if (!providerId) return apiError(c, 401, "UNAUTHENTICATED", "Invalid or expired stream token.", false);
      c.set("actor", { providerId, identity: `visit:${visitId}` });
    } else {
      // Cross-site WebSocket hijacking guard: a browser always sends Origin, and only our own
      // origin may ride the cookie. No Origin (a native bridge) → first-message auth.
      const origin = c.req.header("Origin");
      if (origin && origin !== new URL(c.req.url).origin && origin !== deps.env.APP_ORIGIN) {
        return apiError(c, 403, "ORIGIN_REJECTED", "Cross-origin stream rejected.", false);
      }
      if (origin) providerId = await cookieProvider(c);
    }
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return apiError(c, 426, "UPGRADE_REQUIRED", "Expected a WebSocket upgrade.", false);
    }

    const prepare = async (pid: string): Promise<Prepared> => {
      const visit = await v.store.getVisit(pid, visitId);
      if (!visit) return { ok: false, status: 404, code: "NOT_FOUND", message: "Visit not found" };
      if (visit.status !== "recording") return { ok: false, status: 409, code: "VISIT_STOPPED", message: "This visit has already been stopped." };
      const open = v.openTranscriber ?? defaultOpen(deps);
      return {
        ok: true,
        make: ({ send, defer }) =>
          new CaptureSession({
            visit,
            store: v.store,
            openTranscriber: (events) => open(visit.transcriber, events, visit),
            send,
            now: () => deps.clock.now(),
            defer,
          }),
      };
    };

    const logIds = { visitId };
    if (providerId) {
      const p = await prepare(providerId);
      if (!p.ok) return apiError(c, p.status, p.code, p.message, false);
      return serveCaptureSocket(c, { make: p.make }, logIds, cred.protocol);
    }
    return serveCaptureSocket(
      c,
      {
        authenticate: async (token) => {
          const pid = await tokenProvider(deps, token, visitId);
          return pid ? prepare(pid) : null;
        },
        timeoutMs: v.streamAuthTimeoutMs,
      },
      logIds,
      cred.protocol,
    );
  });

  return app;
}

export type CaptureFactory = (io: { send: (msg: unknown) => void; defer: ((p: Promise<unknown>) => void) | undefined }) => CaptureSession;

/** A capture ready to stream, or why not (HTTP status before the upgrade, close reason after). */
export type Prepared = { ok: true; make: CaptureFactory } | { ok: false; status: 404 | 409; code: string; message: string };

/**
 * How serveCaptureSocket authenticates: already done (header token or cookie), or wait for the
 * first message `{"type":"auth","token":"…"}` (`authenticate` → null when the token is invalid).
 */
export type CaptureAuth =
  | { make: CaptureFactory }
  | { authenticate: (token: string) => Promise<Prepared | null>; timeoutMs?: number };

/**
 * Accepts the WebSocket for one capture (band visit or recording) and wires it to a
 * CaptureSession: same protocol and lifecycle for both (docs/band-bridge.md section 2).
 * `auth`: see CaptureAuth. `protocol`: the subprotocol to echo in the 101 (`vfa-stream`), or null.
 * `logIds` holds ids only (never tokens).
 */
export function serveCaptureSocket(
  c: Context<AppBindings>,
  auth: CaptureAuth,
  logIds: Record<string, string>,
  protocol: string | null = null,
): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const send = (msg: unknown) => {
    try {
      server.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  };
  const closeWith = (code: number, reason: string) => {
    try {
      server.close(code, reason);
    } catch {
      /* ignore */
    }
  };
  let defer: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    defer = (p) => ctx.waitUntil(p);
  } catch {
    defer = undefined;
  }

  let session: CaptureSession | null = null;
  let opened: Promise<void> = Promise.resolve();
  const start = (make: CaptureFactory) => {
    const s = make({ send, defer });
    session = s;
    opened = s.open().catch((err: unknown) => {
      log("warn", "visit.transcriber_open_failed", { ...logIds, errorName: err instanceof Error ? err.name : "unknown" });
      send({ type: "error", code: "transcriber_unavailable", message: err instanceof Error ? err.message : "Transcriber unavailable" });
      closeWith(1011, "transcriber unavailable");
    });
    defer?.(opened);
  };

  // `gate` resolves true once a session exists (messages wait on it, in arrival order).
  let gate: Promise<boolean>;
  let awaitingAuth = false;
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let onAuthMessage: (data: unknown) => Promise<void> = async () => undefined;
  if ("make" in auth) {
    start(auth.make);
    gate = Promise.resolve(true);
  } else {
    awaitingAuth = true;
    let settle: (ok: boolean) => void = () => undefined;
    gate = new Promise<boolean>((r) => (settle = r));
    const reject = (reason: string) => {
      log("info", "stream.auth_rejected", { ...logIds, reason });
      settle(false);
      closeWith(CLOSE_POLICY, reason);
    };
    authTimer = setTimeout(() => {
      if (!awaitingAuth) return;
      awaitingAuth = false;
      reject("auth timeout");
    }, auth.timeoutMs ?? STREAM_AUTH_TIMEOUT_MS);
    onAuthMessage = async (data) => {
      awaitingAuth = false;
      clearTimeout(authTimer);
      const token = authMessageToken(data);
      if (!token) return reject("auth required");
      const p = await auth.authenticate(token).catch(() => null);
      if (!p) return reject("unauthorized");
      if (!p.ok) {
        send({ type: "error", code: p.code.toLowerCase(), message: p.message });
        return reject(p.code.toLowerCase());
      }
      start(p.make);
      settle(true);
    };
  }

  server.addEventListener("message", (e: MessageEvent) => {
    if (awaitingAuth) {
      const w = onAuthMessage(e.data).catch(() => undefined);
      defer?.(w);
      return;
    }
    const work = (async () => {
      if (!(await gate)) return;
      await opened;
      const s = session;
      if (!s) return;
      if (typeof e.data === "string") {
        if (isAuthMessage(e.data)) return; // redundant auth after header auth: ignore
        if (await s.onText(e.data)) closeWith(1000, "done");
      } else {
        const buf = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(e.data as ArrayBufferLike);
        s.onBinary(buf);
      }
    })().catch(() => undefined);
    defer?.(work);
  });
  server.addEventListener("close", () => {
    awaitingAuth = false;
    clearTimeout(authTimer);
    const s = session;
    if (!s) return;
    const closed = s.onClose();
    defer?.(closed);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {}),
  });
}
