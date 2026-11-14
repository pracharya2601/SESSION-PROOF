/**
 * Band visits API. A provider starts a visit for a client, streams the Vexo
 * band's audio (browser or GlassCam bridge), stops it, and the visit's
 * transcript becomes the evidence for a normal session.
 *
 *   GET  /api/visits/capture-status   → CaptureStatus
 *   GET  /api/visits                  → Visit[] (the actor's, newest first)
 *   POST /api/visits                  StartVisitRequest → 201 StartVisitResponse
 *   GET  /api/visits/:id              → VisitDetail
 *   POST /api/visits/:id/stop         → StopVisitResponse (hands the visit to processing)
 *   GET  /api/visits/:id/stream       WebSocket (cookie + same Origin, or ?token=)
 *
 * The stream route is mounted before requireActor (a bridge has no cookie) and
 * authenticates itself. Audio is never stored.
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
  type VisitDetail,
} from "../contracts";
import { apiError, log, requireActor } from "../security";
import { CaptureSession } from "../band/capture";
import type { VisitStore } from "../band/store";
import { signStreamToken, verifyStreamToken } from "../band/token";
import { openDeepgram, openSimulated, type TranscriberEvents, type TranscriberSession } from "../band/transcriber";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

/** Band appointments stay open (not discoverable) until stopped; this is the safety cap. */
const OPEN_VISIT_HOURS = 12;

export interface VisitDeps {
  store: VisitStore;
  /** Ensure + enqueue the session for an appointment (jobs.enqueueAppointment). */
  enqueueAppointment: (appt: Appointment) => Promise<{ sessionId: string }>;
  /** Override for tests. */
  openTranscriber?: (kind: Transcriber, events: TranscriberEvents) => Promise<TranscriberSession>;
}

export function captureStatus(env: ApiDeps["env"]): CaptureStatus {
  if (env.DEEPGRAM_API_KEY) return { transcriber: "deepgram", reason: null };
  if (env.RUNTIME_MODE !== "deployed") {
    return { transcriber: "simulated", reason: "No DEEPGRAM_API_KEY: local dev uses a simulated, synthetic transcript." };
  }
  return { transcriber: null, reason: "Transcription is not configured (DEEPGRAM_API_KEY)." };
}

function defaultOpen(deps: ApiDeps) {
  return (kind: Transcriber, events: TranscriberEvents): Promise<TranscriberSession> => {
    if (kind === "simulated") {
      if (deps.env.RUNTIME_MODE === "deployed") return Promise.reject(new Error("simulated transcriber is dev only"));
      return Promise.resolve(openSimulated(events));
    }
    const key = deps.env.DEEPGRAM_API_KEY;
    if (!key) return Promise.reject(new Error("DEEPGRAM_API_KEY missing"));
    return openDeepgram(key, events, deps.fetch ?? fetch);
  };
}

function wsOrigin(c: Context<AppBindings>): string {
  const u = new URL(c.req.url);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
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
    const v = deps.visits;
    if (!v) return unavailable(c);
    const actor = c.get("actor");
    const body = StartVisitRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", body.error.issues.map((i) => i.message).join("; "), false);
    const status = captureStatus(deps.env);
    if (!status.transcriber) return apiError(c, 503, "TRANSCRIPTION_NOT_CONFIGURED", status.reason ?? "Unavailable", false);

    if (body.data.scenario && (status.transcriber !== "simulated" || deps.env.RUNTIME_MODE === "deployed")) {
      return apiError(c, 400, "SCENARIO_DEV_ONLY", "Synthetic scenarios only run with the simulated transcriber in local dev.", false);
    }
    const template = await v.store.latestAppointmentForClient(actor.providerId, body.data.clientRef);
    if (!template) {
      return apiError(c, 422, "NO_SERVICE_PLAN", "This client has no service plan on file yet (no earlier appointment to copy it from).", false);
    }
    const now = deps.clock.now();
    const id = crypto.randomUUID().replace(/-/g, "");
    const appointmentId = `${VISIT_APPOINTMENT_PREFIX}${id}`;
    const appointment = Appointment.parse({
      ...template,
      id: appointmentId,
      occurrenceId: appointmentId,
      startAt: now.toISOString(),
      endAt: new Date(now.getTime() + OPEN_VISIT_HOURS * 3600_000).toISOString(),
      timezone: body.data.timezone ?? template.timezone,
      canceled: false,
    });
    const visit = await v.store.createVisit({
      id: `visit_${id}`,
      providerId: actor.providerId,
      appointment,
      bandNumber: body.data.bandNumber,
      transport: body.data.transport,
      transcriber: status.transcriber,
      startedAt: now.toISOString(),
      scenario: body.data.scenario ?? null,
    });
    const secret = deps.env.SESSION_SECRET;
    if (!secret) return apiError(c, 503, "AUTH_NOT_CONFIGURED", "SESSION_SECRET is not configured.", false);
    const t = await signStreamToken({ providerId: actor.providerId, visitId: visit.id, nowMs: now.getTime() }, secret);
    const res: StartVisitResponse = {
      visit,
      streamUrl: `${wsOrigin(c)}/api/visits/${encodeURIComponent(visit.id)}/stream?token=${encodeURIComponent(t.token)}`,
      streamTokenExpiresAt: t.expiresAt,
    };
    return ok(c, res, 201);
  });

  app.get("/api/visits/:id", async (c) => {
    const v = deps.visits;
    if (!v) return unavailable(c);
    const visit = await v.store.getVisit(c.get("actor").providerId, c.req.param("id"));
    if (!visit) return apiError(c, 404, "NOT_FOUND", "Visit not found", false);
    const res: VisitDetail = { visit, segments: await v.store.listSegments(visit.id) };
    return ok(c, res);
  });

  app.post("/api/visits/:id/stop", async (c) => {
    const v = deps.visits;
    if (!v) return unavailable(c);
    const actor = c.get("actor");
    const stopped = await v.store.stopVisit(actor.providerId, c.req.param("id"), deps.clock.now().toISOString());
    if (!stopped) return apiError(c, 404, "NOT_FOUND", "Visit not found", false);
    let sessionId = stopped.sessionId;
    if (!sessionId) {
      const appt = await deps.repo.getAppointment(stopped.appointmentId);
      if (!appt) return apiError(c, 500, "INTERNAL", "Visit appointment missing", true);
      sessionId = (await v.enqueueAppointment(appt)).sessionId;
      await v.store.setSession(stopped.id, sessionId);
    }
    const visit = (await v.store.getVisit(actor.providerId, stopped.id)) ?? stopped;
    const res: StopVisitResponse = { visit, sessionId };
    return ok(c, res);
  });

  return app;
}

/** The WebSocket route; mounted BEFORE requireActor. */
export function visitStreamRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const cookieAuth = requireActor(deps);

  // Token (native bridge) or cookie + same-origin (browser).
  const auth: MiddlewareHandler<AppBindings> = async (c, next) => {
    const token = c.req.query("token");
    const visitId = c.req.param("id") ?? "";
    if (token) {
      const secret = deps.env.SESSION_SECRET;
      const providerId = secret ? await verifyStreamToken(token, visitId, secret, deps.clock.now().getTime()) : null;
      if (!providerId) return apiError(c, 401, "UNAUTHENTICATED", "Invalid or expired stream token.", false);
      c.set("actor", { providerId, identity: `visit:${visitId}` });
      return next();
    }
    // Cross-site WebSocket hijacking guard: a browser always sends Origin.
    const origin = c.req.header("Origin");
    const self = new URL(c.req.url).origin;
    if (!origin || (origin !== self && origin !== deps.env.APP_ORIGIN)) {
      return apiError(c, 403, "ORIGIN_REJECTED", "Cross-origin stream rejected.", false);
    }
    return cookieAuth(c, next);
  };

  app.get("/api/visits/:id/stream", auth, async (c) => {
    const v = deps.visits;
    if (!v) return unavailable(c);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return apiError(c, 426, "UPGRADE_REQUIRED", "Expected a WebSocket upgrade.", false);
    }
    const visit = await v.store.getVisit(c.get("actor").providerId, c.req.param("id"));
    if (!visit) return apiError(c, 404, "NOT_FOUND", "Visit not found", false);
    if (visit.status !== "recording") return apiError(c, 409, "VISIT_STOPPED", "This visit has already been stopped.", false);

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
    let defer: ((p: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      defer = (p) => ctx.waitUntil(p);
    } catch {
      defer = undefined;
    }
    const open = v.openTranscriber ?? defaultOpen(deps);
    const session = new CaptureSession({
      visit,
      store: v.store,
      openTranscriber: (events) => open(visit.transcriber, events),
      send,
      now: () => deps.clock.now(),
      defer,
    });
    const opened = session.open().catch((err: unknown) => {
      log("warn", "visit.transcriber_open_failed", { visitId: visit.id, errorName: err instanceof Error ? err.name : "unknown" });
      send({ type: "error", code: "transcriber_unavailable", message: err instanceof Error ? err.message : "Transcriber unavailable" });
      try {
        server.close(1011, "transcriber unavailable");
      } catch {
        /* ignore */
      }
    });
    defer?.(opened);

    server.addEventListener("message", (e: MessageEvent) => {
      const work = (async () => {
        await opened;
        if (typeof e.data === "string") {
          if (await session.onText(e.data)) {
            try {
              server.close(1000, "done");
            } catch {
              /* ignore */
            }
          }
        } else {
          const buf = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(e.data as ArrayBufferLike);
          session.onBinary(buf);
        }
      })().catch(() => undefined);
      defer?.(work);
    });
    server.addEventListener("close", () => {
      defer?.(session.onClose());
    });

    return new Response(null, { status: 101, webSocket: client });
  });

  return app;
}
