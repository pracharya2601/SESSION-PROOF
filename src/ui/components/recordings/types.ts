/**
 * Wire shapes for the Recordings pages (type-only). Server sources: src/recordings/contract.ts
 * (detail + segments), the content-suggestions endpoints in src/api/recordings.ts,
 * src/api/recording-timeline.ts (lanes) and src/api/archive.ts (archive / delete / audit).
 */
import type { Recording } from "../../../contracts";
import type { RecordingSegmentView, SegmentAssignment } from "../../../recordings/contract";

export type { RecordingSegmentView, SegmentAssignment };

export type SuggestionStatus = "pending" | "accepted" | "rejected" | (string & {});

/** A content-based suggestion for unassigned / ambiguous segments. */
export interface RecordingSuggestion {
  id: string;
  segmentIndexes: number[];
  from: string;
  to: string;
  suggestedClientRef: string | null;
  eventId: string | null;
  /** "event": extends that event's session; "unscheduled": accepting creates an unscheduled appointment. */
  kind?: "event" | "unscheduled" | (string & {});
  /** Clients that were scored (offered first in "Pick another client"). */
  candidateClientRefs?: string[];
  sessionId?: string | null;
  /** 0..1 */
  confidence: number;
  method: string;
  rationale: string;
  status: SuggestionStatus;
}

export interface RecordingDetailView {
  recording: Recording;
  segments: RecordingSegmentView[];
  /** Absent on servers without content suggestions. */
  suggestions?: RecordingSuggestion[];
}

export interface AcceptSuggestionRequest {
  clientRef?: string;
  eventId?: string;
}

export interface AcceptSuggestionResponse {
  suggestion: RecordingSuggestion;
  sessionId: string;
}

export interface RecordingTimelineEvent {
  eventId: string;
  appointmentId: string;
  clientRef: string;
  startAt: string;
  endAt: string;
  sessionId: string | null;
  sessionStatus: string | null;
  dismissed: boolean;
}

export type ArchiveKind = "session" | "recording" | "run";

export interface ArchivedItemView {
  kind: ArchiveKind;
  id: string;
  archivedAt: string;
  archivedBy: string;
  reason: string | null;
  recording?: Recording;
}

export interface AuditEntry {
  id: string;
  action: "archive" | "unarchive" | "delete";
  itemKind: ArchiveKind;
  itemId: string;
  actor: string;
  detail: Record<string, number | string | boolean | null>;
  at: string;
}
