/**
 * Offline transcription job (SESSION_QUEUE kind "transcribe_offline"):
 *   R2 file → parse VXREC1 → one Ogg Opus stream (runs end to end) → Deepgram pre-recorded
 *   (or the simulated script in local dev) → band segments on the wall clock
 *   → DELETE the R2 object → un-cancel the appointment → enqueue processing → NEEDS_REVIEW.
 *
 * Resumable by state: once the row is "transcribed" (segments durable), a retry only re-does the
 * hand-off. Failures: transient ones retry through the queue (backoff); after `maxAttempts`, or
 * at once for permanent ones, the row is "failed" and the audio is deleted 24 h later by the sweep.
 * Logs carry ids, sizes, counts and codes only: never audio, transcript text or keys.
 */
import type { Appointment, BandSegment, Clock, OfflineTranscribeJob } from "../contracts";
import type { Env } from "../env";
import type { Repository } from "../db/repository";
import type { VisitStore } from "../band/store";
import { SIMULATED_SCRIPT } from "../band/transcriber";
import { log } from "../security";
import { muxOggOpus } from "./ogg";
import type { OfflineStore } from "./store";
import { buildTimeline, parseVxrec, VxrecError, type Timeline } from "./vxrec";

export const DEEPGRAM_PRERECORDED_URL =
  "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&utterances=true&mip_opt_out=true";

/** Queue deliveries per job before it is marked failed (wrangler max_retries 5 = 6 deliveries). */
export const OFFLINE_MAX_ATTEMPTS = 5;
/** Audio of a failed job is deleted this long after the failure (lets an operator look / the phone re-upload). */
export const FAILED_AUDIO_RETENTION_MS = 24 * 3600_000;
/** A job still "transcribing" this long after its last update is marked failed by the sweep. */
export const STUCK_AFTER_MS = 6 * 3600_000;
/** The evidence source reads at most 500 segments; above this, same-speaker neighbours are merged. */
export const MAX_OFFLINE_SEGMENTS = 480;
const DEEPGRAM_TIMEOUT_MS = 10 * 60_000;

/** Minimal R2 surface (the AUDIO_TMP binding, or an in-memory fake in tests). */
export interface AudioBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

export function audioKey(providerId: string, visitId: string): string {
  return `audio-tmp/${providerId}/${visitId}.bin`;
}

export interface OfflineJobDeps {
  store: OfflineStore;
  visits: VisitStore;
  repo: Pick<Repository, "getAppointment">;
  bucket: AudioBucket | undefined;
  env: Pick<Env, "DEEPGRAM_API_KEY" | "RUNTIME_MODE">;
  clock: Clock;
  fetch?: typeof fetch;
  /** jobs.enqueueAppointment (+ the "visit sent" notification), as the stop route uses. */
  enqueueAppointment: (appt: Appointment) => Promise<{ sessionId: string }>;
  maxAttempts?: number;
  /** Offline uploads that target a client-less recording (src/recordings). Absent → such jobs fail. */
  recordings?: OfflineRecordingTarget;
}

/** What the job needs from src/recordings for a row with target "recording". */
export interface OfflineRecordingTarget {
  /** The recording's transcriber, or null when it is not the provider's. */
  transcriberOf(providerId: string, recordingId: string): Promise<string | null>;
  /** Segments, stats and audio start of the recording (band_segments keyed by the recording id). */
  capture: Pick<VisitStore, "deleteSegments" | "saveSegments" | "setAudioStarted" | "updateStats">;
  /** Transcript stored → queue the partition job (idempotent; the partition is too). */
  enqueuePartition(providerId: string, recordingId: string): Promise<void>;
}

export type JobOutcome = { retry: false } | { retry: true; delaySeconds: number };

/** queueRetry: worth another queue delivery. retryable: worth the phone uploading the same file again later. */
export class OfflineFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly queueRetry: boolean,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OfflineFailure";
  }
}

export interface TranscriptPiece {
  startSec: number;
  endSec: number;
  text: string;
  speaker: string | null;
}

// ------------------------------------------------------------------ Deepgram pre-recorded
interface DgUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: number;
}

/** POST the Ogg file; returns its utterances (stream seconds). Errors carry the HTTP status only. */
export async function deepgramPrerecorded(apiKey: string, ogg: Uint8Array<ArrayBuffer>, fetchFn: typeof fetch = fetch): Promise<TranscriptPiece[]> {
  let res: Response;
  try {
    res = await fetchFn(DEEPGRAM_PRERECORDED_URL, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/ogg" },
      body: ogg,
      signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OfflineFailure("DEEPGRAM_UNAVAILABLE", `Deepgram could not be reached (${err instanceof Error ? err.name : "error"}).`, true, true);
  }
  if (!res.ok) {
    // Status only: never echo what the service wrote.
    await res.body?.cancel().catch(() => undefined);
    const s = res.status;
    if (s === 401 || s === 403) throw new OfflineFailure("DEEPGRAM_AUTH", `Deepgram refused the server key (status ${s}).`, false, true);
    if (s === 408 || s === 429 || s >= 500) throw new OfflineFailure("DEEPGRAM_UNAVAILABLE", `Deepgram is unavailable (status ${s}).`, true, true);
    throw new OfflineFailure("DEEPGRAM_REJECTED", `Deepgram rejected the audio (status ${s}).`, false, false);
  }
  let body: { results?: { utterances?: DgUtterance[] } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new OfflineFailure("DEEPGRAM_BAD_RESPONSE", "Deepgram returned an unreadable response.", true, true);
  }
  const out: TranscriptPiece[] = [];
  for (const u of body.results?.utterances ?? []) {
    const text = (u.transcript ?? "").trim();
    if (!text || typeof u.start !== "number") continue;
    out.push({
      startSec: u.start,
      endSec: typeof u.end === "number" ? u.end : u.start,
      text,
      speaker: typeof u.speaker === "number" ? `Speaker ${u.speaker}` : null,
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Merges same-speaker neighbours (gap ≤ 2 s, text ≤ 4000) until at most `max` pieces remain. */
export function capPieces(pieces: TranscriptPiece[], max = MAX_OFFLINE_SEGMENTS): TranscriptPiece[] {
  if (pieces.length <= max) return pieces;
  const out: TranscriptPiece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.speaker === p.speaker && p.startSec - last.endSec <= 2 && last.text.length + 1 + p.text.length <= 4000) {
      last.endSec = Math.max(last.endSec, p.endSec);
      last.text = `${last.text} ${p.text}`;
    } else out.push({ ...p });
  }
  return out;
}

/** Pieces (stream seconds) → band segments on the wall clock, numbered 1… */
export function toSegments(visitId: string, pieces: TranscriptPiece[], timeline: Timeline, sourceMode: "live" | "fixture"): BandSegment[] {
  return pieces.map((p, i) => {
    const from = timeline.toWallMs(p.startSec);
    const to = Math.max(from + 20, timeline.toWallMs(Math.max(p.startSec, p.endSec)));
    return {
      id: `${visitId}:${i + 1}`,
      visitId,
      index: i + 1,
      observedFrom: new Date(Math.round(from)).toISOString(),
      observedTo: new Date(Math.round(to)).toISOString(),
      speaker: p.speaker,
      text: p.text.slice(0, 4000),
      sourceMode,
    };
  });
}

function asFailure(err: unknown): OfflineFailure {
  if (err instanceof OfflineFailure) return err;
  if (err instanceof VxrecError) return new OfflineFailure(`FILE_${err.code}`, err.message, false, false);
  return new OfflineFailure("INTERNAL", `Unexpected error (${err instanceof Error ? err.name : "unknown"}).`, true, true);
}

async function transcribe(deps: OfflineJobDeps, visitId: string, transcriber: string, key: string, kind: "visit" | "recording" = "visit") {
  if (!deps.bucket) throw new OfflineFailure("OFFLINE_NOT_CONFIGURED", "Offline audio storage (AUDIO_TMP) is not configured.", false, true);
  const obj = await deps.bucket.get(key);
  if (!obj) throw new OfflineFailure("AUDIO_MISSING", "The uploaded file is no longer stored; upload it again.", false, true);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const parsed = parseVxrec(bytes, { kind });
  const timeline = buildTimeline(parsed.runs);
  if (timeline.packets.length === 0) throw new OfflineFailure("FILE_NO_AUDIO", "The recording holds no audio packets.", false, false);
  let pieces: TranscriptPiece[];
  let sourceMode: "live" | "fixture";
  if (transcriber === "deepgram") {
    const apiKey = deps.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new OfflineFailure("TRANSCRIPTION_NOT_CONFIGURED", "Transcription is not configured (DEEPGRAM_API_KEY).", false, true);
    pieces = await deepgramPrerecorded(apiKey, muxOggOpus(timeline.packets), deps.fetch ?? fetch);
    sourceMode = "live";
  } else if (transcriber === "simulated" && deps.env.RUNTIME_MODE !== "deployed") {
    // Local dev without a key: the synthetic demo script, placed from the start of the recording.
    pieces = SIMULATED_SCRIPT.map((l) => ({ startSec: l.atSec, endSec: l.atSec + l.durationSec, text: l.text, speaker: l.speaker }));
    sourceMode = "fixture";
  } else {
    throw new OfflineFailure("TRANSCRIPTION_NOT_CONFIGURED", "Transcription is not configured (DEEPGRAM_API_KEY).", false, true);
  }
  const segments = toSegments(visitId, capPieces(pieces), timeline, sourceMode);
  return { bytes: bytes.length, parsed, timeline, segments };
}

async function deleteAudio(deps: OfflineJobDeps, visitId: string, key: string | null): Promise<void> {
  if (!key) return;
  const now = deps.clock.now();
  try {
    if (!deps.bucket) throw new Error("no bucket");
    await deps.bucket.delete(key);
    await deps.store.clearAudio(visitId, now.toISOString());
  } catch (err) {
    log("warn", "offline.audio_delete_deferred", { visitId, errorName: err instanceof Error ? err.name : "unknown" });
    await deps.store.scheduleAudioDelete(visitId, now.toISOString());
  }
}

/** Transcript stored → appointment visible → processing queued (idempotent). */
async function handOff(deps: OfflineJobDeps, providerId: string, visitId: string): Promise<string> {
  const visit = await deps.visits.getVisit(providerId, visitId);
  if (!visit) throw new OfflineFailure("NOT_FOUND", "Visit not found.", false, false);
  if (visit.sessionId) return visit.sessionId;
  await deps.store.releaseAppointment(visit.appointmentId, deps.clock.now().toISOString());
  const appt = await deps.repo.getAppointment(visit.appointmentId);
  if (!appt) throw new Error("visit appointment missing");
  const { sessionId } = await deps.enqueueAppointment({ ...appt, canceled: false });
  await deps.visits.setSession(visit.id, sessionId);
  return sessionId;
}

function backoffSeconds(attempt: number): number {
  return Math.min(600, 30 * 2 ** Math.max(0, attempt - 1));
}

export async function runOfflineTranscription(deps: OfflineJobDeps, job: OfflineTranscribeJob, attempt: number): Promise<JobOutcome> {
  const max = deps.maxAttempts ?? OFFLINE_MAX_ATTEMPTS;
  const { visitId, providerId } = job;
  const row = await deps.store.get(providerId, visitId);
  if (!row) {
    log("warn", "offline.job_unknown_visit", { visitId });
    return { retry: false };
  }
  const isRecording = row.target === "recording";
  if (isRecording && !deps.recordings) {
    log("warn", "offline.recordings_not_wired", { visitId });
    return { retry: false };
  }
  const writer = isRecording ? deps.recordings!.capture : deps.visits;
  if (row.status === "transcribing") {
    const transcriber = isRecording
      ? await deps.recordings!.transcriberOf(providerId, visitId)
      : ((await deps.visits.getVisit(providerId, visitId))?.transcriber ?? null);
    if (!transcriber || !row.audioKey) {
      await deps.store.markFailed(visitId, {
        code: "AUDIO_MISSING",
        message: "The uploaded file is no longer stored; upload it again.",
        retryable: true,
        deleteAfter: null,
        now: deps.clock.now().toISOString(),
      });
      return { retry: false };
    }
    await deps.store.startAttempt(visitId, attempt, deps.clock.now().toISOString());
    const started = Date.now();
    try {
      const r = await transcribe(deps, visitId, transcriber, row.audioKey, row.target);
      const now = deps.clock.now().toISOString();
      await writer.deleteSegments(visitId);
      await writer.saveSegments(providerId, r.segments, now);
      await writer.setAudioStarted(visitId, new Date(r.timeline.firstMs).toISOString());
      await writer.updateStats(visitId, r.timeline.packets.length, r.timeline.lostPackets);
      await deps.store.markTranscribed(visitId, now);
      log("info", "offline.transcribed", {
        visitId,
        bytes: r.bytes,
        runs: r.parsed.runs.length,
        packets: r.timeline.packets.length,
        lostPackets: r.timeline.lostPackets,
        droppedPackets: r.timeline.droppedPackets,
        truncatedTail: r.parsed.truncatedTail,
        segments: r.segments.length,
        ms: Date.now() - started,
        attempt,
      });
    } catch (err) {
      const f = asFailure(err);
      if (f.queueRetry && attempt < max) {
        log("warn", "offline.transcribe_retry", { visitId, attempt, code: f.code });
        return { retry: true, delaySeconds: backoffSeconds(attempt) };
      }
      const now = deps.clock.now();
      await deps.store.markFailed(visitId, {
        code: f.code,
        message: f.message,
        retryable: f.retryable,
        deleteAfter: new Date(now.getTime() + FAILED_AUDIO_RETENTION_MS).toISOString(),
        now: now.toISOString(),
      });
      log("warn", "offline.transcribe_failed", { visitId, attempt, code: f.code });
      return { retry: false };
    }
    // Audio is never kept once the transcript exists.
    await deleteAudio(deps, visitId, row.audioKey);
  } else if (row.status !== "transcribed") {
    // awaiting_audio / failed: a stale message (a new upload sends a new one).
    return { retry: false };
  }
  try {
    if (isRecording) {
      await deps.recordings!.enqueuePartition(providerId, visitId);
      log("info", "offline.recording_handed_off", { visitId });
      return { retry: false };
    }
    const sessionId = await handOff(deps, providerId, visitId);
    log("info", "offline.handed_off", { visitId, sessionId });
    return { retry: false };
  } catch (err) {
    log("warn", "offline.handoff_retry", { visitId, attempt, errorName: err instanceof Error ? err.name : "unknown" });
    return attempt < max + 1 ? { retry: true, delaySeconds: backoffSeconds(attempt) } : { retry: false };
  }
}

/**
 * Cron sweep: delete audio whose retention ended (failed jobs after 24 h, deferred deletes,
 * abandoned uploads), and fail jobs stuck in "transcribing" (their audio then follows in 24 h).
 */
export async function sweepOfflineAudio(deps: Pick<OfflineJobDeps, "store" | "bucket" | "clock">): Promise<{ deleted: number; stuck: number }> {
  const now = deps.clock.now();
  let stuck = 0;
  for (const row of await deps.store.listStuck(new Date(now.getTime() - STUCK_AFTER_MS).toISOString(), 50)) {
    await deps.store.markFailed(row.visitId, {
      code: "TRANSCRIPTION_TIMEOUT",
      message: "Transcription did not finish; upload the file again.",
      retryable: true,
      deleteAfter: new Date(now.getTime() + FAILED_AUDIO_RETENTION_MS).toISOString(),
      now: now.toISOString(),
    });
    stuck++;
  }
  let deleted = 0;
  if (deps.bucket) {
    for (const row of await deps.store.listAudioDue(now.toISOString(), 100)) {
      try {
        await deps.bucket.delete(row.audioKey!);
        await deps.store.clearAudio(row.visitId, now.toISOString());
        deleted++;
      } catch (err) {
        log("warn", "offline.sweep_delete_failed", { visitId: row.visitId, errorName: err instanceof Error ? err.name : "unknown" });
      }
    }
  }
  if (deleted || stuck) log("info", "offline.sweep", { deleted, stuck });
  return { deleted, stuck };
}
