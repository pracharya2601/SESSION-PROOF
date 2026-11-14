/**
 * Band capture contracts: a provider records a visit with a Vexo Open band
 * (Bluetooth wristband microphone). The browser streams the band's Opus
 * packets over a WebSocket to the Worker, which relays them to a transcriber
 * (Deepgram live, or a simulated one in local dev) and stores FINAL transcript
 * segments. Those segments become the evidence for the visit's appointment.
 *
 * Wire protocol, WS /api/visits/:visitId/stream
 *   auth: same-origin cookie (browser) OR ?token=<streamToken> (native bridge, e.g. GlassCam on iPhone).
 *  client -> server
 *    text   {"type":"start","audioStartMs":<epoch ms of packet seq 0>}   first; AGAIN after every band
 *           reconnect (seq restarts at 0): the server starts a new run and moves the timeline by the gap
 *    binary [u16 big-endian band seq][one Opus packet]                   50 per second
 *    text   {"type":"keepalive"}                                         when paused
 *    text   {"type":"stop"}                                              flush and finish
 *  server -> client: VisitServerMessage (JSON text). "error" is informational unless the server
 *    then closes the socket. Audio sent during a reconnect gap does not exist, so it is not counted as lost.
 */
import { z } from "zod";

const Id = z.string().min(1).max(128);
const Instant = z.string().datetime({ offset: true });

export const BandTransport = z.enum(["ble", "serial", "sim"]);
export type BandTransport = z.infer<typeof BandTransport>;

/** "deepgram" = real speech to text; "simulated" = synthetic script (dev only, labelled fixture). */
export const Transcriber = z.enum(["deepgram", "simulated"]);
export type Transcriber = z.infer<typeof Transcriber>;

export const VisitStatus = z.enum(["recording", "stopped"]);
export type VisitStatus = z.infer<typeof VisitStatus>;

export const StartVisitRequest = z
  .object({
    clientRef: z.string().trim().min(1).max(64),
    /** Band number on the bag (1..999); null for the pretend band or "any band on the cable". */
    bandNumber: z.number().int().min(1).max(999).nullable(),
    transport: BandTransport,
    /** IANA zone for the documents; defaults to the client's last appointment zone. */
    timezone: z.string().min(1).max(64).optional(),
    /** Dev only (simulated transcriber): synthetic scenario id from fixtures/band. Rejected when deployed or live. */
    scenario: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  })
  .strict();
export type StartVisitRequest = z.infer<typeof StartVisitRequest>;

export const Visit = z.object({
  id: Id,
  providerId: Id,
  appointmentId: Id,
  clientRef: Id,
  bandNumber: z.number().int().nullable(),
  transport: BandTransport,
  transcriber: Transcriber,
  status: VisitStatus,
  startedAt: Instant,
  endedAt: Instant.nullable(),
  /** Epoch ms of the first audio packet (from the band clock), once streaming started. */
  audioStartedAt: Instant.nullable(),
  packets: z.number().int().nonnegative(),
  lostPackets: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  /** Set once the visit is stopped and handed to processing. */
  sessionId: Id.nullable(),
  /** Dev only: synthetic scenario the simulated transcriber plays; null = default script. */
  scenario: z.string().nullable().default(null),
});
export type Visit = z.infer<typeof Visit>;

export const BandSegment = z.object({
  id: Id,
  visitId: Id,
  /** 1-based order within the visit; evidence ids are ev_001, ev_002, ... */
  index: z.number().int().positive(),
  observedFrom: Instant,
  observedTo: Instant,
  /** Exactly as the transcriber labelled it ("Speaker 0"), or null. Never invented. */
  speaker: z.string().max(64).nullable(),
  text: z.string().min(1).max(4000),
  sourceMode: z.enum(["live", "fixture"]),
});
export type BandSegment = z.infer<typeof BandSegment>;

/** Returned by POST /api/visits: the visit plus what a bridge needs to stream to it. */
export const StartVisitResponse = z.object({
  visit: Visit,
  /** Absolute wss:// (or ws:// locally) URL including ?token=. Treat as a secret; expires with the token. */
  streamUrl: z.string(),
  streamTokenExpiresAt: Instant,
});
export type StartVisitResponse = z.infer<typeof StartVisitResponse>;

export const StopVisitResponse = z.object({ visit: Visit, sessionId: Id });
export type StopVisitResponse = z.infer<typeof StopVisitResponse>;

export const VisitDetail = z.object({ visit: Visit, segments: z.array(BandSegment) });
export type VisitDetail = z.infer<typeof VisitDetail>;

export const CaptureStatus = z.object({
  /** Which transcriber a new visit would use right now. null = capture unavailable. */
  transcriber: Transcriber.nullable(),
  reason: z.string().nullable(),
});
export type CaptureStatus = z.infer<typeof CaptureStatus>;

export type VisitServerMessage =
  | { type: "ready"; transcriber: Transcriber }
  | { type: "interim"; text: string }
  | { type: "final"; segment: BandSegment }
  | { type: "stats"; packets: number; lostPackets: number }
  | { type: "error"; code: string; message: string }
  | { type: "done"; segmentCount: number };

export const VisitClientControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), audioStartMs: z.number().int().positive() }),
  z.object({ type: z.literal("keepalive") }),
  z.object({ type: z.literal("stop") }),
]);
export type VisitClientControl = z.infer<typeof VisitClientControl>;

/** Appointments created by a band visit carry this id prefix. */
export const VISIT_APPOINTMENT_PREFIX = "appt_visit_";
