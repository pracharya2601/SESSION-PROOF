/**
 * Recordings API (contract src/contracts/schedule.ts, docs/recordings.md). The phone records
 * with NO client; the server partitions the transcript into sessions by the calendar.
 *
 * Device (Authorization: Bearer vfad_…, mounted before requireActor):
 *   POST /api/device/recordings            StartRecordingRequest → 201 StartRecordingResponse
 *   GET  /api/device/recordings/:id        → { recording }
 *   POST /api/device/recordings/:id/stop   → 202 { recording } (partition job queued)
 *   GET  /api/device/schedule?date=YYYY-MM-DD[&timezone=IANA] → { events: CalendarEvent[] }
 *   POST /api/device/offline-recordings    OfflineRecordingCreateRequest → 201 | 200 (same localId)
 *   PUT  /api/device/offline-recordings/:id/audio  VXREC1 → 202 { status: "queued" } | 200 { status: "already_transcribed" }
 *   GET  /api/device/offline-recordings/:id → OfflineRecordingStatus
 * Stream (stream token, mounted before requireActor):
 *   GET  /api/recordings/:id/stream          WebSocket, the visit protocol (docs/band-bridge.md §2).
 *        Auth like the visit stream (src/api/visits.ts): `Sec-WebSocket-Protocol: vfa-stream,
 *        vfa-token.<streamToken>`, or a first message {"type":"auth","token":"…"} within 5 s.
 *        `?token=` is deprecated (still accepted, counted in logs).
 * Web (cookie / public auth, after requireActor):
 *   GET  /api/recordings                   → Recording[] (with partition summary)
 *   GET  /api/recordings/:id               → RecordingDetail (segments + assignment + suggestions + sessionConversations)
 *   POST /api/recordings/:id/suggestions/:sid/accept  AcceptSuggestionRequest → { suggestion, sessionId }
 *   POST /api/recordings/:id/suggestions/:sid/reject  → { suggestion }
 *   POST /api/recordings/:id/sessions/:eventId/conversation  ConversationDecisionRequest → { conversation }
 *
 * Another provider's recording is 404 everywhere. Audio is never stored (offline files only in
 * R2 until transcribed). Logs: ids and counts only.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  MAX_OFFLINE_AGE_DAYS,
  MAX_OFFLINE_RECORDING_MS,
  MAX_OFFLINE_UPLOAD_BYTES,
  OFFLINE_CLOCK_SKEW_MS,
  StartRecordingRequest,
  type CalendarEvent,
  type CalendarSource,
  type Recording,
  type StartRecordingResponse,
} from "../contracts";
import type { ScenarioLine } from "../../fixtures/band/types";
import { apiError, log } from "../security";
import { createDeviceStore, requireDevice, type DeviceBindings } from "../devices";
import { CaptureSession } from "../band/capture";
import { signStreamToken, verifyStreamToken } from "../band/token";
import { openDeepgram, openSimulated, type TranscriberEvents, type TranscriberSession } from "../band/transcriber";
import { createOfflineStore, type OfflineRow, type OfflineStore } from "../offline/store";
import type { AudioBucket } from "../offline/job";
import { acceptOfflineUpload } from "../offline/upload";
import {
  OfflineRecordingCreateRequest,
  RECORDING_ID_PREFIX,
  type OfflineRecordingCreateResponse,
  type OfflineRecordingState,
  type OfflineRecordingStatus,
  type PartitionRecordingJob,
  type RecordingDetail,
  type RecordingSegmentView,
} from "../recordings/contract";
import type { RecordingRow, RecordingStore } from "../recordings/store";
import { acceptSuggestion, decideConversation, publicSuggestion, rejectSuggestion, sessionConversations, type AcceptDeps, type DecisionResult } from "../recordings/content-accept";
import { AcceptSuggestionRequest, ConversationDecisionRequest } from "../contracts";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";
import { findCurrentEvent, listEventsForLocalDate } from "../schedule";
import { captureStatus, serveCaptureSocket, streamCredential, wsOrigin, type Prepared } from "./visits";

export interface RecordingDeps {
  store: RecordingStore;
  /** The provider's calendar (demo or Google). Absent → currentEvent null, schedule 503. */
  calendar?: CalendarSource;
  /** Sends a partition job. Default: env.SESSION_QUEUE. */
  enqueuePartition?: (job: PartitionRecordingJob) => Promise<unknown>;
  /** Dev only: synthetic day script for the simulated transcriber (fixtures/schedule). */
  dayScript?: (id: string) => ScenarioLine[] | null;
  /** Tests: override the transcriber. */
  openTranscriber?: (kind: Recording["transcriber"], events: TranscriberEvents, row: RecordingRow) => Promise<TranscriberSession>;
  /** Tests: first-message stream auth deadline (default STREAM_AUTH_TIMEOUT_MS, 5 s). */
  streamAuthTimeoutMs?: number;
  /** Offline uploads: overrides (tests). */
  offlineStore?: OfflineStore;
  bucket?: AudioBucket;
  /** Content suggestions (accept / reject, conversation decisions). Absent → 503 SUGGESTIONS_NOT_CONFIGURED. */
  content?: Omit<AcceptDeps, "store">;
}

/** ApiDeps plus the recordings wiring (built by the composition root, or a test harness). */
export type RecordingApiDeps = ApiDeps & { recordings?: RecordingDeps };

const asApp = (c: Context<DeviceBindings>) => c as unknown as Context<AppBindings>;
const unavailable = (c: Context<any>) => apiError(c, 503, "RECORDINGS_NOT_CONFIGURED", "Recordings are not configured on this server.", false);
const notFound = (c: Context<any>) => apiError(c, 404, "NOT_FOUND", "Recording not found", false);

function sendPartition(deps: RecordingApiDeps, r: RecordingDeps) {
  return (job: PartitionRecordingJob) =>
    r.enqueuePartition ? r.enqueuePartition(job) : (deps.env.SESSION_QUEUE as unknown as Queue<PartitionRecordingJob>).send(job);
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

function validZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** src/schedule findCurrentEvent, but never throws (a calendar outage must not block recording). */
export async function currentEventFor(calendar: CalendarSource | undefined, providerId: string, now: Date): Promise<CalendarEvent | null> {
  if (!calendar) return null;
  try {
    return await findCurrentEvent(calendar, providerId, now);
  } catch (err) {
    log("warn", "recording.calendar_unavailable", { errorName: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}

/**
 * GET /api/device/schedule: with a timezone, src/schedule listEventsForLocalDate (events
 * overlapping that local day); without one, events whose start falls on `date` in each event's own zone.
 */
export async function scheduleFor(calendar: CalendarSource, providerId: string, date: string, timeZone: string | null): Promise<CalendarEvent[]> {
  if (timeZone) {
    const events = await listEventsForLocalDate(calendar, providerId, date, timeZone);
    return events.filter((e) => e.providerId === providerId).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }
  return eventsStartingOn(calendar, providerId, date);
}

async function eventsStartingOn(calendar: CalendarSource, providerId: string, date: string): Promise<CalendarEvent[]> {
  const timeZone: string | null = null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dayUtc = Date.UTC(y, m - 1, d);
  const from = new Date(dayUtc - 14 * 3600_000);
  const to = new Date(dayUtc + 38 * 3600_000);
  const events = await calendar.listEvents(providerId, from, to);
  return events
    .filter((e) => e.providerId === providerId && localDate(new Date(e.startAt), timeZone ?? validZone(e.timezone) ?? "UTC") === date)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCMonth() + 1 === Number(m[2]) && t.getUTCDate() === Number(m[3]);
}

// ------------------------------------------------------------------ detail (web)
export async function recordingDetail(store: RecordingStore, row: RecordingRow): Promise<RecordingDetail> {
  const id = row.recording.id;
  const [segments, assignments, sessions, suggestions, conversations, sessionConvs] = await Promise.all([
    store.capture.listSegments(id),
    store.listAssignments(id),
    store.sessionIdsByEvent(id),
    store.listSuggestions(id),
    store.listConversations(id),
    sessionConversations(store, id),
  ]);
  const bySeg = new Map(segments.map((s) => [s.index, s]));
  const byAssign = new Map(assignments.map((a) => [a.index, a]));
  const indices = [...new Set([...bySeg.keys(), ...byAssign.keys()])].sort((a, b) => a - b);
  const out: RecordingSegmentView[] = indices.map((index) => {
    const s = bySeg.get(index);
    const a = byAssign.get(index);
    let assignment: RecordingSegmentView["assignment"] = { status: "pending" };
    if (a?.status === "assigned" && a.eventId && a.appointmentId) {
      const sess = sessions.get(a.eventId);
      assignment = {
        status: "assigned",
        eventId: a.eventId,
        appointmentId: a.appointmentId,
        clientRef: sess?.clientRef ?? null,
        sessionId: sess?.sessionId ?? null,
        method: a.method ?? "calendar_time",
      };
    } else if (a?.status === "unassigned") assignment = { status: "unassigned" };
    else if (a?.status === "ambiguous") assignment = { status: "ambiguous", candidateEventIds: a.candidateEventIds };
    return {
      index,
      observedFrom: s?.observedFrom ?? a!.observedFrom,
      observedTo: s?.observedTo ?? a!.observedTo,
      speaker: s?.speaker ?? null,
      text: s?.text ?? null,
      textDeleted: !s && !!a?.textDeletedAt,
      assignment,
    };
  });
  const convBy = new Map(conversations.map((c) => [c.scopeKey, c]));
  return {
    recording: row.recording,
    segments: out,
    suggestions: suggestions.map((sg) => publicSuggestion(sg, convBy.get(`suggestion:${sg.id}`) ?? null)),
    sessionConversations: sessionConvs,
  };
}

// ------------------------------------------------------------------ device routes
export function recordingDeviceRoutes(deps: RecordingApiDeps): Hono<DeviceBindings> {
  const app = new Hono<DeviceBindings>();
  const deviceAuth = requireDevice(deps, createDeviceStore(deps.env.DB));
  // deviceRoutes' own /api/device/* middleware may already have authenticated this request.
  const auth: MiddlewareHandler<DeviceBindings> = (c, next) => (c.get("device") ? next() : deviceAuth(c, next));
  for (const p of ["/api/device/recordings", "/api/device/recordings/*", "/api/device/schedule", "/api/device/offline-recordings", "/api/device/offline-recordings/*"]) {
    app.use(p, auth);
  }

  app.post("/api/device/recordings", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const body = StartRecordingRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
    const req = body.data;
    const status = captureStatus(deps.env);
    if (!status.transcriber || status.transcriber === "device") {
      return apiError(c, 503, "TRANSCRIPTION_NOT_CONFIGURED", status.reason ?? "Unavailable", false);
    }
    let transcriber: Recording["transcriber"] = status.transcriber;
    if (req.scenario) {
      if (deps.env.RUNTIME_MODE === "deployed" || (transcriber !== "simulated" && !r.dayScript)) {
        return apiError(c, 400, "SCENARIO_DEV_ONLY", "Synthetic scenarios only run with the simulated transcriber in local dev.", false);
      }
      if (!r.dayScript?.(req.scenario)) return apiError(c, 400, "UNKNOWN_SCENARIO", `Unknown scenario "${req.scenario}".`, false);
      // A day script always plays on the simulated transcriber, even when Deepgram is configured locally.
      transcriber = "simulated";
    }
    const tz = req.timezone !== undefined ? validZone(req.timezone) : null;
    if (req.timezone !== undefined && !tz) return apiError(c, 400, "VALIDATION", "timezone: unknown IANA zone", false);
    const secret = deps.env.SESSION_SECRET;
    if (!secret) return apiError(c, 503, "AUTH_NOT_CONFIGURED", "SESSION_SECRET is not configured.", false);
    const device = c.get("device");
    const providerId = device.providerId;
    const now = deps.clock.now();
    const id = `${RECORDING_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
    const recording = await r.store.create({
      id,
      providerId,
      deviceId: device.id,
      bandNumber: req.bandNumber,
      transport: req.transport,
      transcriber,
      startedAt: now.toISOString(),
      timezone: tz,
      scenario: req.scenario ?? null,
      now: now.toISOString(),
    });
    const t = await signStreamToken({ providerId, visitId: id, nowMs: now.getTime() }, secret);
    const res: StartRecordingResponse = {
      recording,
      streamUrl: `${wsOrigin(deps, asApp(c))}/api/recordings/${encodeURIComponent(id)}/stream`,
      streamToken: t.token,
      streamTokenExpiresAt: t.expiresAt,
      currentEvent: await currentEventFor(r.calendar, providerId, now),
    };
    log("info", "recording.started", { recordingId: id, deviceId: device.id, transcriber });
    return ok(asApp(c), res, 201);
  });

  app.get("/api/device/recordings/:id", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const row = await r.store.get(c.get("device").providerId, c.req.param("id"));
    return row ? ok(asApp(c), { recording: row.recording }) : notFound(c);
  });

  app.post("/api/device/recordings/:id/stop", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const providerId = c.get("device").providerId;
    const row = await r.store.stop(providerId, c.req.param("id"), deps.clock.now().toISOString());
    if (!row) return notFound(c);
    if (row.origin === "offline" && (await r.store.offlineState(row.recording.id)) !== "transcribed") {
      return apiError(c, 409, "RECORDING_PENDING_UPLOAD", "This offline recording is still being uploaded or transcribed.", true);
    }
    // Stopped but not yet partitioned (first stop, or a retry after a failed send): queue the job.
    if (row.recording.status === "stopped") {
      try {
        await sendPartition(deps, r)({ kind: "partition_recording", recordingId: row.recording.id, providerId });
      } catch (err) {
        log("warn", "recording.enqueue_failed", { recordingId: row.recording.id, errorName: err instanceof Error ? err.name : "unknown" });
        return apiError(c, 503, "QUEUE_UNAVAILABLE", "Could not queue the recording for processing; call stop again.", true);
      }
    }
    return ok(asApp(c), { recording: row.recording }, 202);
  });

  app.get("/api/device/schedule", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    if (!r.calendar) return apiError(c, 503, "CALENDAR_NOT_CONFIGURED", "No calendar is connected.", false);
    const tzRaw = c.req.query("timezone");
    const tz = validZone(tzRaw);
    if (tzRaw && !tz) return apiError(c, 400, "VALIDATION", "timezone: unknown IANA zone", false);
    const date = c.req.query("date") ?? localDate(deps.clock.now(), tz ?? "UTC");
    if (!validDate(date)) return apiError(c, 400, "VALIDATION", "date must be YYYY-MM-DD", false);
    try {
      return ok(asApp(c), { events: await scheduleFor(r.calendar, c.get("device").providerId, date, tz) });
    } catch (err) {
      log("warn", "recording.schedule_failed", { errorName: err instanceof Error ? err.name : "unknown" });
      return apiError(c, 503, "CALENDAR_UNAVAILABLE", "The calendar could not be read; try again.", true);
    }
  });

  // ---------------------------------------------------------------- offline recordings
  const offline = () => deps.recordings?.offlineStore ?? createOfflineStore(deps.env.DB);
  const bucket = (): AudioBucket | undefined => deps.recordings?.bucket ?? (deps.env.AUDIO_TMP as AudioBucket | undefined);

  const statusOf = (row: OfflineRow, rec: RecordingRow | null): OfflineRecordingStatus => {
    const base = {
      recordingId: row.visitId,
      segmentCount: rec?.recording.segmentCount ?? 0,
      canDeleteLocalFile: row.status === "transcribed",
      partition: rec?.recording.partition ?? null,
      error: null,
    };
    if (row.status === "failed") return { ...base, status: "failed", error: row.error ?? { code: "FAILED", message: "Transcription failed.", retryable: true } };
    if (row.status !== "transcribed") return { ...base, status: row.status };
    if (rec?.recording.status === "partitioned") return { ...base, status: "partitioned" };
    if (rec?.recording.status === "failed") {
      const code = rec.errorCode ?? "PARTITION_FAILED";
      return { ...base, status: "failed", error: { code, message: "The transcript was stored, but it could not be split into sessions.", retryable: false } };
    }
    return { ...base, status: "partitioning" };
  };

  const respondCreated = async (c: Context<DeviceBindings>, row: OfflineRow, code: 200 | 201) => {
    const rec = await deps.recordings!.store.get(row.providerId, row.visitId);
    if (!rec) return apiError(c, 500, "INTERNAL", "Offline recording missing", true);
    const origin = new URL(c.req.url).origin;
    const path = `/api/device/offline-recordings/${encodeURIComponent(row.visitId)}`;
    const res: OfflineRecordingCreateResponse = {
      recording: rec.recording,
      uploadUrl: `${origin}${path}/audio`,
      statusUrl: `${origin}${path}`,
      maxUploadBytes: MAX_OFFLINE_UPLOAD_BYTES,
      status: statusOf(row, rec).status as OfflineRecordingState,
    };
    return ok(asApp(c), res, code);
  };

  app.post("/api/device/offline-recordings", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const body = OfflineRecordingCreateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
    const req = body.data;
    const device = c.get("device");
    const now = deps.clock.now();
    const from = Date.parse(req.recordedFrom);
    const to = Date.parse(req.recordedTo);
    const consent = Date.parse(req.consentConfirmedAt);
    const bad = (m: string) => apiError(c, 400, "VALIDATION", m, false);
    if (!(to > from)) return bad("recordedTo must be after recordedFrom.");
    if (to - from > MAX_OFFLINE_RECORDING_MS) return bad("A recording can be at most 4 hours long.");
    if (to > now.getTime() + OFFLINE_CLOCK_SKEW_MS) return bad("recordedTo is in the future (check the phone clock).");
    if (from < now.getTime() - MAX_OFFLINE_AGE_DAYS * 86_400_000) return bad(`Recordings older than ${MAX_OFFLINE_AGE_DAYS} days are not accepted.`);
    if (consent > to || consent > now.getTime() + OFFLINE_CLOCK_SKEW_MS) return bad("consentConfirmedAt must be before the end of the recording.");
    const tz = req.timezone !== undefined ? validZone(req.timezone) : null;
    if (req.timezone !== undefined && !tz) return bad("timezone: unknown IANA zone");

    const store = offline();
    const replay = async (row: OfflineRow) => {
      const rec = row.target === "recording" ? await r.store.get(row.providerId, row.visitId) : null;
      const same =
        rec &&
        rec.recording.bandNumber === req.bandNumber &&
        Date.parse(row.recordedFrom) === from &&
        Date.parse(row.recordedTo) === to;
      if (!same) return apiError(c, 409, "LOCAL_ID_CONFLICT", "This localId was already used for a different recording on this device.", false);
      return respondCreated(c, row, 200);
    };
    const existing = await store.getByLocalId(device.id, req.localId);
    if (existing) return replay(existing);

    if (!bucket()) return apiError(c, 503, "OFFLINE_NOT_CONFIGURED", "Offline uploads are not configured on this server (AUDIO_TMP).", false);
    const transcriber = captureStatus(deps.env).transcriber;
    if (!transcriber || transcriber === "device") {
      return apiError(c, 503, "TRANSCRIPTION_NOT_CONFIGURED", "Transcription is not configured (DEEPGRAM_API_KEY). Keep the recording and try again later.", true);
    }
    let row: OfflineRow;
    try {
      row = await store.createForRecording({
        recordingId: `${RECORDING_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`,
        providerId: device.providerId,
        deviceId: device.id,
        localId: req.localId,
        bandNumber: req.bandNumber,
        transcriber,
        recordedFrom: new Date(from).toISOString(),
        recordedTo: new Date(to).toISOString(),
        timezone: tz,
        consentConfirmedAt: new Date(consent).toISOString(),
        now: now.toISOString(),
      });
    } catch (err) {
      const again = await store.getByLocalId(device.id, req.localId);
      if (again) return replay(again);
      throw err;
    }
    log("info", "offline.recording_created", { recordingId: row.visitId, deviceId: device.id, durationSec: Math.round((to - from) / 1000) });
    return respondCreated(c, row, 201);
  });

  app.put("/api/device/offline-recordings/:id/audio", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const row = await offline().get(c.get("device").providerId, c.req.param("id"));
    if (!row || row.target !== "recording") return notFound(c);
    const b = bucket();
    if (!b) return apiError(c, 503, "OFFLINE_NOT_CONFIGURED", "Offline uploads are not configured on this server (AUDIO_TMP).", false);
    const res = await acceptOfflineUpload({
      row,
      store: offline(),
      bucket: b,
      contentType: c.req.header("Content-Type"),
      declaredLength: Number(c.req.header("Content-Length") ?? "0"),
      readBody: () => c.req.arrayBuffer(),
      send: (job) => deps.env.SESSION_QUEUE.send(job),
      now: () => deps.clock.now(),
    });
    if (res.kind === "error") return apiError(c, res.status, res.code, res.message, res.retryable);
    return ok(asApp(c), res.body, res.status);
  });

  app.get("/api/device/offline-recordings/:id", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const providerId = c.get("device").providerId;
    const row = await offline().get(providerId, c.req.param("id"));
    if (!row || row.target !== "recording") return notFound(c);
    return ok(asApp(c), statusOf(row, await r.store.get(providerId, row.visitId)));
  });

  return app;
}

// ------------------------------------------------------------------ stream (token)
function openFor(deps: RecordingApiDeps, r: RecordingDeps) {
  return (kind: Recording["transcriber"], events: TranscriberEvents, row: RecordingRow): Promise<TranscriberSession> => {
    if (r.openTranscriber) return r.openTranscriber(kind, events, row);
    if (kind === "simulated") {
      if (deps.env.RUNTIME_MODE === "deployed") return Promise.reject(new Error("simulated transcriber is dev only"));
      if (row.scenario) {
        const script = r.dayScript?.(row.scenario);
        if (!script) return Promise.reject(new Error(`Unknown scenario "${row.scenario}"`));
        return Promise.resolve(openSimulated(events, script));
      }
      return Promise.resolve(openSimulated(events));
    }
    const key = deps.env.DEEPGRAM_API_KEY;
    if (!key) return Promise.reject(new Error("DEEPGRAM_API_KEY missing"));
    return openDeepgram(key, events, deps.fetch ?? fetch);
  };
}

/** WS /api/recordings/:id/stream (the visit protocol, stream-token auth). Mounted BEFORE requireActor. */
export function recordingStreamRoutes(deps: RecordingApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get("/api/recordings/:id/stream", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const id = c.req.param("id");
    const secret = deps.env.SESSION_SECRET;
    const verify = (token: string) => (secret ? verifyStreamToken(token, id, secret, deps.clock.now().getTime()) : Promise.resolve(null));
    const cred = streamCredential(c, "recordings.stream");
    // A token that was sent (header or query) must be valid; none → first-message auth.
    const providerId = cred.token ? await verify(cred.token) : null;
    if (cred.token && !providerId) return apiError(c, 401, "UNAUTHENTICATED", "Invalid or expired stream token.", false);
    if (!secret) return apiError(c, 401, "UNAUTHENTICATED", "Invalid or expired stream token.", false);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return apiError(c, 426, "UPGRADE_REQUIRED", "Expected a WebSocket upgrade.", false);
    const prepare = async (pid: string): Promise<Prepared> => {
      const row = await r.store.get(pid, id);
      if (!row) return { ok: false, status: 404, code: "NOT_FOUND", message: "Not found" };
      if (row.recording.status !== "recording") return { ok: false, status: 409, code: "RECORDING_STOPPED", message: "This recording has already been stopped." };
      const open = openFor(deps, r);
      return {
        ok: true,
        make: ({ send, defer }) =>
          new CaptureSession({
            visit: row.recording,
            store: r.store.capture,
            openTranscriber: (events) => open(row.recording.transcriber, events, row),
            send,
            now: () => deps.clock.now(),
            defer,
          }),
      };
    };
    const logIds = { recordingId: id };
    if (providerId) {
      const p = await prepare(providerId);
      if (!p.ok) return p.status === 404 ? notFound(c) : apiError(c, p.status, p.code, p.message, false);
      return serveCaptureSocket(c, { make: p.make }, logIds, cred.protocol);
    }
    return serveCaptureSocket(
      c,
      {
        authenticate: async (token) => {
          const pid = await verify(token);
          return pid ? prepare(pid) : null;
        },
        timeoutMs: r.streamAuthTimeoutMs,
      },
      logIds,
      cred.protocol,
    );
  });
  return app;
}

// ------------------------------------------------------------------ web (cookie)
export function recordingWebRoutes(deps: RecordingApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get("/api/recordings", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    return ok(c, await r.store.list(c.get("actor").providerId, 50));
  });
  app.get("/api/recordings/:id", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const row = await r.store.get(c.get("actor").providerId, c.req.param("id"));
    return row ? ok(c, await recordingDetail(r.store, row)) : notFound(c);
  });

  // ---------------------------------------------------------------- content suggestions (pass 2)
  const reply = <T>(c: Context<AppBindings>, res: DecisionResult<T>) => (res.ok ? ok(c, res.value) : apiError(c, res.status, res.code, res.message, res.status === 503));
  const body = async (c: Context<AppBindings>) => {
    const text = await c.req.text().catch(() => "");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };
  const notConfigured = (c: Context<AppBindings>) => apiError(c, 503, "SUGGESTIONS_NOT_CONFIGURED", "Content suggestions are not configured on this server.", false);

  app.post("/api/recordings/:id/suggestions/:sid/accept", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    if (!r.content) return notConfigured(c);
    const parsed = AcceptSuggestionRequest.safeParse(await body(c));
    if (!parsed.success) return apiError(c, 400, "VALIDATION", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") || "Invalid body", false);
    const res = await acceptSuggestion({ ...r.content, store: r.store }, c.get("actor").providerId, c.req.param("id"), c.req.param("sid"), parsed.data);
    return reply(c, res);
  });

  app.post("/api/recordings/:id/suggestions/:sid/reject", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    const b = await body(c);
    if (b === null || (typeof b === "object" && Object.keys(b as object).length > 0)) return apiError(c, 400, "VALIDATION", "reject takes no body", false);
    return reply(c, await rejectSuggestion(r.store, c.get("actor").providerId, c.req.param("id"), c.req.param("sid"), deps.clock.now().toISOString()));
  });

  app.post("/api/recordings/:id/sessions/:eventId/conversation", async (c) => {
    const r = deps.recordings;
    if (!r) return unavailable(c);
    if (!r.content) return notConfigured(c);
    const parsed = ConversationDecisionRequest.safeParse(await body(c));
    if (!parsed.success) return apiError(c, 400, "VALIDATION", "decision must be client_session or dismissed", false);
    const res = await decideConversation({ ...r.content, store: r.store }, c.get("actor").providerId, c.req.param("id"), c.req.param("eventId"), parsed.data.decision);
    return reply(c, res);
  });
  return app;
}
