/**
 * Recording-side types that are NOT in the frozen schedule contract (src/contracts/schedule.ts):
 * the queue job, the calendar-sync port, and the web / offline response shapes.
 */
import { z } from "zod";
import type { Appointment, CalendarEvent, Recording, SessionConversation, Suggestion } from "../contracts";

/** Recording ids. Their segments are band_segments rows with visit_id = this id. */
export const RECORDING_ID_PREFIX = "rec_";
/** Appointments synced from the calendar (src/schedule syncCalendarToAppointments) carry this prefix. */
export const CALENDAR_APPOINTMENT_PREFIX = "appt_cal_";

/** SESSION_QUEUE message: partition one stopped recording into sessions (ids only). */
export const PartitionRecordingJob = z
  .object({
    kind: z.literal("partition_recording"),
    recordingId: z.string().min(1).max(128),
    providerId: z.string().min(1).max(128),
  })
  .strict();
export type PartitionRecordingJob = z.infer<typeof PartitionRecordingJob>;

/** One calendar event and the appointment it was synced to. */
export interface SyncedEvent {
  event: CalendarEvent;
  appointment: Appointment;
}

/**
 * Syncs the provider's calendar events overlapping [from, to) into appointments and returns
 * them (src/schedule `syncCalendarToAppointments`, adapted in the composition root).
 */
export type CalendarSync = (providerId: string, from: Date, to: Date) => Promise<SyncedEvent[]>;

export type SegmentAssignment =
  | { status: "pending" }
  | {
      status: "assigned";
      eventId: string;
      appointmentId: string;
      clientRef: string | null;
      sessionId: string | null;
      /** Additive: "calendar_time" (pass 1) or "provider_confirmed_content" (accepted content suggestion). */
      method?: "calendar_time" | "provider_confirmed_content";
    }
  | { status: "unassigned" }
  | { status: "ambiguous"; candidateEventIds: string[] };

/** GET /api/recordings/:id: one segment with where the partitioner put it. */
export interface RecordingSegmentView {
  index: number;
  observedFrom: string;
  observedTo: string;
  speaker: string | null;
  /** null once deleted (unassigned segments, 24 h after partitioning). */
  text: string | null;
  textDeleted: boolean;
  assignment: SegmentAssignment;
}

export interface RecordingDetail {
  recording: Recording;
  segments: RecordingSegmentView[];
  /** Additive: pass 2 content suggestions (pending / accepted / rejected), by time. */
  suggestions: Suggestion[];
  /** Additive: conversation type per session block (one per event this recording handed off). */
  sessionConversations: SessionConversation[];
}

// ------------------------------------------------------------------ offline recordings
export const OfflineRecordingCreateRequest = z
  .object({
    localId: z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/, "localId: 8-64 chars of A-Z a-z 0-9 . _ : -"),
    bandNumber: z.number().int().min(1).max(999).nullable(),
    recordedFrom: z.string().datetime({ offset: true }),
    recordedTo: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).max(64).optional(),
    consentConfirmedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type OfflineRecordingCreateRequest = z.infer<typeof OfflineRecordingCreateRequest>;

/**
 * awaiting_audio: PUT the file. transcribing: queued / running. partitioning: transcript stored,
 * the partition job is queued. partitioned: sessions created (see partition). failed: see error.
 */
export type OfflineRecordingState = "awaiting_audio" | "transcribing" | "partitioning" | "partitioned" | "failed";

export interface OfflineRecordingStatus {
  recordingId: string;
  status: OfflineRecordingState;
  segmentCount: number;
  canDeleteLocalFile: boolean;
  partition: Recording["partition"];
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface OfflineRecordingCreateResponse {
  recording: Recording;
  uploadUrl: string;
  statusUrl: string;
  maxUploadBytes: number;
  status: OfflineRecordingState;
}
