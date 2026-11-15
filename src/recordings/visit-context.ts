/**
 * Drafting resolvers for calendar appointments (appt_cal_*): the client's Drive context and what
 * the calendar event + recordings know about the visit (EVV location, worker, consent, recording
 * span). Any other appointment → null (behaviour unchanged). Never throws for a missing event.
 */
import type { Appointment, CalendarSource, ConversationType, DriveClientContext, DriveSource } from "../contracts";
import type { VisitContext } from "../drafting/context";
import { isCalendarAppointment } from "./evidence";
import type { RecordingStore } from "./store";
import { CONVERSATION_LABELS, classifyConversation, needsConfirmation } from "./content-conversation";
import { candidateFactory } from "./content-job";

/**
 * VisitContext plus the conversation type of the session's transcript (additive; the drafting
 * checklist reads `conversationNeedsConfirmation` for its BLOCKING item
 * "This may not be a client session (looks like: <conversationLabel>) — confirm or dismiss").
 */
export type RecordingVisitContext = VisitContext & {
  conversationType?: ConversationType | null;
  conversationConfidence?: number | null;
  /** Human label of conversationType, e.g. "colleague meeting". */
  conversationLabel?: string | null;
  /** true: type ≠ client_session/unclear with confidence ≥ 0.6 and the provider has not decided. */
  conversationNeedsConfirmation?: boolean;
  /** The provider's decision (POST /api/recordings/:id/sessions/:eventId/conversation), else null. */
  conversationDecision?: "client_session" | "dismissed" | null;
};

export function driveContextResolver(drive: DriveSource) {
  return async (appt: Appointment): Promise<DriveClientContext | null> =>
    isCalendarAppointment(appt) ? drive.getClientContext(appt.providerId, appt.clientRef) : null;
}

export function visitContextResolver(o: { store: RecordingStore; calendar?: CalendarSource; drive?: DriveSource }) {
  return async (appt: Appointment): Promise<RecordingVisitContext | null> => {
    if (!isCalendarAppointment(appt)) return null;
    const segs = await o.store.listAssignedSegments(appt.providerId, appt.id);
    const recs = await o.store.listByIds(appt.providerId, segs.map((s) => s.recordingId));
    let location: string | null = null;
    let title: string | null = null;
    if (o.calendar) {
      const from = new Date(Date.parse(appt.startAt) - 60_000);
      const to = new Date(Date.parse(appt.endAt) + 60_000);
      const events = await o.calendar.listEvents(appt.providerId, from, to).catch(() => []);
      const ev = events.find((e) => e.eventId === appt.occurrenceId);
      location = ev?.location ?? null;
      title = ev?.title ?? null;
    }
    // Conversation type: the stored classification of the largest block (pass 2 job), else rules on the fly.
    const convs = await o.store.listConversationsForAppointment(appt.providerId, appt.id).catch(() => []);
    const decision = convs.filter((c) => c.providerDecision).sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0]?.providerDecision ?? null;
    let conv: { conversationType: ConversationType; confidence: number } | null = convs[0] ?? null;
    if (!conv && segs.length) {
      const client = o.drive ? await candidateFactory({ store: o.store, clock: { now: () => new Date() }, drive: o.drive }, appt.providerId).candidateFor(appt.clientRef, []).catch(() => null) : null;
      conv = classifyConversation({
        lines: segs.map((s) => ({ index: s.segment.index, speaker: s.segment.speaker, text: s.segment.text })),
        client,
        eventTitle: title,
      });
    }
    const type = decision === "client_session" ? "client_session" : (conv?.conversationType ?? null);
    const consentAt = recs
      .map((r) => r.recording.consentConfirmedAt ?? null)
      .filter((x): x is string => !!x)
      .sort()[0];
    const span = segs.length
      ? {
          from: segs.map((s) => s.segment.observedFrom).sort()[0]!,
          to: segs.map((s) => s.segment.observedTo).sort().at(-1)!,
        }
      : null;
    return {
      location,
      workerId: appt.providerId,
      consent: consentAt ? { recordedAt: consentAt, method: "phone_app_confirmation", confirmedBy: appt.providerId } : null,
      recordingSpan: span,
      conversationType: type,
      conversationConfidence: conv?.confidence ?? null,
      conversationLabel: type ? CONVERSATION_LABELS[type] : null,
      conversationNeedsConfirmation: !decision && needsConfirmation(conv),
      conversationDecision: decision,
      // minutesUsedThisMonth: not computed yet (optional).
    };
  };
}
