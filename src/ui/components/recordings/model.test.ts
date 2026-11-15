import { describe, expect, it } from "vitest";
import {
  chipsText,
  formatSpan,
  layoutTimeline,
  MIN_SEGMENT_PCT,
  NONE_LANE,
  partitionChips,
  pickOptions,
  segmentText,
  segmentTone,
  suggestionBySegment,
} from "./model";
import type { RecordingSegmentView, RecordingSuggestion } from "./types";

const Z = (hm: string) => `2026-11-13T${hm}:00.000Z`;
const seg = (index: number, from: string, to: string, assignment: RecordingSegmentView["assignment"], text: string | null = "t", textDeleted = false): RecordingSegmentView => ({
  index,
  observedFrom: Z(from),
  observedTo: Z(to),
  speaker: null,
  text,
  textDeleted,
  assignment,
});
const sug = (o: Partial<RecordingSuggestion>): RecordingSuggestion => ({
  id: "sg1",
  segmentIndexes: [3],
  from: Z("19:10"),
  to: Z("19:12"),
  suggestedClientRef: "SD-334-A",
  eventId: null,
  confidence: 0.8,
  method: "keywords",
  rationale: "mentions the budget sheet",
  status: "pending",
  ...o,
});
const assigned = (eventId: string) => ({ status: "assigned" as const, eventId, appointmentId: `appt_cal_${eventId}`, clientRef: "C-104", sessionId: "sess_1" });

describe("partition chips", () => {
  const partition = {
    sessions: [
      { eventId: "a", clientRef: "C-104", sessionId: "s1", segmentCount: 2 },
      { eventId: "b", clientRef: "SD-334-A", sessionId: "s2", segmentCount: 1 },
    ],
    unassignedSegments: 1,
    ambiguousSegments: 0,
    partitionedAt: Z("20:00"),
  };
  it("summarises sessions, unassigned and pending suggestions", () => {
    expect(chipsText(partitionChips({ status: "partitioned", partition }, 1))).toBe("2 sessions · 1 unassigned · 1 suggestion");
    expect(chipsText(partitionChips({ status: "partitioned", partition: { ...partition, sessions: partition.sessions.slice(0, 1), unassignedSegments: 0, ambiguousSegments: 2 } }, 0))).toBe(
      "1 session · 2 ambiguous",
    );
    expect(partitionChips({ status: "partitioned", partition }, null).map((c) => c.key)).toEqual(["sessions", "unassigned"]);
  });
  it("status chips before / without a partition", () => {
    expect(chipsText(partitionChips({ status: "recording", partition: null }))).toBe("Recording now");
    expect(chipsText(partitionChips({ status: "stopped", partition: null }))).toBe("Waiting for the calendar");
    expect(partitionChips({ status: "failed", partition: null })[0]!.tone).toBe("danger");
  });
  it("formats spans", () => {
    expect(formatSpan(45_000)).toBe("45 s");
    expect(formatSpan(12 * 60_000)).toBe("12 min");
    expect(formatSpan(65 * 60_000)).toBe("1 h 05 min");
  });
});

describe("segment tone and text", () => {
  const by = suggestionBySegment([sug({}), sug({ id: "old", segmentIndexes: [4], status: "rejected" })]);
  it("tones", () => {
    expect(segmentTone(seg(1, "18:10", "18:11", assigned("a")), by)).toBe("assigned");
    expect(segmentTone(seg(3, "19:10", "19:11", { status: "unassigned" }), by)).toBe("suggested");
    expect(segmentTone(seg(4, "19:20", "19:21", { status: "unassigned" }), by)).toBe("unassigned"); // rejected suggestion
    expect(segmentTone(seg(5, "19:20", "19:21", { status: "ambiguous", candidateEventIds: ["a", "b"] }), by)).toBe("ambiguous");
    expect(segmentTone(seg(6, "19:20", "19:21", { status: "pending" }), by)).toBe("pending");
  });
  it("text only for assigned / pending; deleted says so", () => {
    expect(segmentText(seg(1, "18:10", "18:11", assigned("a"), "hello"), "assigned")).toEqual({ kind: "text", text: "hello" });
    expect(segmentText(seg(3, "19:10", "19:11", { status: "unassigned" }, "maybe"), "suggested")).toEqual({ kind: "text", text: "maybe" });
    expect(segmentText(seg(4, "19:20", "19:21", { status: "unassigned" }, "private"), "unassigned")).toEqual({ kind: "hidden" });
    expect(segmentText(seg(4, "19:20", "19:21", { status: "unassigned" }, null, true), "unassigned")).toEqual({ kind: "deleted" });
  });
});

describe("timeline layout", () => {
  const events = [
    { eventId: "b", clientRef: "SD-334-A", startAt: Z("19:00"), endAt: Z("20:00"), sessionId: "s2", dismissed: false },
    { eventId: "a", clientRef: "C-104", startAt: Z("18:00"), endAt: Z("19:00"), sessionId: "s1", dismissed: false },
    { eventId: "far", clientRef: "X-1", startAt: Z("23:00"), endAt: Z("23:30"), sessionId: null, dismissed: false },
  ];
  const segments = [
    seg(1, "18:10", "18:11", assigned("a")),
    seg(2, "19:30", "19:31", assigned("b")),
    seg(3, "19:05", "19:06", { status: "unassigned" }),
    seg(4, "19:58", "19:59", { status: "ambiguous", candidateEventIds: ["a", "b"] }),
  ];
  const L = layoutTimeline({ recording: { startedAt: Z("18:00"), endedAt: Z("20:00") }, segments, events, suggestions: [sug({})], timeZone: "UTC" });

  it("lanes: events in start order, out-of-range events dropped, a Not-assigned lane last", () => {
    expect(L.lanes.map((l) => l.id)).toEqual(["a", "b", NONE_LANE]);
    expect(L.lanes[0]!.segments.map((s) => s.index)).toEqual([1]);
    expect(L.lanes[1]!.segments.map((s) => s.index)).toEqual([2]);
    expect(L.lanes[2]!.segments.map((s) => [s.index, s.tone, s.suggestionId])).toEqual([
      [3, "suggested", "sg1"],
      [4, "ambiguous", null],
    ]);
    expect(L.lanes[0]!.timeLabel).toBe("6:00 PM–7:00 PM");
  });

  it("positions are proportional, within 0..100, with a padded range", () => {
    // 2 h span + 6 min padding each side (5% of 120 min).
    expect(L.endMs - L.startMs).toBe(132 * 60_000);
    const a = L.lanes[0]!.window!;
    const b = L.lanes[1]!.window!;
    expect(a.left).toBeCloseTo((6 / 132) * 100, 5);
    expect(a.width).toBeCloseTo((60 / 132) * 100, 5);
    expect(b.left).toBeCloseTo(a.left + a.width, 5); // back to back
    for (const lane of L.lanes) for (const s of lane.segments) {
      expect(s.left).toBeGreaterThanOrEqual(0);
      expect(s.left + s.width).toBeLessThanOrEqual(100 + 1e-9);
      expect(s.width).toBeGreaterThanOrEqual(Math.min(MIN_SEGMENT_PCT, 100 - s.left) - 1e-9);
    }
    expect(L.ticks.length).toBeGreaterThan(1);
    expect(L.ticks.every((t) => t.left >= 0 && t.left <= 100)).toBe(true);
  });

  it("clips an event that runs past the range; no Not-assigned lane when everything is assigned", () => {
    const L2 = layoutTimeline({
      recording: { startedAt: Z("18:30"), endedAt: Z("18:40") },
      segments: [seg(1, "18:32", "18:33", assigned("a"))],
      events: [events[1]!],
    });
    expect(L2.lanes.map((l) => l.id)).toEqual(["a"]);
    expect(L2.lanes[0]!.window).toMatchObject({ left: 0, width: 100, clippedStart: true, clippedEnd: true });
  });

  it("empty recording still has a range", () => {
    const L3 = layoutTimeline({ recording: { startedAt: Z("18:30"), endedAt: Z("18:30") }, segments: [], events: [] });
    expect(L3.endMs).toBeGreaterThan(L3.startMs);
    expect(L3.lanes).toEqual([]);
  });
});

describe("suggestion targets", () => {
  it("pick options: other events first, then clients without an event", () => {
    const evs = [
      { eventId: "a", clientRef: "C-104", startAt: Z("18:00"), endAt: Z("19:00") },
      { eventId: "b", clientRef: "SD-334-A", startAt: Z("19:00"), endAt: Z("20:00") },
    ];
    const opts = pickOptions(evs, ["SD-331-A", "C-104", "SD-331-A"], { eventId: "b" }, "UTC");
    expect(opts.map((o) => o.value)).toEqual(["ev:a", "cl:SD-331-A"]);
    expect(opts[0]!.body).toEqual({ eventId: "a" });
    expect(opts[1]!.body).toEqual({ clientRef: "SD-331-A" });
  });
});
