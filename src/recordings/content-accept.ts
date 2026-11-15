/**
 * The provider's decisions on pass 2 (docs/recordings.md "Content suggestions"):
 *   accept  → assign the block's segments (method provider_confirmed_content) to the chosen
 *             client's calendar event, or to a new "unscheduled" appointment
 *             appt_cal_unsched_<…> covering the block (service config from Drive), then the same
 *             hand-off as the partition (enqueue / re-process the session).
 *   reject  → status rejected (text then follows the normal 24 h sweep).
 * And on conversation types: confirm a session as a client session, or dismiss it.
 * Ownership: everything is scoped to the actor's providerId (another provider's → 404).
 */
import { sessionIdFor, type Appointment, type CalendarEvent, type QueuePayload, type SessionConversation, type Suggestion } from "../contracts";
import type { Repository } from "../db/repository";
import { appointmentIdForEvent, clientInputFromDrive, serviceConfigFromDrive } from "../schedule";
import { slugRef } from "../schedule/demo-calendar";
import { log } from "../security";
import { CONTENT_RULES } from "./content";
import { needsConfirmation } from "./content-conversation";
import { classifyEventBlock, type ContentDeps } from "./content-job";
import type { CalendarSync } from "./contract";
import { reprocessSession } from "./partition";
import type { AssignmentRow, ConversationRow, RecordingPartition, RecordingRow, RecordingStore, SuggestionRow } from "./store";

export interface AcceptDeps extends ContentDeps {
  repo: Pick<Repository, "getAppointment" | "upsertAppointment" | "upsertServiceConfig" | "getClient" | "upsertClient" | "getSession" | "enqueueProcessing" | "completeDelivery">;
  queue: { send(body: QueuePayload): Promise<unknown> };
  /** Calendar → appointments (the partition's sync). */
  syncCalendar?: CalendarSync;
  /** jobs.enqueueAppointment (the partition hand-off). */
  enqueueAppointment: (appt: Appointment) => Promise<{ sessionId: string; created?: boolean; enqueued?: boolean }>;
}

export type DecisionResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 503; code: string; message: string };

const fail = <T>(status: 400 | 404 | 409 | 503, code: string, message: string): DecisionResult<T> => ({ ok: false, status, code, message });

export function publicSuggestion(s: SuggestionRow, conv?: ConversationRow | null): Suggestion {
  const { providerId: _p, ...rest } = s;
  return { ...rest, conversation: conv ? conversationView(conv) : null };
}

export function conversationView(c: ConversationRow) {
  const decided = c.providerDecision;
  return {
    conversationType: decided === "client_session" ? ("client_session" as const) : c.conversationType,
    confidence: c.confidence,
    method: c.method,
    signals: c.signals,
    needsConfirmation: !decided && needsConfirmation(c),
    providerDecision: decided,
  };
}

/** Rebuilds Recording.partition from the stored assignments + hand-offs (after an accept). */
export async function refreshPartitionSummary(store: RecordingStore, row: RecordingRow, now: string): Promise<RecordingPartition> {
  const id = row.recording.id;
  const [all, handoffs] = await Promise.all([store.listAssignments(id), store.listHandoffs(id)]);
  const counts = new Map<string, { n: number; first: string }>();
  for (const a of all) {
    if (a.status !== "assigned" || !a.eventId) continue;
    const c = counts.get(a.eventId);
    counts.set(a.eventId, { n: (c?.n ?? 0) + 1, first: c && c.first < a.observedFrom ? c.first : a.observedFrom });
  }
  const sessions = handoffs
    .filter((h) => counts.has(h.eventId))
    .sort((a, b) => counts.get(a.eventId)!.first.localeCompare(counts.get(b.eventId)!.first))
    .map((h) => ({ eventId: h.eventId, clientRef: h.clientRef, sessionId: h.sessionId, segmentCount: counts.get(h.eventId)!.n }));
  const unassigned = all.filter((a) => a.status === "unassigned");
  const partition: RecordingPartition = {
    sessions,
    unassignedSegments: unassigned.length,
    unassignedMs: unassigned.reduce((n, a) => n + Math.max(0, Date.parse(a.observedTo) - Date.parse(a.observedFrom)), 0),
    ambiguousSegments: all.filter((a) => a.status === "ambiguous").length,
    partitionedAt: row.recording.partition?.partitionedAt ?? now,
  };
  await store.markPartitioned(id, partition, now);
  return partition;
}

/** "unsched_<12 hex of the recording>_<first idx>_<client slug>" (→ appt_cal_unsched_…). */
export async function unscheduledOccurrenceId(recordingId: string, firstIndex: number, clientRef: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recordingId));
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  return `unsched_${hex}_${firstIndex}_${slugRef(clientRef)}`.slice(0, 100);
}

const LOCKED = new Set(["APPROVED", "COMPLETED"]);

export async function acceptSuggestion(
  deps: AcceptDeps,
  providerId: string,
  recordingId: string,
  suggestionId: string,
  body: { clientRef?: string; eventId?: string },
): Promise<DecisionResult<{ suggestion: Suggestion; sessionId: string }>> {
  const store = deps.store;
  const row = await store.get(providerId, recordingId);
  if (!row) return fail(404, "NOT_FOUND", "Recording not found");
  const sug = await store.getSuggestion(providerId, recordingId, suggestionId);
  if (!sug) return fail(404, "NOT_FOUND", "Suggestion not found");
  if (sug.status !== "pending") return fail(409, "SUGGESTION_DECIDED", `This suggestion was already ${sug.status}.`);

  const fromMs = Date.parse(sug.from);
  const toMs = Date.parse(sug.to);
  const W = CONTENT_RULES.CANDIDATE_WINDOW_MS;
  // Events (synced to appointments) around the block.
  let synced: { event: CalendarEvent; appointment: Appointment }[] = [];
  const wantEvent = body.eventId ?? (!body.clientRef || body.clientRef === sug.suggestedClientRef ? sug.eventId : null);
  if (deps.syncCalendar && (wantEvent || body.clientRef)) {
    try {
      synced = await deps.syncCalendar(providerId, new Date(fromMs - W), new Date(toMs + W));
    } catch {
      return fail(503, "CALENDAR_UNAVAILABLE", "The calendar could not be read; try again.");
    }
  }
  synced = synced.filter((s) => s.event.providerId === providerId && s.appointment.providerId === providerId);

  let clientRef = body.clientRef ?? (body.eventId ? null : sug.suggestedClientRef);
  let target: { event: CalendarEvent; appointment: Appointment } | null = null;
  if (body.eventId) {
    target = synced.find((s) => s.event.eventId === body.eventId) ?? null;
    if (!target) return fail(400, "UNKNOWN_EVENT", "That calendar event is not within 4 h of this block.");
    if (target.event.status === "cancelled" || target.appointment.canceled) return fail(409, "EVENT_CANCELLED", "That calendar event is cancelled.");
    if (clientRef && clientRef !== target.event.clientRef) return fail(400, "EVENT_CLIENT_MISMATCH", "That event belongs to another client.");
    clientRef = target.event.clientRef;
  }
  if (!clientRef) return fail(400, "CLIENT_REQUIRED", "Choose a client for this block (the suggestion found none).");
  if (!target) {
    const live = synced.filter((s) => s.event.clientRef === clientRef && s.event.status !== "cancelled" && !s.appointment.canceled);
    target = (wantEvent ? live.find((s) => s.event.eventId === wantEvent) : null) ?? null;
    if (!target) {
      // The chosen client's event overlapping / within 60 min of the block, else unscheduled.
      const gap = (s: (typeof live)[number]) => Math.max(0, Date.parse(s.event.startAt) - toMs, fromMs - Date.parse(s.event.endAt));
      target = live.filter((s) => gap(s) <= CONTENT_RULES.NEAR_EVENT_MS).sort((a, b) => gap(a) - gap(b))[0] ?? null;
    }
  }
  const ctx = deps.drive ? await deps.drive.getClientContext(providerId, clientRef).catch(() => null) : null;
  if (!ctx) return fail(400, "UNKNOWN_CLIENT", "No Drive context for that client.");

  // The block must still be leftover, with its text.
  const [assignments, segments] = await Promise.all([store.listAssignments(recordingId), store.capture.listSegments(recordingId)]);
  const byIdx = new Map(assignments.map((a) => [a.index, a]));
  const withText = new Set(segments.filter((s) => s.text).map((s) => s.index));
  for (const i of sug.segmentIndexes) {
    const a = byIdx.get(i);
    if (!a || (a.status !== "unassigned" && a.status !== "ambiguous") || !withText.has(i)) {
      return fail(409, "SUGGESTION_STALE", "Some lines of this block were already assigned or deleted.");
    }
  }

  let appt: Appointment;
  if (target) appt = target.appointment;
  else {
    const cfg = serviceConfigFromDrive(ctx);
    if (!cfg) return fail(409, "NO_SERVICE_CONFIG", "The client's Drive folder has no usable authorization.");
    const occ = await unscheduledOccurrenceId(recordingId, sug.segmentIndexes[0]!, clientRef);
    appt = {
      id: appointmentIdForEvent(occ),
      occurrenceId: occ,
      providerId,
      clientRef,
      startAt: sug.from,
      endAt: toMs > fromMs ? sug.to : new Date(fromMs + 60_000).toISOString(),
      timezone: row.timezone ?? synced[0]?.event.timezone ?? "UTC",
      serviceCode: ctx.serviceCode,
      planVersion: cfg.plan.planVersion,
      ruleVersion: cfg.rules.ruleVersion,
      rateVersion: cfg.rate.rateVersion,
      canceled: false,
    };
  }
  const existing = await deps.repo.getSession(await sessionIdFor(providerId, appt.occurrenceId));
  if (existing && LOCKED.has(existing.status)) return fail(409, "SESSION_LOCKED", "That session is already approved; amend it instead.");

  const nowIso = deps.clock.now().toISOString();
  if (!(await store.decideSuggestion(sug.id, "accepted", nowIso, clientRef))) return fail(409, "SUGGESTION_DECIDED", "This suggestion was decided meanwhile.");
  const eventId = target ? target.event.eventId : appt.occurrenceId;
  try {
    if (!target) {
      const cfg = serviceConfigFromDrive(ctx)!;
      await deps.repo.upsertServiceConfig(cfg.plan.serviceCode, cfg);
      if (!(await deps.repo.getClient(providerId, clientRef))) {
        await deps.repo.upsertClient(providerId, clientInputFromDrive(ctx, { synthetic: deps.drive?.kind === "demo" }), deps.clock.now());
      }
      await deps.repo.upsertAppointment(appt);
    }
    const rows: AssignmentRow[] = sug.segmentIndexes.map((i) => {
      const a = byIdx.get(i)!;
      return { ...a, status: "assigned", eventId, appointmentId: appt.id, candidateEventIds: [], candidateAppointmentIds: [], method: "provider_confirmed_content" };
    });
    await store.saveContentAssignments(rows);
  } catch (err) {
    await store.reopenSuggestion(sug.id);
    throw err;
  }

  // Hand-off (as the partition): ensure + enqueue, or re-process an existing session.
  const r = await deps.enqueueAppointment(appt);
  if (!r.created && !r.enqueued) await reprocessSession(deps, r.sessionId);
  const count = (await store.listAssignments(recordingId)).filter((a) => a.status === "assigned" && a.eventId === eventId).length;
  await store.saveHandoff({ recordingId, eventId, providerId, appointmentId: appt.id, clientRef, sessionId: r.sessionId, segmentCount: count, handedOffAt: deps.clock.now().toISOString() });
  await store.setSuggestionTarget(sug.id, appt.id, r.sessionId);
  await refreshPartitionSummary(store, row, deps.clock.now().toISOString());
  try {
    await classifyEventBlock(deps, { row, eventId, appointmentId: appt.id, clientRef, eventTitle: target?.event.title ?? null, ai: null });
  } catch (err) {
    log("warn", "recording.conversation_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" });
  }
  log("info", "recording.suggestion_accepted", { recordingId, suggestionId: sug.id, segments: sug.segmentIndexes.length, unscheduled: !target, overridden: clientRef !== sug.suggestedClientRef });
  const updated = (await store.getSuggestion(providerId, recordingId, sug.id))!;
  const conv = (await store.listConversations(recordingId)).find((c) => c.scopeKey === `suggestion:${sug.id}`) ?? null;
  return { ok: true, value: { suggestion: publicSuggestion(updated, conv), sessionId: r.sessionId } };
}

export async function rejectSuggestion(store: RecordingStore, providerId: string, recordingId: string, suggestionId: string, now: string): Promise<DecisionResult<{ suggestion: Suggestion }>> {
  const row = await store.get(providerId, recordingId);
  if (!row) return fail(404, "NOT_FOUND", "Recording not found");
  const sug = await store.getSuggestion(providerId, recordingId, suggestionId);
  if (!sug) return fail(404, "NOT_FOUND", "Suggestion not found");
  if (!(await store.decideSuggestion(sug.id, "rejected", now, null))) return fail(409, "SUGGESTION_DECIDED", `This suggestion was already ${sug.status}.`);
  log("info", "recording.suggestion_rejected", { recordingId, suggestionId: sug.id });
  const conv = (await store.listConversations(recordingId)).find((c) => c.scopeKey === `suggestion:${sug.id}`) ?? null;
  return { ok: true, value: { suggestion: publicSuggestion((await store.getSuggestion(providerId, recordingId, sug.id))!, conv) } };
}

/** Session conversations of one recording (GET detail). */
export async function sessionConversations(store: RecordingStore, recordingId: string): Promise<SessionConversation[]> {
  const [convs, handoffs] = await Promise.all([store.listConversations(recordingId), store.listHandoffs(recordingId)]);
  const byEvent = new Map(handoffs.map((h) => [h.eventId, h]));
  return convs
    .filter((c) => c.scopeKey.startsWith("event:"))
    .map((c) => {
      const eventId = c.scopeKey.slice("event:".length);
      return { ...conversationView(c), eventId, appointmentId: c.appointmentId, sessionId: byEvent.get(eventId)?.sessionId ?? null, segmentCount: c.segmentCount };
    });
}

/**
 * POST /api/recordings/:id/sessions/:eventId/conversation { decision }: the provider confirms the
 * session as a client session (the flag clears on re-processing) or dismisses it. The decision
 * applies to the appointment (all its recordings). Never deletes anything.
 */
export async function decideConversation(
  deps: Pick<AcceptDeps, "store" | "repo" | "queue" | "clock">,
  providerId: string,
  recordingId: string,
  eventId: string,
  decision: "client_session" | "dismissed",
): Promise<DecisionResult<{ conversation: SessionConversation }>> {
  const row = await deps.store.get(providerId, recordingId);
  if (!row) return fail(404, "NOT_FOUND", "Recording not found");
  const conv = (await deps.store.listConversations(recordingId)).find((c) => c.scopeKey === `event:${eventId}`);
  if (!conv || !conv.appointmentId) return fail(404, "NOT_FOUND", "No session block for that event in this recording.");
  await deps.store.decideConversation(providerId, conv.appointmentId, decision, deps.clock.now().toISOString());
  const h = (await deps.store.listHandoffs(recordingId)).find((x) => x.eventId === eventId);
  // Re-draft so the checklist reflects the decision (approved / completed sessions stay locked).
  if (h) await reprocessSession(deps, h.sessionId);
  log("info", "recording.conversation_decided", { recordingId, decision });
  const out = (await sessionConversations(deps.store, recordingId)).find((c) => c.eventId === eventId)!;
  return { ok: true, value: { conversation: out } };
}

