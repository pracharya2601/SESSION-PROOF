/**
 * Pure helpers for the Recordings pages: partition summary chips, the horizontal timeline
 * layout (calendar events as lanes, segments placed by time) and what transcript text may show.
 * No React here so it is unit-tested directly (model.test.ts).
 */
import type { Recording } from "../../../contracts";
import type { RecordingSegmentView, RecordingSuggestion, RecordingTimelineEvent } from "./types";

// ------------------------------------------------------------------ formatting
export function recordingDurationMs(r: Pick<Recording, "startedAt" | "endedAt">, now = Date.now()): number {
  const s = Date.parse(r.startedAt);
  const e = r.endedAt ? Date.parse(r.endedAt) : now;
  return Number.isFinite(s) && Number.isFinite(e) ? Math.max(0, e - s) : 0;
}

/** "1 h 05 min", "12 min", "45 s". */
export function formatSpan(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")} min`;
}

export function clockOf(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

export function dateOf(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const STATUS_LABEL: Record<Recording["status"], string> = {
  recording: "Recording",
  stopped: "Partitioning",
  partitioned: "Partitioned",
  failed: "Failed",
};

export function transcriberLabel(t: Recording["transcriber"]): string {
  return t === "deepgram" ? "Deepgram" : "Simulated";
}

// ------------------------------------------------------------------ summary chips
export type ChipTone = "success" | "neutral" | "warning" | "info" | "danger";
export interface SummaryChip {
  key: "sessions" | "unassigned" | "ambiguous" | "suggestions" | "status";
  label: string;
  tone: ChipTone;
}

/**
 * "2 sessions · 1 unassigned · 1 suggestion". Before partitioning only a status chip.
 * `pendingSuggestions` is null when unknown (not loaded): no suggestion chip then.
 */
export function partitionChips(r: Pick<Recording, "status" | "partition">, pendingSuggestions: number | null = null): SummaryChip[] {
  if (r.status === "recording") return [{ key: "status", label: "Recording now", tone: "info" }];
  if (r.status === "failed") return [{ key: "status", label: "Partition failed", tone: "danger" }];
  const p = r.partition;
  if (!p) return [{ key: "status", label: "Waiting for the calendar", tone: "neutral" }];
  const out: SummaryChip[] = [{ key: "sessions", label: plural(p.sessions.length, "session"), tone: p.sessions.length ? "success" : "neutral" }];
  if (p.unassignedSegments > 0) out.push({ key: "unassigned", label: `${p.unassignedSegments} unassigned`, tone: "warning" });
  if (p.ambiguousSegments > 0) out.push({ key: "ambiguous", label: `${p.ambiguousSegments} ambiguous`, tone: "warning" });
  if (pendingSuggestions && pendingSuggestions > 0) out.push({ key: "suggestions", label: plural(pendingSuggestions, "suggestion"), tone: "info" });
  return out;
}

export function chipsText(chips: SummaryChip[]): string {
  return chips.map((c) => c.label).join(" · ");
}

export function pendingSuggestions(list: RecordingSuggestion[] | undefined): RecordingSuggestion[] {
  return (list ?? []).filter((s) => s.status === "pending");
}

// ------------------------------------------------------------------ segment state
export type SegmentTone = "assigned" | "suggested" | "ambiguous" | "unassigned" | "pending";

/** Segment index → the pending suggestion that covers it. */
export function suggestionBySegment(list: RecordingSuggestion[] | undefined): Map<number, RecordingSuggestion> {
  const m = new Map<number, RecordingSuggestion>();
  for (const s of pendingSuggestions(list)) for (const i of s.segmentIndexes) if (!m.has(i)) m.set(i, s);
  return m;
}

export function segmentTone(seg: Pick<RecordingSegmentView, "index" | "assignment">, bySuggestion: Map<number, RecordingSuggestion>): SegmentTone {
  if (seg.assignment.status === "assigned") return "assigned";
  if (bySuggestion.has(seg.index)) return "suggested";
  if (seg.assignment.status === "ambiguous") return "ambiguous";
  if (seg.assignment.status === "pending") return "pending";
  return "unassigned";
}

export type SegmentText = { kind: "text"; text: string } | { kind: "deleted" } | { kind: "hidden" };

/**
 * Transcript text is shown only for assigned segments and segments still pending (not
 * partitioned yet, or under a pending suggestion). Deleted text says so.
 */
export function segmentText(seg: Pick<RecordingSegmentView, "text" | "textDeleted" | "assignment">, tone: SegmentTone): SegmentText {
  if (seg.textDeleted || seg.text === null) return seg.textDeleted ? { kind: "deleted" } : { kind: "hidden" };
  if (tone === "assigned" || tone === "suggested" || tone === "pending") return { kind: "text", text: seg.text };
  return { kind: "hidden" };
}

// ------------------------------------------------------------------ timeline layout
export interface TimelineLane {
  /** eventId, or "__none" for segments outside every event. */
  id: string;
  eventId: string | null;
  label: string;
  clientRef: string | null;
  sessionId: string | null;
  dismissed: boolean;
  /** The event window on the axis (percent); null for the "not assigned" lane. */
  window: { left: number; width: number; clippedStart: boolean; clippedEnd: boolean } | null;
  timeLabel: string | null;
  segments: TimelineSegment[];
}

export interface TimelineSegment {
  index: number;
  left: number;
  width: number;
  tone: SegmentTone;
  from: string;
  to: string;
  suggestionId: string | null;
}

export interface TimelineTick {
  left: number;
  label: string;
}

export interface TimelineLayout {
  startMs: number;
  endMs: number;
  lanes: TimelineLane[];
  ticks: TimelineTick[];
}

export const NONE_LANE = "__none";
/** Segments narrower than this (percent) are widened so they stay visible / clickable. */
export const MIN_SEGMENT_PCT = 0.6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function tickStepMs(spanMs: number): number {
  const min = 60_000;
  for (const step of [5 * min, 10 * min, 15 * min, 30 * min, 60 * min, 120 * min, 240 * min]) if (spanMs / step <= 8) return step;
  return 480 * min;
}

/**
 * Lays out the recording on one time axis: the range is the recording (and its segments) plus a
 * small margin; each calendar event overlapping that range is a lane (its window drawn and clipped
 * to the range); assigned segments sit in their event's lane; everything else (unassigned,
 * ambiguous, suggested, not yet partitioned) sits in a final "Not assigned" lane.
 */
export function layoutTimeline(input: {
  recording: Pick<Recording, "startedAt" | "endedAt">;
  segments: Pick<RecordingSegmentView, "index" | "observedFrom" | "observedTo" | "assignment">[];
  events: Pick<RecordingTimelineEvent, "eventId" | "clientRef" | "startAt" | "endAt" | "sessionId" | "dismissed">[];
  suggestions?: RecordingSuggestion[];
  timeZone?: string;
  now?: number;
}): TimelineLayout {
  const segs = input.segments.filter((s) => Number.isFinite(Date.parse(s.observedFrom)));
  const recStart = Date.parse(input.recording.startedAt);
  const recEnd = input.recording.endedAt ? Date.parse(input.recording.endedAt) : (input.now ?? Date.now());
  let lo = Math.min(recStart, ...segs.map((s) => Date.parse(s.observedFrom)));
  let hi = Math.max(recEnd, ...segs.map((s) => Date.parse(s.observedTo)));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) hi = lo + 60_000;
  const pad = Math.max(5 * 60_000, (hi - lo) * 0.05);
  lo -= pad;
  hi += pad;
  const span = hi - lo;
  const pct = (t: number) => ((t - lo) / span) * 100;

  const bySuggestion = suggestionBySegment(input.suggestions);
  const events = input.events
    .filter((e) => Date.parse(e.startAt) < hi && Date.parse(e.endAt) > lo)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.eventId.localeCompare(b.eventId));
  const lanes: TimelineLane[] = events.map((e) => {
    const s = Date.parse(e.startAt);
    const en = Date.parse(e.endAt);
    const left = clamp(pct(s), 0, 100);
    const right = clamp(pct(en), 0, 100);
    return {
      id: e.eventId,
      eventId: e.eventId,
      label: e.clientRef,
      clientRef: e.clientRef,
      sessionId: e.sessionId,
      dismissed: e.dismissed,
      window: { left, width: Math.max(0, right - left), clippedStart: s < lo, clippedEnd: en > hi },
      timeLabel: `${clockOf(e.startAt, input.timeZone)}–${clockOf(e.endAt, input.timeZone)}`,
      segments: [],
    };
  });
  const byEvent = new Map(lanes.map((l) => [l.eventId!, l]));
  const none: TimelineLane = { id: NONE_LANE, eventId: null, label: "Not assigned", clientRef: null, sessionId: null, dismissed: false, window: null, timeLabel: null, segments: [] };

  for (const s of segs) {
    const from = Date.parse(s.observedFrom);
    const to = Math.max(from, Date.parse(s.observedTo));
    const tone = segmentTone(s, bySuggestion);
    let left = clamp(pct(from), 0, 100);
    let width = Math.max(MIN_SEGMENT_PCT, pct(to) - pct(from));
    if (left + width > 100) left = Math.max(0, 100 - width);
    width = Math.min(width, 100 - left);
    const placed: TimelineSegment = { index: s.index, left, width, tone, from: s.observedFrom, to: s.observedTo, suggestionId: bySuggestion.get(s.index)?.id ?? null };
    const lane = s.assignment.status === "assigned" ? byEvent.get(s.assignment.eventId) : undefined;
    (lane ?? none).segments.push(placed);
  }
  for (const l of [...lanes, none]) l.segments.sort((a, b) => a.left - b.left || a.index - b.index);
  if (none.segments.length > 0) lanes.push(none);

  const step = tickStepMs(span);
  const ticks: TimelineTick[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push({ left: pct(t), label: clockOf(new Date(t).toISOString(), input.timeZone) });
  return { startMs: lo, endMs: hi, lanes, ticks };
}

// ------------------------------------------------------------------ suggestion targets
export interface PickOption {
  value: string;
  label: string;
  body: { eventId?: string; clientRef?: string };
}

/** "Pick another client": the calendar events on the timeline first, then other known clients. */
export function pickOptions(
  events: Pick<RecordingTimelineEvent, "eventId" | "clientRef" | "startAt" | "endAt">[],
  clientRefs: string[],
  exclude: { eventId?: string | null; clientRef?: string | null } = {},
  timeZone?: string,
): PickOption[] {
  const out: PickOption[] = [];
  for (const e of events) {
    if (e.eventId === exclude.eventId) continue;
    out.push({ value: `ev:${e.eventId}`, label: `${e.clientRef} · ${clockOf(e.startAt, timeZone)}–${clockOf(e.endAt, timeZone)}`, body: { eventId: e.eventId } });
  }
  const seen = new Set(events.map((e) => e.clientRef));
  for (const ref of [...new Set(clientRefs)].sort()) {
    if (seen.has(ref) || ref === exclude.clientRef) continue;
    out.push({ value: `cl:${ref}`, label: `${ref} · no calendar event`, body: { clientRef: ref } });
  }
  return out;
}

export function confidenceLabel(c: number): string {
  const p = Math.round(clamp(c, 0, 1) * 100);
  return `${p}%`;
}

export function confidenceTone(c: number): "success" | "warning" | "neutral" {
  return c >= 0.75 ? "success" : c >= 0.5 ? "warning" : "neutral";
}
