/**
 * FROZEN contract: calendar + drive + recordings + partitioning.
 *
 * The phone only RECORDS (no client, no history). The server learns who/what from the
 * provider's CALENDAR (appointments) and DRIVE (per-client documents), and PARTITIONS a
 * recording's transcript into sessions by time window. Demo data mimics Google Calendar /
 * Google Drive until the real connectors are wired (src/connections already has OAuth).
 *
 *   Band ─▶ GlassCam ─▶ POST /api/device/recordings → stream (same WS protocol as visits)
 *        ─▶ POST /api/device/recordings/:id/stop → partition job (queue)
 *        ─▶ for each calendar event overlapping the recording: session (evidence = segments
 *           in that event's window) ─▶ workflow (drive context → draft note, checklist, invoice)
 *        ─▶ NEEDS_REVIEW (+ review link)
 *   Segments outside every event → "unassigned": never evidence, deleted after 24 h.
 */
import { z } from "zod";

const Id = z.string().min(1).max(128);
const Instant = z.string().datetime({ offset: true });

// ------------------------------------------------------------------ calendar
export const CalendarEvent = z.object({
  /** Stable per occurrence (Google: eventId + originalStartTime). Becomes Appointment.occurrenceId. */
  eventId: Id,
  providerId: Id,
  clientRef: Id,
  title: z.string().max(200),
  startAt: Instant,
  endAt: Instant,
  timezone: z.string().min(1).max(64),
  /** Service code key used for the plan/rules/rate (e.g. "CA-SDP-320"). */
  serviceCode: Id,
  location: z.string().max(200).nullable(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  source: z.enum(["demo", "google"]),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export interface CalendarSource {
  readonly kind: "demo" | "google";
  /** Events overlapping [from, to) for one provider, sorted by start. */
  listEvents(providerId: string, from: Date, to: Date): Promise<CalendarEvent[]>;
}

// ------------------------------------------------------------------ drive
export const DriveDocument = z.object({
  id: Id,
  name: z.string().max(200),
  kind: z.enum(["service_plan", "authorization", "previous_note", "assessment", "other"]),
  modifiedAt: Instant,
  /** Plain text the drafter may use as CONTEXT (never as evidence of what happened today). */
  text: z.string().max(20_000),
});
export type DriveDocument = z.infer<typeof DriveDocument>;

export const DriveClientContext = z.object({
  clientRef: Id,
  folder: z.string().max(300),
  /** Parsed from the service plan doc: goals the session is measured against. */
  goals: z.array(z.object({ goalId: Id, objective: z.string().max(500) })).max(20),
  serviceCode: Id,
  /** From the authorization doc. */
  authorization: z
    .object({
      number: z.string().max(64),
      fundingSource: z.string().max(120),
      hourlyRateCents: z.number().int().nonnegative(),
      authorizedMinutesPerMonth: z.number().int().nonnegative().nullable(),
      validFrom: z.string().max(10),
      validTo: z.string().max(10),
    })
    .nullable(),
  documents: z.array(DriveDocument).max(50),
});
export type DriveClientContext = z.infer<typeof DriveClientContext>;

export interface DriveSource {
  readonly kind: "demo" | "google";
  getClientContext(providerId: string, clientRef: string): Promise<DriveClientContext | null>;
}

// ------------------------------------------------------------------ recordings
export const Recording = z.object({
  id: Id,
  providerId: Id,
  bandNumber: z.number().int().nullable(),
  transcriber: z.enum(["deepgram", "simulated"]),
  status: z.enum(["recording", "stopped", "partitioned", "failed"]),
  startedAt: Instant,
  endedAt: Instant.nullable(),
  packets: z.number().int().nonnegative(),
  lostPackets: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  /** Additive: when the provider confirmed recording consent on the phone (offline uploads send it; null if not recorded). */
  consentConfirmedAt: Instant.nullable().optional(),
  /** Filled by the partitioner. */
  partition: z
    .object({
      sessions: z.array(z.object({ eventId: Id, clientRef: Id, sessionId: Id, segmentCount: z.number().int() })),
      unassignedSegments: z.number().int().nonnegative(),
      ambiguousSegments: z.number().int().nonnegative(),
      /** Additive: total duration (ms) of unassigned segments ("1 min unassigned" on the phone). */
      unassignedMs: z.number().int().nonnegative().optional(),
      partitionedAt: Instant,
    })
    .nullable(),
});
export type Recording = z.infer<typeof Recording>;

/** POST /api/device/recordings (device key). No client: the calendar decides. */
export const StartRecordingRequest = z
  .object({
    bandNumber: z.number().int().min(1).max(999).nullable(),
    transport: z.enum(["ble", "serial", "sim"]),
    timezone: z.string().min(1).max(64).optional(),
    /** Dev only, simulated transcriber: synthetic day script id (fixtures/schedule). */
    scenario: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  })
  .strict();
export type StartRecordingRequest = z.infer<typeof StartRecordingRequest>;

export const StartRecordingResponse = z.object({
  recording: Recording,
  /** Same WebSocket protocol and auth as visits (docs/band-bridge.md); the URL carries no token. */
  streamUrl: z.string(),
  /** Token scoped to this recording (secret): `vfa-token.<token>` subprotocol or first `auth` message. */
  streamToken: z.string(),
  streamTokenExpiresAt: Instant,
  /** What the calendar says right now, for the phone's status line ("Now: 11:00 C-201 Community"). */
  currentEvent: CalendarEvent.nullable(),
});
export type StartRecordingResponse = z.infer<typeof StartRecordingResponse>;

/** POST /api/device/recordings/:id/stop → 202 { recording } (partition job queued). */
/** GET  /api/device/recordings/:id → { recording } */
/** GET  /api/device/schedule?date=YYYY-MM-DD → { events: CalendarEvent[] } (phone shows today's plan). */

/** Partition rule (exact): a segment belongs to event E when its midpoint lies in
 *  [E.startAt − 10 min, E.endAt + 10 min). In two windows → nearest event start wins if
 *  unambiguous by ≥ 5 min, else "ambiguous" (attached to neither, flagged on both sessions). */
export const PARTITION_BUFFER_MINUTES = 10;
export const PARTITION_TIE_MINUTES = 5;

// ------------------------------------------------------------------ content suggestions (pass 2, additive)
/**
 * Pass 2 of the partition (docs/recordings.md "Content suggestions"): segments the time rule left
 * unassigned / ambiguous are grouped into blocks and matched by CONTENT against candidate
 * clients' Drive goals. A suggestion is only a proposal: nothing is assigned until the provider
 * accepts it (POST /api/recordings/:id/suggestions/:sid/accept). `rationale` never carries
 * transcript text or names (plan keywords, segment indexes and scores only).
 */
export const SuggestionStatus = z.enum(["pending", "accepted", "rejected"]);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

export const ConversationType = z.enum(["client_session", "colleague_meeting", "guardian_or_family", "phone_call", "personal", "unclear"]);
export type ConversationType = z.infer<typeof ConversationType>;

/** What kind of conversation a block looks like. signals: counts / booleans only (no text, names, refs). */
export const ConversationAssessment = z.object({
  conversationType: ConversationType,
  confidence: z.number().min(0).max(1),
  method: z.enum(["rules", "ai+rules"]),
  signals: z.object({
    speakers: z.number().int().nonnegative(),
    participantVoice: z.boolean(),
    planTermHits: z.number().int().nonnegative(),
    workTermHits: z.number().int().nonnegative(),
    otherClientRefs: z.number().int().nonnegative(),
    familyTermHits: z.number().int().nonnegative(),
    phoneCues: z.number().int().nonnegative(),
    personalTermHits: z.number().int().nonnegative(),
    /** Lines that talk ABOUT the participant (third person / possessive, not addressing them). */
    participantMentions: z.number().int().nonnegative().optional(),
    /** Family-relation cues ("Sam's mom", "your son", "as the guardian"). */
    relationCues: z.number().int().nonnegative().optional(),
    eventTitleHint: z.enum(["meeting", "call", "family"]).nullable(),
  }),
  /** true when conversationType ≠ client_session/unclear with confidence ≥ 0.6 and the provider has not decided. */
  needsConfirmation: z.boolean(),
  /** The provider's decision: confirmed as a client session, or dismissed. */
  providerDecision: z.enum(["client_session", "dismissed"]).nullable(),
});
export type ConversationAssessment = z.infer<typeof ConversationAssessment>;

/** GET /api/recordings/:id → sessionConversations[]: one per (recording, event) session block. */
export const SessionConversation = ConversationAssessment.extend({
  eventId: Id,
  appointmentId: Id.nullable(),
  sessionId: Id.nullable(),
  segmentCount: z.number().int().nonnegative(),
});
export type SessionConversation = z.infer<typeof SessionConversation>;

/** POST /api/recordings/:id/sessions/:eventId/conversation → 200 { conversation: SessionConversation }. */
export const ConversationDecisionRequest = z.object({ decision: z.enum(["client_session", "dismissed"]) }).strict();
export type ConversationDecisionRequest = z.infer<typeof ConversationDecisionRequest>;

export const Suggestion = z.object({
  id: Id,
  recordingId: Id,
  /** Segment indexes (RecordingSegmentView.index) of the block, ascending. */
  segmentIndexes: z.array(z.number().int().nonnegative()).min(1).max(500),
  from: Instant,
  to: Instant,
  /** null = "none": no candidate client matched the content. */
  suggestedClientRef: Id.nullable(),
  /** The suggested client's calendar event overlapping / near (≤ 60 min) the block, else null. */
  eventId: Id.nullable(),
  /** "event": extends that event's session. "unscheduled": accepting creates an unscheduled appointment (also used for "none"). */
  kind: z.enum(["event", "unscheduled"]),
  confidence: z.number().min(0).max(1),
  method: z.enum(["rules", "ai+rules"]),
  /** ≤ 200 chars, no transcript text, no names. */
  rationale: z.string().max(200),
  /** Clients that were scored (for the provider's override picker). */
  candidateClientRefs: z.array(Id).max(20),
  status: SuggestionStatus,
  createdAt: Instant,
  decidedAt: Instant.nullable(),
  /** Set once accepted. */
  acceptedClientRef: Id.nullable(),
  appointmentId: Id.nullable(),
  sessionId: Id.nullable(),
  /** Conversation type of the block (null when not classified). */
  conversation: ConversationAssessment.nullable().optional(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** POST /api/recordings/:id/suggestions/:sid/accept body: override the client and/or the event. */
export const AcceptSuggestionRequest = z
  .object({
    clientRef: Id.optional(),
    eventId: Id.optional(),
  })
  .strict();
export type AcceptSuggestionRequest = z.infer<typeof AcceptSuggestionRequest>;
/** → 200 { suggestion: Suggestion, sessionId: string }. POST …/reject → 200 { suggestion }. */
