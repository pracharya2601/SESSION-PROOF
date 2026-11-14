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
  /** Filled by the partitioner. */
  partition: z
    .object({
      sessions: z.array(z.object({ eventId: Id, clientRef: Id, sessionId: Id, segmentCount: z.number().int() })),
      unassignedSegments: z.number().int().nonnegative(),
      ambiguousSegments: z.number().int().nonnegative(),
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
  /** Same WebSocket protocol as visits (docs/band-bridge.md), token scoped to this recording. */
  streamUrl: z.string(),
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
