/**
 * SYNTHETIC day scripts (fixtures/schedule/day-scripts.ts): shape, the frozen partition rule
 * applied to each script's own calendar (what `expect` promises), the dev calendar overlay
 * (src/schedule/day-script-overlay.ts) and playback through the simulated transcriber.
 */
import { describe, expect, it } from "vitest";
import { StartRecordingRequest, type CalendarEvent, type CalendarSource } from "../../src/contracts";
import { assignSegment, type PartitionEvent } from "../../src/recordings/partition";
import { DayScriptCalendarSource, type DayScriptRecording } from "../../src/schedule/day-script-overlay";
import { openSimulated, PACKET_SECONDS, type FinalPiece } from "../../src/band/transcriber";
import { CASELOAD } from "./caseload";
import { BAIT_PHRASE, DAY_SCRIPTS, NEGATED_PLAN_PHRASE, dayScriptEventId, dayScriptEvents, dayScriptOverlay, dayScriptSeconds, getDayScript } from "./day-scripts";

const ANCHOR = Date.parse("2026-11-16T17:00:00.000Z"); // a Monday 09:00 PT, but scripts never depend on it
const REC = "rec_0123456789abcdef0123456789abcdef";

function partition(id: string) {
  const s = getDayScript(id)!;
  const events: PartitionEvent[] = dayScriptEvents(s, ANCHOR, REC).map((e) => ({
    eventId: e.eventId,
    appointmentId: `appt_cal_${e.eventId}`,
    startMs: Date.parse(e.startAt),
    endMs: Date.parse(e.endAt),
  }));
  const per = new Map<string, number>();
  let unassigned = 0;
  let ambiguous = 0;
  for (const l of s.script) {
    const d = assignSegment(
      { observedFrom: new Date(ANCHOR + l.atSec * 1000).toISOString(), observedTo: new Date(ANCHOR + (l.atSec + l.durationSec) * 1000).toISOString() },
      events,
    );
    if (d.status === "assigned") per.set(d.event.eventId, (per.get(d.event.eventId) ?? 0) + 1);
    else if (d.status === "ambiguous") ambiguous++;
    else unassigned++;
  }
  return { s, per, unassigned, ambiguous };
}

describe("day scripts (shape)", () => {
  it("ids are valid recording scenarios, unique, and cover (a)–(f)", () => {
    const ids = DAY_SCRIPTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(StartRecordingRequest.safeParse({ bandNumber: null, transport: "sim", scenario: id }).success).toBe(true);
    expect(ids).toEqual(["day-handoff", "day-colleague", "day-guardian-call", "day-small-talk", "day-overrun", "day-unscheduled"]);
  });

  it("lines are Deepgram-style two-speaker, ordered, non-overlapping, plausible length", () => {
    for (const s of DAY_SCRIPTS) {
      expect(s.script.length, s.id).toBeGreaterThan(5);
      for (const [i, l] of s.script.entries()) {
        expect(["Speaker 0", "Speaker 1"]).toContain(l.speaker);
        expect(l.durationSec).toBeGreaterThan(0);
        expect(l.text.length).toBeLessThan(400);
        if (i > 0) expect(l.atSec, `${s.id} line ${i}`).toBeGreaterThanOrEqual(s.script[i - 1]!.atSec + s.script[i - 1]!.durationSec);
      }
      expect(new Set(s.script.map((l) => l.speaker)).size, s.id).toBe(2);
      for (const e of s.calendar) expect(CASELOAD.map((c) => c.clientRef)).toContain(e.clientRef);
    }
  });

  it("covers the required situations", () => {
    const text = (id: string) => getDayScript(id)!.script.map((l) => l.text).join(" ");
    expect(text("day-overrun")).toContain(BAIT_PHRASE);
    expect(text("day-handoff")).toContain(NEGATED_PLAN_PHRASE);
    expect(text("day-colleague")).toContain("C-201 next week");
    const colleague = getDayScript("day-colleague")!;
    expect(dayScriptSeconds(colleague)).toBeGreaterThanOrEqual(170);
    expect(dayScriptSeconds(colleague)).toBeLessThanOrEqual(200);
    // (a) travel silence ≥ 15 min between the two visits.
    const h = getDayScript("day-handoff")!.script;
    const gaps = h.slice(1).map((l, i) => l.atSec - (h[i]!.atSec + h[i]!.durationSec));
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(15 * 60);
    // (e) last line ends ~12 min after the slot.
    const o = getDayScript("day-overrun")!;
    const slotEnd = (o.calendar[0]!.offsetMin + o.calendar[0]!.minutes) * 60;
    expect(Math.round((dayScriptSeconds(o) - slotEnd) / 60)).toBe(12);
    // (f) no slot at all, SD-334-A content.
    expect(getDayScript("day-unscheduled")!.calendar).toEqual([]);
    expect(text("day-unscheduled")).toMatch(/budget sheet/);
    expect(text("day-unscheduled")).toMatch(/amount due/);
  });
});

describe("day scripts (frozen partition rule on their own calendar)", () => {
  for (const s of DAY_SCRIPTS) {
    it(`${s.id}: ${s.expect.sessions.length} session(s), ${s.expect.unassignedSegments} unassigned`, () => {
      const { per, unassigned, ambiguous } = partition(s.id);
      const got = [...per.entries()].map(([eventId, n]) => ({ eventId, n }));
      expect(got).toEqual(s.expect.sessions.map((x) => ({ eventId: dayScriptEventId(REC, x.eventKey), n: x.segments })));
      expect(unassigned).toBe(s.expect.unassignedSegments);
      expect(ambiguous).toBe(s.expect.ambiguousSegments);
    });
  }

  it("events are anchored at the audio start with deterministic per-recording ids", () => {
    const [c104, sd320] = dayScriptEvents(getDayScript("day-handoff")!, ANCHOR, REC);
    expect(c104).toMatchObject({ eventId: "demo_day_456789abcdef_c104", clientRef: "C-104", serviceCode: "CA-SDP-320", status: "confirmed", source: "demo" });
    expect(Date.parse(c104!.startAt)).toBe(ANCHOR - 40 * 60_000);
    expect(c104!.endAt).toBe(sd320!.startAt); // back to back
    expect(Date.parse(sd320!.endAt) - Date.parse(sd320!.startAt)).toBe(90 * 60_000);
    expect(dayScriptOverlay("nope", ANCHOR, REC)).toBeNull();
  });
});

describe("DayScriptCalendarSource (dev overlay)", () => {
  const nowSlot: CalendarEvent = {
    eventId: "demo_now_c_104_x",
    providerId: "provider_demo_001",
    clientRef: "C-104",
    title: "now slot",
    startAt: new Date(ANCHOR - 10 * 60_000).toISOString(),
    endAt: new Date(ANCHOR + 50 * 60_000).toISOString(),
    timezone: "America/Los_Angeles",
    serviceCode: "CA-SDP-320",
    location: null,
    status: "confirmed",
    source: "demo",
  };
  const farAway: CalendarEvent = { ...nowSlot, eventId: "demo_far", startAt: new Date(ANCHOR + 8 * 3600_000).toISOString(), endAt: new Date(ANCHOR + 9 * 3600_000).toISOString() };
  const base: CalendarSource = { kind: "demo", listEvents: async () => [nowSlot, farAway] };
  const recA: DayScriptRecording = { id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", scenario: "day-handoff", anchorMs: ANCHOR };
  const recB: DayScriptRecording = { id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", scenario: "day-overrun", anchorMs: ANCHOR + 6 * 60_000 };
  const recs = [recA, recB];
  const deps = {
    base,
    listRecordings: async (_p: string, f: number, t: number) => recs.filter((r) => r.anchorMs >= f && r.anchorMs < t),
    getRecording: async (_p: string, id: string) => recs.find((r) => r.id === id) ?? null,
    overlayFor: async (_p: string, r: DayScriptRecording) => dayScriptOverlay(r.scenario, r.anchorMs, r.id),
  };
  const range = [new Date(ANCHOR - 3 * 3600_000), new Date(ANCHOR + 10 * 3600_000)] as const;

  it("scoped: only this recording's script events; base events around the script are hidden", async () => {
    const a = await new DayScriptCalendarSource({ ...deps, onlyRecordingId: recA.id }).listEvents("provider_demo_001", ...range);
    expect(a.map((e) => e.clientRef)).toEqual(["C-104", "SD-320-A", "C-104"]);
    expect(a.map((e) => e.eventId)).toEqual([expect.stringMatching(/^demo_day_aaaaaaaaaaaa_c104$/), expect.stringMatching(/_sd320a$/), "demo_far"]);
    const b = await new DayScriptCalendarSource({ ...deps, onlyRecordingId: recB.id }).listEvents("provider_demo_001", ...range);
    expect(b.map((e) => e.clientRef)).toEqual(["SD-334-A", "C-104"]);
  });

  it("scoped to a recording without a day script: the base calendar unchanged", async () => {
    const x = await new DayScriptCalendarSource({ ...deps, onlyRecordingId: "rec_other" }).listEvents("provider_demo_001", ...range);
    expect(x).toEqual([nowSlot, farAway]);
  });

  it("global: base plus every scenario recording's events, sorted", async () => {
    const all = await new DayScriptCalendarSource(deps).listEvents("provider_demo_001", ...range);
    expect(all.map((e) => e.eventId)).toEqual([
      expect.stringMatching(/_c104$/),
      "demo_now_c_104_x",
      expect.stringMatching(/_sd334a$/),
      expect.stringMatching(/_sd320a$/),
      "demo_far",
    ]);
  });

  it("an overlay failure falls back to the base events", async () => {
    const bad = new DayScriptCalendarSource({ ...deps, listRecordings: async () => Promise.reject(new Error("db down")) });
    expect(await bad.listEvents("provider_demo_001", ...range)).toEqual([nowSlot, farAway]);
  });
});

describe("simulated transcriber plays a day script", () => {
  it("emits each line once the audio reaches it, with Deepgram-style speakers", () => {
    const s = getDayScript("day-colleague")!;
    const out: FinalPiece[] = [];
    const tr = openSimulated({ onFinal: (p) => out.push(p), onInterim: () => {}, onError: () => {} }, s.script);
    const packets = Math.ceil(dayScriptSeconds(s) / PACKET_SECONDS);
    for (let i = 0; i < packets; i++) tr.feed(new Uint8Array(1), i);
    expect(out.map((p) => p.text)).toEqual(s.script.map((l) => l.text));
    expect(out[2]).toMatchObject({ startSec: 15, speaker: "Speaker 1" });
  });
});
