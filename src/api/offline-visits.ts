/**
 * Offline recordings, device API (Authorization: Bearer vfad_…; contract src/contracts/offline.ts,
 * docs/offline-recording.md). Mounted with the device API, before requireActor.
 *
 *   POST /api/device/offline-visits            OfflineVisitCreateRequest → 201 | 200 (same localId) OfflineVisitCreateResponse
 *   PUT  /api/device/offline-visits/:id/audio  VXREC1 body (application/octet-stream) → 202 {status:"queued"} | 200 {status:"already_transcribed"}
 *   GET  /api/device/offline-visits/:id        → OfflineVisitStatus
 *
 * The visit is created already stopped with its real (past) start/end; its appointment stays
 * canceled (invisible to discovery) until the transcript is stored. The file goes to R2
 * (AUDIO_TMP) only until transcription. Logs: ids and sizes only.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  Appointment,
  MAX_OFFLINE_AGE_DAYS,
  MAX_OFFLINE_RECORDING_MS,
  MAX_OFFLINE_UPLOAD_BYTES,
  OFFLINE_CLOCK_SKEW_MS,
  OfflineVisitCreateRequest,
  VISIT_APPOINTMENT_PREFIX,
  type OfflineTranscribeJob,
  type OfflineUploadResponse,
  type OfflineVisitCreateResponse,
  type OfflineVisitStatus,
  type SessionStatus,
  type Visit,
} from "../contracts";
import { apiError, log } from "../security";
import { createDeviceStore, requireDevice, type DeviceBindings } from "../devices";
import { createVisitStore, type VisitStore } from "../band/store";
import { createOfflineStore, type OfflineRow, type OfflineStore } from "../offline/store";
import { audioKey, FAILED_AUDIO_RETENTION_MS, type AudioBucket } from "../offline/job";
import { parseVxrec, VxrecError } from "../offline/vxrec";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";
import { captureStatus } from "./visits";

const asApp = (c: Context<DeviceBindings>) => c as unknown as Context<AppBindings>;

const REVIEWABLE: SessionStatus[] = ["NEEDS_REVIEW", "APPROVED", "COMPLETED"];
const DEAD_END: SessionStatus[] = ["FAILED", "NO_EVIDENCE", "AMBIGUOUS_MATCH", "INCOMPLETE"];

export interface OfflineRouteOptions {
  store?: OfflineStore;
  visits?: VisitStore;
  /** Override AUDIO_TMP (tests). */
  bucket?: AudioBucket;
}

export function offlineStatusOf(row: OfflineRow, visit: Visit | null, sessionStatus: SessionStatus | null): OfflineVisitStatus {
  const base = {
    visitId: row.visitId,
    sessionId: visit?.sessionId ?? null,
    segmentCount: visit?.segmentCount ?? 0,
    canDeleteLocalFile: row.status === "transcribed",
    error: null,
  };
  switch (row.status) {
    case "awaiting_audio":
      return { ...base, status: "awaiting_audio" };
    case "transcribing":
      return { ...base, status: "transcribing" };
    case "failed":
      return { ...base, status: "failed", error: row.error ?? { code: "FAILED", message: "Transcription failed.", retryable: true } };
    case "transcribed":
      if (sessionStatus && REVIEWABLE.includes(sessionStatus)) return { ...base, status: "needs_review" };
      if (sessionStatus && DEAD_END.includes(sessionStatus)) {
        return {
          ...base,
          status: "failed",
          error: { code: `SESSION_${sessionStatus}`, message: `The transcript was stored, but processing ended as ${sessionStatus}; see the session in the web app.`, retryable: false },
        };
      }
      return { ...base, status: "processing" };
  }
}

export function offlineVisitRoutes(deps: ApiDeps, opts: OfflineRouteOptions = {}): Hono<DeviceBindings> {
  const app = new Hono<DeviceBindings>();
  const store = opts.store ?? createOfflineStore(deps.env.DB);
  const visits = opts.visits ?? deps.visits?.store ?? createVisitStore(deps.env.DB);
  const bucket = (): AudioBucket | undefined => opts.bucket ?? (deps.env.AUDIO_TMP as AudioBucket | undefined);
  const deviceAuth = requireDevice(deps, createDeviceStore(deps.env.DB));
  // deviceRoutes' own /api/device/* middleware may already have authenticated this request.
  const auth: MiddlewareHandler<DeviceBindings> = (c, next) => (c.get("device") ? next() : deviceAuth(c, next));
  app.use("/api/device/offline-visits", auth);
  app.use("/api/device/offline-visits/*", auth);

  const notConfigured = (c: Context<DeviceBindings>) =>
    apiError(c, 503, "OFFLINE_NOT_CONFIGURED", "Offline uploads are not configured on this server (AUDIO_TMP).", false);

  const respondCreated = async (c: Context<DeviceBindings>, row: OfflineRow, status: 200 | 201) => {
    const visit = await visits.getVisit(row.providerId, row.visitId);
    if (!visit) return apiError(c, 500, "INTERNAL", "Offline visit missing", true);
    const origin = new URL(c.req.url).origin;
    const path = `/api/device/offline-visits/${encodeURIComponent(row.visitId)}`;
    const session = visit.sessionId ? await deps.repo.getSession(visit.sessionId) : null;
    const res: OfflineVisitCreateResponse = {
      visit,
      uploadUrl: `${origin}${path}/audio`,
      statusUrl: `${origin}${path}`,
      maxUploadBytes: MAX_OFFLINE_UPLOAD_BYTES,
      status: offlineStatusOf(row, visit, session?.status ?? null).status,
    };
    return ok(asApp(c), res, status);
  };

  app.post("/api/device/offline-visits", async (c) => {
    const body = OfflineVisitCreateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, "VALIDATION", body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
    const req = body.data;
    const device = c.get("device");
    const providerId = device.providerId;
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

    const existing = await store.getByLocalId(device.id, req.localId);
    if (existing) return replay(c, existing, req);

    if (!bucket()) return notConfigured(c);
    const transcriber = captureStatus(deps.env).transcriber;
    if (!transcriber || transcriber === "device") {
      return apiError(c, 503, "TRANSCRIPTION_NOT_CONFIGURED", "Transcription is not configured (DEEPGRAM_API_KEY). Keep the recording and try again later.", true);
    }
    const template = await visits.latestAppointmentForClient(providerId, req.clientRef);
    if (!template) {
      return apiError(c, 422, "NO_SERVICE_PLAN", "This client has no service plan on file yet (no earlier appointment to copy it from).", false);
    }
    const id = crypto.randomUUID().replace(/-/g, "");
    const appointmentId = `${VISIT_APPOINTMENT_PREFIX}${id}`;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const appointment = Appointment.parse({
      ...template,
      id: appointmentId,
      occurrenceId: appointmentId,
      startAt: fromIso,
      endAt: toIso,
      timezone: req.timezone ?? template.timezone,
      canceled: true,
    });
    let row: OfflineRow;
    try {
      row = await store.create({
        visitId: `visit_${id}`,
        providerId,
        deviceId: device.id,
        localId: req.localId,
        appointment,
        bandNumber: req.bandNumber,
        transcriber,
        recordedFrom: fromIso,
        recordedTo: toIso,
        consentConfirmedAt: new Date(consent).toISOString(),
        now: now.toISOString(),
      });
    } catch (err) {
      // Concurrent retry with the same localId: the unique index kept one; answer with it.
      const again = await store.getByLocalId(device.id, req.localId);
      if (again) return replay(c, again, req);
      throw err;
    }
    log("info", "offline.visit_created", { visitId: row.visitId, deviceId: device.id, durationSec: Math.round((to - from) / 1000) });
    return respondCreated(c, row, 201);
  });

  /** Same (device, localId) again: the same visit, if the request describes the same recording. */
  async function replay(c: Context<DeviceBindings>, row: OfflineRow, req: OfflineVisitCreateRequest) {
    const visit = await visits.getVisit(row.providerId, row.visitId);
    const same =
      visit &&
      visit.clientRef === req.clientRef &&
      visit.bandNumber === req.bandNumber &&
      Date.parse(row.recordedFrom) === Date.parse(req.recordedFrom) &&
      Date.parse(row.recordedTo) === Date.parse(req.recordedTo);
    if (!same) {
      return apiError(c, 409, "LOCAL_ID_CONFLICT", "This localId was already used for a different recording on this device.", false);
    }
    return respondCreated(c, row, 200);
  }

  app.put("/api/device/offline-visits/:id/audio", async (c) => {
    const providerId = c.get("device").providerId;
    const row = await store.get(providerId, c.req.param("id"));
    if (!row) return apiError(c, 404, "NOT_FOUND", "Offline visit not found", false);
    const b = bucket();
    if (!b) return notConfigured(c);
    const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/octet-stream") {
      return apiError(c, 415, "UNSUPPORTED_MEDIA_TYPE", "Send the VXREC1 file as Content-Type: application/octet-stream.", false);
    }
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > MAX_OFFLINE_UPLOAD_BYTES) return tooLarge(c);
    if (row.status === "transcribed") return ok(asApp(c), { status: "already_transcribed" } satisfies OfflineUploadResponse, 200);
    if (row.status === "transcribing") return ok(asApp(c), { status: "queued" } satisfies OfflineUploadResponse, 202);

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_OFFLINE_UPLOAD_BYTES) return tooLarge(c);
    if (bytes.length === 0) return apiError(c, 400, "FILE_EMPTY", "The request body is empty.", false);
    let packets: number;
    try {
      const parsed = parseVxrec(bytes);
      packets = parsed.packetCount;
      const visit = await visits.getVisit(providerId, row.visitId);
      if (parsed.header.localId !== row.localId || (visit && parsed.header.clientRef !== visit.clientRef)) {
        return apiError(c, 400, "FILE_MISMATCH", "This file belongs to another recording (localId / clientRef differ).", false);
      }
      const lo = Date.parse(row.recordedFrom) - OFFLINE_CLOCK_SKEW_MS;
      const hi = Date.parse(row.recordedTo) + OFFLINE_CLOCK_SKEW_MS;
      if (parsed.runs.some((r) => r.audioStartMs < lo || r.audioStartMs > hi)) {
        return apiError(c, 400, "FILE_MISMATCH", "An audio run starts outside recordedFrom..recordedTo.", false);
      }
    } catch (err) {
      if (err instanceof VxrecError) return apiError(c, 400, `FILE_${err.code}`, err.message, false);
      throw err;
    }

    const key = audioKey(providerId, row.visitId);
    try {
      await b.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    } catch (err) {
      log("warn", "offline.store_failed", { visitId: row.visitId, bytes: bytes.length, errorName: err instanceof Error ? err.name : "unknown" });
      return apiError(c, 503, "STORAGE_UNAVAILABLE", "Could not store the file; try again.", true);
    }
    const now = deps.clock.now();
    if (!(await store.markUploaded(row.visitId, { key, bytes: bytes.length, now: now.toISOString() }))) {
      // A concurrent upload won the race; it has queued the job.
      return ok(asApp(c), { status: "queued" } satisfies OfflineUploadResponse, 202);
    }
    const job: OfflineTranscribeJob = { kind: "transcribe_offline", schemaVersion: "1", visitId: row.visitId, providerId };
    try {
      await deps.env.SESSION_QUEUE.send(job);
    } catch (err) {
      await store.revertUpload(row.visitId, now.toISOString(), new Date(now.getTime() + FAILED_AUDIO_RETENTION_MS).toISOString());
      log("warn", "offline.enqueue_failed", { visitId: row.visitId, errorName: err instanceof Error ? err.name : "unknown" });
      return apiError(c, 503, "QUEUE_UNAVAILABLE", "Could not queue the transcription; upload again.", true);
    }
    log("info", "offline.uploaded", { visitId: row.visitId, bytes: bytes.length, packets });
    return ok(asApp(c), { status: "queued" } satisfies OfflineUploadResponse, 202);
  });

  app.get("/api/device/offline-visits/:id", async (c) => {
    const providerId = c.get("device").providerId;
    const row = await store.get(providerId, c.req.param("id"));
    if (!row) return apiError(c, 404, "NOT_FOUND", "Offline visit not found", false);
    const visit = await visits.getVisit(providerId, row.visitId);
    const session = visit?.sessionId ? await deps.repo.getSession(visit.sessionId) : null;
    return ok(asApp(c), offlineStatusOf(row, visit, session?.status ?? null));
  });

  return app;
}

function tooLarge(c: Context<DeviceBindings>) {
  return apiError(c, 413, "PAYLOAD_TOO_LARGE", `The file is larger than ${MAX_OFFLINE_UPLOAD_BYTES} bytes.`, false);
}
