/**
 * The PUT-audio step of an offline upload, independent of what the file belongs to (a band
 * visit or a client-less recording): validate the VXREC1 file against the offline row, store it
 * in R2 (AUDIO_TMP) and queue the "transcribe_offline" job. Used by
 * PUT /api/device/offline-recordings/:id/audio (src/api/recordings.ts). Logs: ids and sizes only.
 */
import { MAX_OFFLINE_UPLOAD_BYTES, OFFLINE_CLOCK_SKEW_MS, type OfflineTranscribeJob } from "../contracts";
import { log } from "../security";
import { audioKey, FAILED_AUDIO_RETENTION_MS, type AudioBucket } from "./job";
import type { OfflineRow, OfflineStore } from "./store";
import { parseVxrec, VxrecError, type RecordingVxrecHeader } from "./vxrec";

export type UploadResult =
  | { kind: "ok"; status: 200 | 202; body: { status: "queued" | "already_transcribed" } }
  | { kind: "error"; status: 400 | 413 | 415 | 503; code: string; message: string; retryable: boolean };

const err = (status: 400 | 413 | 415 | 503, code: string, message: string, retryable = false): UploadResult => ({ kind: "error", status, code, message, retryable });

export async function acceptOfflineUpload(o: {
  row: OfflineRow;
  store: OfflineStore;
  bucket: AudioBucket;
  contentType: string | undefined;
  declaredLength: number;
  readBody: () => Promise<ArrayBuffer>;
  /** Extra header check (e.g. clientRef of a visit); returns an error message or null. */
  checkHeader?: (h: RecordingVxrecHeader) => string | null;
  send: (job: OfflineTranscribeJob) => Promise<unknown>;
  now: () => Date;
}): Promise<UploadResult> {
  const { row } = o;
  const type = (o.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/octet-stream") return err(415, "UNSUPPORTED_MEDIA_TYPE", "Send the VXREC1 file as Content-Type: application/octet-stream.");
  const tooLarge = () => err(413, "PAYLOAD_TOO_LARGE", `The file is larger than ${MAX_OFFLINE_UPLOAD_BYTES} bytes.`);
  if (o.declaredLength > MAX_OFFLINE_UPLOAD_BYTES) return tooLarge();
  if (row.status === "transcribed") return { kind: "ok", status: 200, body: { status: "already_transcribed" } };
  if (row.status === "transcribing") return { kind: "ok", status: 202, body: { status: "queued" } };

  const bytes = new Uint8Array(await o.readBody());
  if (bytes.length > MAX_OFFLINE_UPLOAD_BYTES) return tooLarge();
  if (bytes.length === 0) return err(400, "FILE_EMPTY", "The request body is empty.");
  let packets: number;
  try {
    const parsed = parseVxrec(bytes, { kind: row.target });
    packets = parsed.packetCount;
    const extra = o.checkHeader?.(parsed.header) ?? null;
    if (parsed.header.localId !== row.localId || extra) {
      return err(400, "FILE_MISMATCH", extra ?? "This file belongs to another recording (localId differs).");
    }
    const lo = Date.parse(row.recordedFrom) - OFFLINE_CLOCK_SKEW_MS;
    const hi = Date.parse(row.recordedTo) + OFFLINE_CLOCK_SKEW_MS;
    if (parsed.runs.some((r) => r.audioStartMs < lo || r.audioStartMs > hi)) {
      return err(400, "FILE_MISMATCH", "An audio run starts outside recordedFrom..recordedTo.");
    }
  } catch (e) {
    if (e instanceof VxrecError) return err(400, `FILE_${e.code}`, e.message);
    throw e;
  }

  const key = audioKey(row.providerId, row.visitId);
  try {
    await o.bucket.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  } catch (e) {
    log("warn", "offline.store_failed", { visitId: row.visitId, bytes: bytes.length, errorName: e instanceof Error ? e.name : "unknown" });
    return err(503, "STORAGE_UNAVAILABLE", "Could not store the file; try again.", true);
  }
  const now = o.now();
  if (!(await o.store.markUploaded(row.visitId, { key, bytes: bytes.length, now: now.toISOString() }))) {
    return { kind: "ok", status: 202, body: { status: "queued" } }; // a concurrent upload queued it
  }
  const job: OfflineTranscribeJob = { kind: "transcribe_offline", schemaVersion: "1", visitId: row.visitId, providerId: row.providerId };
  try {
    await o.send(job);
  } catch (e) {
    await o.store.revertUpload(row.visitId, now.toISOString(), new Date(now.getTime() + FAILED_AUDIO_RETENTION_MS).toISOString());
    log("warn", "offline.enqueue_failed", { visitId: row.visitId, errorName: e instanceof Error ? e.name : "unknown" });
    return err(503, "QUEUE_UNAVAILABLE", "Could not queue the transcription; upload again.", true);
  }
  log("info", "offline.uploaded", { visitId: row.visitId, bytes: bytes.length, packets, target: row.target });
  return { kind: "ok", status: 202, body: { status: "queued" } };
}
