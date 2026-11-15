/**
 * Partition job (SESSION_QUEUE kind "partition_recording"): one stopped recording → sessions.
 *
 *   1. sync the provider's calendar events covering [start − 2 h, end + 2 h] into appointments
 *   2. assign every segment by the FROZEN rule (src/contracts/schedule.ts): midpoint in
 *      [E.start − 10 min, E.end + 10 min); in two windows the nearest event start wins when it is
 *      nearer by ≥ 5 min, else "ambiguous" (attached to neither, flagged on the tied sessions)
 *   3. persist the assignments
 *   4. for every event with ≥ 1 assigned segment: ensure its session + enqueue processing
 *      (jobs.enqueueAppointment). A session that already exists (another recording of the same
 *      event) is re-processed when this recording adds segments, unless it is approved/completed.
 *   5. recording → partitioned with the summary (Recording.partition)
 *
 * Idempotent: re-running for the same recording re-computes the same assignments, and a
 * hand-off already recorded with the same segment count is not repeated. Unassigned segments are
 * never evidence; their text is deleted 24 h later (sweepRecordings). Logs: ids and counts only.
 */
import {
  PARTITION_BUFFER_MINUTES,
  PARTITION_TIE_MINUTES,
  type Appointment,
  type BandSegment,
  type Clock,
  type QueuePayload,
  type SessionStatus,
} from "../contracts";
import type { Repository } from "../db/repository";
import { log } from "../security";
import { CALENDAR_APPOINTMENT_PREFIX, type CalendarSync, type PartitionRecordingJob, type SyncedEvent } from "./contract";
import type { AssignmentRow, RecordingPartition, RecordingStore } from "./store";
import { classifySessionBlocks, runContentPass, type ContentDeps } from "./content-job";

/** Calendar look-around on each side of the recording. */
export const PARTITION_SYNC_MARGIN_MS = 2 * 3600_000;
export const PARTITION_MAX_ATTEMPTS = 5;
/** Unassigned segment text is deleted this long after partitioning. */
export const UNASSIGNED_TEXT_RETENTION_MS = 24 * 3600_000;
/** A recording still "recording" this long after its start is stopped by the sweep (phone gone). */
export const ABANDONED_RECORDING_MS = 12 * 3600_000;
/** A stopped recording not partitioned after this long gets its job re-sent by the sweep. */
export const STUCK_PARTITION_MS = 15 * 60_000;

/** Session states a new recording's segments may re-process (never approved / completed). */
export const REPROCESSABLE: SessionStatus[] = [
  "SCHEDULED",
  "WAITING_FOR_EVIDENCE",
  "PROCESSING",
  "NEEDS_REVIEW",
  "NO_EVIDENCE",
  "AMBIGUOUS_MATCH",
  "INCOMPLETE",
  "FAILED",
];

// ------------------------------------------------------------------ pure rule
export interface PartitionEvent {
  eventId: string;
  appointmentId: string;
  startMs: number;
  endMs: number;
}

export type SegmentDecision =
  | { status: "assigned"; event: PartitionEvent }
  | { status: "unassigned" }
  | { status: "ambiguous"; candidates: PartitionEvent[] };

/** The frozen partition rule for one segment. Pure. */
export function assignSegment(seg: Pick<BandSegment, "observedFrom" | "observedTo">, events: PartitionEvent[]): SegmentDecision {
  const from = Date.parse(seg.observedFrom);
  const to = Date.parse(seg.observedTo);
  const mid = from + (Math.max(to, from) - from) / 2;
  const buf = PARTITION_BUFFER_MINUTES * 60_000;
  const inWindow = events.filter((e) => mid >= e.startMs - buf && mid < e.endMs + buf);
  if (inWindow.length === 0) return { status: "unassigned" };
  if (inWindow.length === 1) return { status: "assigned", event: inWindow[0]! };
  const ranked = inWindow
    .map((e) => ({ e, d: Math.abs(mid - e.startMs) }))
    .sort((a, b) => a.d - b.d || a.e.startMs - b.e.startMs || a.e.eventId.localeCompare(b.e.eventId));
  const tie = PARTITION_TIE_MINUTES * 60_000;
  if (ranked[1]!.d - ranked[0]!.d >= tie) return { status: "assigned", event: ranked[0]!.e };
  return { status: "ambiguous", candidates: ranked.filter((r) => r.d - ranked[0]!.d < tie).map((r) => r.e) };
}

// ------------------------------------------------------------------ job
export interface PartitionDeps {
  store: RecordingStore;
  repo: Pick<Repository, "getSession" | "enqueueProcessing" | "completeDelivery">;
  /** SESSION_QUEUE (process-session hints for a re-processed session). */
  queue: { send(body: QueuePayload): Promise<unknown> };
  clock: Clock;
  /** Calendar → appointments. Absent → the job fails with CALENDAR_NOT_CONFIGURED (retried). */
  syncCalendar?: CalendarSync;
  /** jobs.enqueueAppointment (+ notification), as a stopped visit uses. */
  enqueueAppointment: (appt: Appointment) => Promise<{ sessionId: string; created?: boolean; enqueued?: boolean }>;
  maxAttempts?: number;
  /** Pass 2 (content suggestions + conversation types, content-job.ts). Absent → pass 1 only. */
  content?: ContentDeps;
}

export type PartitionOutcome = { retry: false } | { retry: true; delaySeconds: number };

class PartitionFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "PartitionFailure";
  }
}

function backoffSeconds(attempt: number): number {
  return Math.min(600, 30 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Re-process an existing session whose evidence grew (new recording for the same event):
 * a new processing revision + its durable delivery, then the queue hint (dispatch retries a
 * failed send). No-op (false) when approved / completed / already queued.
 */
export async function reprocessSession(deps: Pick<PartitionDeps, "repo" | "queue" | "clock">, sessionId: string): Promise<boolean> {
  const res = await deps.repo.enqueueProcessing(sessionId, REPROCESSABLE, deps.clock.now());
  if (!res.ok) return false;
  try {
    await deps.queue.send({ schemaVersion: "1", sessionId, processingRevision: res.value.processingRevision });
    await deps.repo.completeDelivery(res.value.deliveryKey, deps.clock.now());
  } catch (err) {
    log("warn", "recording.reprocess_send_deferred", { sessionId, errorName: err instanceof Error ? err.name : "unknown" });
  }
  return true;
}

function recordingSpan(start: string, end: string | null, segs: BandSegment[], now: Date): { fromMs: number; toMs: number } {
  let fromMs = Date.parse(start);
  let toMs = end ? Date.parse(end) : now.getTime();
  for (const s of segs) {
    fromMs = Math.min(fromMs, Date.parse(s.observedFrom));
    toMs = Math.max(toMs, Date.parse(s.observedTo));
  }
  return { fromMs, toMs };
}

export async function runPartition(deps: PartitionDeps, job: PartitionRecordingJob, attempt: number): Promise<PartitionOutcome> {
  const { recordingId, providerId } = job;
  const max = deps.maxAttempts ?? PARTITION_MAX_ATTEMPTS;
  const row = await deps.store.get(providerId, recordingId);
  if (!row) {
    log("warn", "recording.partition_unknown", { recordingId });
    return { retry: false };
  }
  const rec = row.recording;
  if (rec.status === "recording") return { retry: false }; // stale: stop sends a new job
  if (row.origin === "offline" && (await deps.store.offlineState(recordingId)) !== "transcribed") {
    return { retry: false }; // the offline job sends the job once the transcript is stored
  }
  await deps.store.startAttempt(recordingId, attempt, deps.clock.now().toISOString());
  try {
    const partition = await partitionOnce(deps, row.recording.id, providerId, rec.startedAt, rec.endedAt);
    log("info", "recording.partitioned", {
      recordingId,
      sessions: partition.sessions.length,
      unassigned: partition.unassignedSegments,
      ambiguous: partition.ambiguousSegments,
      attempt,
    });
    return { retry: false };
  } catch (err) {
    const f = err instanceof PartitionFailure ? err : new PartitionFailure("INTERNAL", true);
    if (f.retryable && attempt < max) {
      log("warn", "recording.partition_retry", { recordingId, attempt, code: f.code, errorName: err instanceof Error ? err.name : "unknown" });
      return { retry: true, delaySeconds: backoffSeconds(attempt) };
    }
    await deps.store.markFailed(recordingId, f.code, deps.clock.now().toISOString());
    log("warn", "recording.partition_failed", { recordingId, attempt, code: f.code });
    return { retry: false };
  }
}

async function partitionOnce(
  deps: PartitionDeps,
  recordingId: string,
  providerId: string,
  startedAt: string,
  endedAt: string | null,
): Promise<RecordingPartition> {
  if (!deps.syncCalendar) throw new PartitionFailure("CALENDAR_NOT_CONFIGURED", true);
  const now = deps.clock.now();
  const segments = await deps.store.capture.listSegments(recordingId);
  const span = recordingSpan(startedAt, endedAt, segments, now);

  let synced: SyncedEvent[];
  try {
    synced = await deps.syncCalendar(providerId, new Date(span.fromMs - PARTITION_SYNC_MARGIN_MS), new Date(span.toMs + PARTITION_SYNC_MARGIN_MS));
  } catch (err) {
    log("warn", "recording.calendar_sync_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" });
    throw new PartitionFailure("CALENDAR_UNAVAILABLE", true);
  }
  // Only this provider's live CALENDAR appointments (appt_cal_; a cancelled event never receives segments).
  const live = synced.filter(
    (s) =>
      s.appointment.id.startsWith(CALENDAR_APPOINTMENT_PREFIX) &&
      s.event.status !== "cancelled" &&
      !s.appointment.canceled &&
      s.appointment.providerId === providerId &&
      s.event.providerId === providerId,
  );
  const byEvent = new Map(live.map((s) => [s.event.eventId, s]));
  const events: PartitionEvent[] = live.map((s) => ({
    eventId: s.event.eventId,
    appointmentId: s.appointment.id,
    startMs: Date.parse(s.appointment.startAt),
    endMs: Date.parse(s.appointment.endAt),
  }));

  // Assign (segments whose text was already swept keep their stored row).
  const partitionedAt = now.toISOString();
  const rows: AssignmentRow[] = segments.map((seg) => {
    const d = assignSegment(seg, events);
    return {
      recordingId,
      index: seg.index,
      providerId,
      status: d.status,
      eventId: d.status === "assigned" ? d.event.eventId : null,
      appointmentId: d.status === "assigned" ? d.event.appointmentId : null,
      candidateEventIds: d.status === "ambiguous" ? d.candidates.map((c) => c.eventId) : [],
      candidateAppointmentIds: d.status === "ambiguous" ? d.candidates.map((c) => c.appointmentId) : [],
      observedFrom: seg.observedFrom,
      observedTo: seg.observedTo,
      partitionedAt,
      textDeletedAt: null,
    };
  });
  await deps.store.saveAssignments(rows);
  const all = await deps.store.listAssignments(recordingId);

  // Hand off every event with ≥ 1 assigned segment.
  const counts = new Map<string, number>();
  for (const a of all) if (a.status === "assigned" && a.eventId) counts.set(a.eventId, (counts.get(a.eventId) ?? 0) + 1);
  // Conversation type of every session block, stored before the hand-off so the draft reads it.
  let sessionsDone: { classified: number; aiCalls: number } | undefined;
  if (deps.content) {
    const blocks = [...counts.keys()]
      .map((eventId) => byEvent.get(eventId))
      .filter((x): x is SyncedEvent => !!x)
      .map((x) => ({ eventId: x.event.eventId, appointmentId: x.appointment.id, clientRef: x.appointment.clientRef, eventTitle: x.event.title ?? null }));
    sessionsDone = await classifySessionBlocks(deps.content, recordingId, providerId, blocks).catch((err: unknown) => {
      log("warn", "recording.session_conversations_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" });
      return undefined;
    });
  }
  const previous = new Map((await deps.store.listHandoffs(recordingId)).map((h) => [h.eventId, h]));
  const sessions: RecordingPartition["sessions"] = [];
  for (const [eventId, count] of [...counts].sort((a, b) => (byEvent.get(a[0])?.event.startAt ?? "").localeCompare(byEvent.get(b[0])?.event.startAt ?? ""))) {
    const synced = byEvent.get(eventId);
    const prev = previous.get(eventId);
    if (!synced) {
      // The event left the calendar since an earlier partition; keep what was handed off.
      if (prev) sessions.push({ eventId, clientRef: prev.clientRef, sessionId: prev.sessionId, segmentCount: count });
      continue;
    }
    const appt = synced.appointment;
    let sessionId = prev?.sessionId ?? null;
    if (!prev || prev.segmentCount !== count || prev.appointmentId !== appt.id) {
      const r = await deps.enqueueAppointment(appt);
      sessionId = r.sessionId;
      // An existing session (e.g. another recording of this event) re-processes with the new segments.
      if (!r.created && !r.enqueued) await reprocessSession(deps, r.sessionId);
      await deps.store.saveHandoff({
        recordingId,
        eventId,
        providerId,
        appointmentId: appt.id,
        clientRef: appt.clientRef,
        sessionId: r.sessionId,
        segmentCount: count,
        handedOffAt: deps.clock.now().toISOString(),
      });
    }
    sessions.push({ eventId, clientRef: appt.clientRef, sessionId: sessionId!, segmentCount: count });
  }

  const partition: RecordingPartition = {
    sessions,
    unassignedSegments: all.filter((a) => a.status === "unassigned").length,
    unassignedMs: all
      .filter((a) => a.status === "unassigned")
      .reduce((n, a) => n + Math.max(0, Date.parse(a.observedTo) - Date.parse(a.observedFrom)), 0),
    ambiguousSegments: all.filter((a) => a.status === "ambiguous").length,
    partitionedAt,
  };
  await deps.store.markPartitioned(recordingId, partition, deps.clock.now().toISOString());
  // Pass 2: content suggestions for what the time rule left over (never assigns; never fails the partition).
  if (deps.content) {
    await runContentPass(deps.content, recordingId, providerId, { sessions: sessionsDone }).catch((err: unknown) =>
      log("warn", "recording.content_pass_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" }),
    );
  }
  return partition;
}

// ------------------------------------------------------------------ sweep (cron)
export interface SweepDeps {
  store: RecordingStore;
  clock: Clock;
  /** Sends a partition job (SESSION_QUEUE). */
  enqueuePartition: (job: PartitionRecordingJob) => Promise<unknown>;
}

/**
 * Cron: delete unassigned segment text 24 h after partitioning (counts stay), stop recordings
 * abandoned for 12 h and partition them, and re-send jobs for stopped recordings left unpartitioned.
 */
export async function sweepRecordings(deps: SweepDeps): Promise<{ textDeleted: number; stopped: number; resent: number }> {
  const now = deps.clock.now();
  const nowIso = now.toISOString();
  let textDeleted = 0;
  for (const a of await deps.store.listUnassignedTextDue(new Date(now.getTime() - UNASSIGNED_TEXT_RETENTION_MS).toISOString(), 200)) {
    await deps.store.deleteSegmentText(a.recordingId, a.index, nowIso);
    textDeleted++;
  }
  let stopped = 0;
  for (const r of await deps.store.listByStatus("recording", new Date(now.getTime() - ABANDONED_RECORDING_MS).toISOString(), 25)) {
    if (Date.parse(r.recording.startedAt) > now.getTime() - ABANDONED_RECORDING_MS) continue;
    const segs = await deps.store.capture.listSegments(r.recording.id);
    const end = segs.reduce((m, s) => Math.max(m, Date.parse(s.observedTo)), Date.parse(r.recording.startedAt));
    await deps.store.stop(r.recording.providerId, r.recording.id, new Date(end).toISOString());
    await deps.enqueuePartition({ kind: "partition_recording", recordingId: r.recording.id, providerId: r.recording.providerId }).catch(() => undefined);
    stopped++;
  }
  let resent = 0;
  for (const r of await deps.store.listByStatus("stopped", new Date(now.getTime() - STUCK_PARTITION_MS).toISOString(), 25)) {
    if (r.origin === "offline" && (await deps.store.offlineState(r.recording.id)) !== "transcribed") continue;
    await deps.enqueuePartition({ kind: "partition_recording", recordingId: r.recording.id, providerId: r.recording.providerId }).catch(() => undefined);
    resent++;
  }
  if (textDeleted || stopped || resent) log("info", "recording.sweep", { textDeleted, stopped, resent });
  return { textDeleted, stopped, resent };
}
