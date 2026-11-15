/** Client-less recordings: store, partition job, evidence source (docs/recordings.md). */
export * from "./contract";
export {
  createRecordingStore,
  SUGGESTION_TEXT_RETENTION_MS,
  type RecordingStore,
  type RecordingRow,
  type AssignmentRow,
  type HandoffRow,
  type SuggestionRow,
  type ConversationRow,
  type AssignmentMethod,
} from "./store";
export { assignSegment, runPartition, reprocessSession, sweepRecordings, type PartitionDeps, type SweepDeps } from "./partition";
export { RecordingEvidenceSource, RecordingRoutingEvidenceSource, isCalendarAppointment, interiorGaps } from "./evidence";
export { calendarSync, type CalendarSyncParts } from "./calendar";
export { driveContextResolver, visitContextResolver, type RecordingVisitContext } from "./visit-context";
export * from "./content";
export * from "./content-conversation";
export { runContentPass, classifyEventBlock, scrubForAi, suggestionIdFor, candidateFactory, contentAiResolver, type ContentDeps, type ContentAi } from "./content-job";
export {
  acceptSuggestion,
  rejectSuggestion,
  decideConversation,
  sessionConversations,
  publicSuggestion,
  refreshPartitionSummary,
  unscheduledOccurrenceId,
  type AcceptDeps,
  type DecisionResult,
} from "./content-accept";
