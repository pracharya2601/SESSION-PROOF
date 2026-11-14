/**
 * Offline recording (FROZEN): when the phone (GlassCam) has no internet, it records the band's
 * Opus packets to a VXREC1 file and uploads it later. The server transcribes the file
 * (Deepgram pre-recorded) and the visit then goes through the normal pipeline → NEEDS_REVIEW.
 * Full description: docs/offline-recording.md.
 *
 * ---------------------------------------------------------------- VXREC1 file
 * All integers are unsigned, BIG-endian. One file = one visit.
 *
 *   magic   7 bytes  "VXREC1\n"            (56 58 52 45 43 31 0A)
 *   header  one line of UTF-8 JSON (VxrecHeader), terminated by "\n" (0A); max 16384 bytes incl. "\n"
 *   records until end of file, each:
 *     u8   runIndex   which audioRuns entry this packet belongs to
 *     u16  seq        the band's AUDIO-frame seq, as sent by the band (wraps 65535 → 0)
 *     u16  len        Opus packet length, 1..1500
 *     len  bytes      one Opus packet, exactly as the band sent it (16 kHz mono, 20 ms)
 *
 * Rules:
 * - A "run" is one uninterrupted band stream (from STREAM_START until the band disconnects).
 *   After a band reconnect seq restarts, so the phone starts a NEW run (next runIndex).
 * - audioRuns[i].audioStartMs = phone wall-clock epoch ms of the FIRST record of that run.
 *   The server times every packet as audioStartMs + (seq distance from the run's first record) × 20 ms,
 *   so lost packets (seq gaps) keep later times right.
 * - Records are grouped by run, in increasing runIndex; every record's runIndex is in audioRuns.
 *   audioRuns are listed in increasing runIndex with non-decreasing audioStartMs.
 * - A cut-off LAST record (app killed mid-write) is tolerated and dropped. Anything else malformed
 *   (bad magic, bad header, len 0 or > 1500, unknown or out-of-order runIndex) rejects the file.
 * - At most MAX_OFFLINE_PACKETS records (4 h at 50/s); at most MAX_OFFLINE_UPLOAD_BYTES per file.
 * - The header is only known at stop (audioRuns, recordedTo): write packets to a side file while
 *   recording, keep the run list in a small sidecar, and assemble magic + header + records at stop.
 *
 * ---------------------------------------------------------------- Device API (Authorization: Bearer vfad_…)
 *   POST /api/device/offline-visits            OfflineVisitCreateRequest → 201 (new) | 200 (same localId again) OfflineVisitCreateResponse
 *   PUT  /api/device/offline-visits/:id/audio  body = the VXREC1 file, Content-Type application/octet-stream
 *                                              → 202 { status: "queued" } | 200 { status: "already_transcribed" }
 *   GET  /api/device/offline-visits/:id        → OfflineVisitStatus
 * Responses use the usual envelope { data, correlationId } / { error: { code, message, retryable } }.
 * Another provider's visit → 404. No Origin header needed (bearer key).
 */
import { z } from "zod";
import { Visit } from "./band";
import { QueuePayload } from "./schemas";

const Instant = z.string().datetime({ offset: true });

export const VXREC_MAGIC = "VXREC1\n";
export const VXREC_MAX_HEADER_BYTES = 16384;
/** Max Opus packet bytes in one record (same cap as the live stream). */
export const VXREC_MAX_PACKET_BYTES = 1500;
/** 4 hours at 50 packets per second. */
export const MAX_OFFLINE_PACKETS = 4 * 60 * 60 * 50;
/** Max size of one uploaded file (50 MB). 4 h of band audio is about 15 MB. */
export const MAX_OFFLINE_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Max length of one offline recording (recordedTo − recordedFrom). */
export const MAX_OFFLINE_RECORDING_MS = 4 * 60 * 60 * 1000;
/** Oldest recording the server accepts (recordedFrom), counted from now. */
export const MAX_OFFLINE_AGE_DAYS = 30;
/** Clock skew tolerated for "not in the future" and run start times. */
export const OFFLINE_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** Phone-chosen id of one recording, unique per paired device (a UUID is recommended). */
export const OfflineLocalId = z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/, "localId: 8-64 chars of A-Z a-z 0-9 . _ : -");

export const VxrecRun = z.object({
  runIndex: z.number().int().min(0).max(255),
  audioStartMs: z.number().int().positive(),
});
export type VxrecRun = z.infer<typeof VxrecRun>;

/** The header JSON line. Unknown extra keys are ignored (forward compatible). */
export const VxrecHeader = z.object({
  version: z.literal(1),
  bandNumber: z.number().int().min(1).max(999).nullable(),
  audioRuns: z.array(VxrecRun).min(1).max(256),
  recordedFrom: Instant,
  recordedTo: Instant,
  clientRef: z.string().trim().min(1).max(64),
  /** Must equal the localId the visit was created with. */
  localId: OfflineLocalId,
  appVersion: z.string().min(1).max(64),
});
export type VxrecHeader = z.infer<typeof VxrecHeader>;

export const OfflineVisitCreateRequest = z
  .object({
    /** Idempotency key: the same (device, localId) returns the same visit. */
    localId: OfflineLocalId,
    clientRef: z.string().trim().min(1).max(64),
    bandNumber: z.number().int().min(1).max(999).nullable(),
    /** Real start / end of the recording (phone clock, ISO 8601 with offset). Become the appointment's start/end. */
    recordedFrom: Instant,
    recordedTo: Instant,
    /** IANA zone for the documents; defaults to the client's last appointment zone. */
    timezone: z.string().min(1).max(64).optional(),
    /** When the provider confirmed recording consent on the phone (before recording). */
    consentConfirmedAt: Instant,
  })
  .strict();
export type OfflineVisitCreateRequest = z.infer<typeof OfflineVisitCreateRequest>;

/**
 * awaiting_audio: created, no file yet (PUT it).
 * transcribing:   file received, queued or being transcribed.
 * processing:     transcript stored (audio deleted); the session is being drafted.
 * needs_review:   the draft is ready (NEEDS_REVIEW, or already approved/completed).
 * failed:         see error; error.retryable → PUT the same file again later.
 */
export const OfflineStatus = z.enum(["awaiting_audio", "transcribing", "processing", "needs_review", "failed"]);
export type OfflineStatus = z.infer<typeof OfflineStatus>;

export const OfflineVisitCreateResponse = z.object({
  /** Already "stopped" (it happened in the past); sessionId stays null until transcription finishes. */
  visit: Visit,
  /** Absolute URL for PUT (this server's origin + /api/device/offline-visits/<id>/audio). */
  uploadUrl: z.string(),
  /** Absolute URL for GET status. */
  statusUrl: z.string(),
  maxUploadBytes: z.number().int().positive(),
  status: OfflineStatus,
});
export type OfflineVisitCreateResponse = z.infer<typeof OfflineVisitCreateResponse>;

export const OfflineUploadResponse = z.object({ status: z.enum(["queued", "already_transcribed"]) });
export type OfflineUploadResponse = z.infer<typeof OfflineUploadResponse>;

export const OfflineVisitStatus = z.object({
  visitId: z.string(),
  status: OfflineStatus,
  sessionId: z.string().nullable(),
  segmentCount: z.number().int().nonnegative(),
  /** True once the server holds the transcript: the phone may delete its local file. */
  canDeleteLocalFile: z.boolean(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
});
export type OfflineVisitStatus = z.infer<typeof OfflineVisitStatus>;

/** SESSION_QUEUE message that asks for an offline transcription (ids only). */
export const OfflineTranscribeJob = z
  .object({
    kind: z.literal("transcribe_offline"),
    schemaVersion: z.literal("1"),
    visitId: z.string().min(1).max(128),
    providerId: z.string().min(1).max(128),
  })
  .strict();
export type OfflineTranscribeJob = z.infer<typeof OfflineTranscribeJob>;

/** Everything SESSION_QUEUE carries: a session processing hint, or an offline transcription. */
export const SessionQueueMessage = z.union([QueuePayload, OfflineTranscribeJob]);
export type SessionQueueMessage = z.infer<typeof SessionQueueMessage>;
