/**
 * Conversation type rules (content-conversation.ts) and the visit-tail rule (content.ts) on the
 * SYNTHETIC day scripts (fixtures/schedule/day-scripts.ts) with the demo Drive's real plans and
 * participant names. Pure: no D1, no AI.
 */
import { describe, expect, it } from "vitest";
import { DemoDriveSource } from "../schedule";
import { getDayScript } from "../../fixtures/schedule/day-scripts";
import { candidateFactory } from "./content-job";
import { classifyConversation, combineConversation, needsConfirmation, participantMentionLines } from "./content-conversation";
import { combine, scoreBlock, type Candidate, type LeftoverSegment } from "./content";

const PROVIDER = "provider_demo_001";
const T0 = Date.parse("2026-11-13T19:00:00.000Z");

async function candidate(clientRef: string, events: Candidate["events"] = []): Promise<Candidate> {
  const f = candidateFactory({ store: null as never, clock: { now: () => new Date(T0) }, drive: new DemoDriveSource() }, PROVIDER);
  const c = await f.candidateFor(clientRef, []);
  if (!c) throw new Error(`no Drive context for ${clientRef}`);
  return { ...c, events };
}

function scriptLines(id: string, fromSec = 0, toSec = Infinity): LeftoverSegment[] {
  const s = getDayScript(id)!;
  return s.script
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.atSec >= fromSec && l.atSec < toSec)
    .map(({ l, i }) => ({
      index: i + 1,
      speaker: l.speaker,
      text: l.text,
      observedFrom: new Date(T0 + l.atSec * 1000).toISOString(),
      observedTo: new Date(T0 + (l.atSec + l.durationSec) * 1000).toISOString(),
    }));
}

describe("conversation type: guardian / family calls inside a client slot", () => {
  it("day-guardian-call (C-104 slot): guardian_or_family ≥ 0.6 → needs confirmation", async () => {
    const r = classifyConversation({ lines: scriptLines("day-guardian-call"), client: await candidate("C-104"), eventTitle: "C-104 Independent living skills" });
    expect(r.conversationType).toBe("guardian_or_family");
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    expect(needsConfirmation(r)).toBe(true);
    expect(r.signals.relationCues).toBeGreaterThanOrEqual(1);
    expect(r.signals.participantMentions).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(r.signals)).not.toMatch(/Sam|Rivera|mom/i); // counts only
  });

  it('a phone call from a parent ("Hi, it\'s Maria, Sam\'s mom…") talking ABOUT the participant', async () => {
    const lines = [
      ["Speaker 1", "Hi, it's Maria, Sam's mom. Do you have a minute?"],
      ["Speaker 0", "Hi Maria, sure. Is everything alright?"],
      ["Speaker 1", "Sam has a cold today, so Sam won't make the visit."],
      ["Speaker 0", "Thanks for letting me know. I hope Sam feels better soon."],
      ["Speaker 1", "Can we move it to Thursday? Sam will be back at school then."],
      ["Speaker 0", "Thursday works. Bye now."],
    ].map(([speaker, text], i) => ({ index: i + 1, speaker: speaker!, text: text! }));
    const r = classifyConversation({ lines, client: await candidate("C-104") });
    expect(r.conversationType).toBe("guardian_or_family");
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    expect(r.signals.phoneCues).toBeGreaterThanOrEqual(1);
  });

  it("client sessions that address the participant by name stay client_session (no flag)", async () => {
    const cases: [string, string, number, number][] = [
      ["day-handoff", "C-104", 0, 7 * 60],
      ["day-handoff", "SD-320-A", 24 * 60, 102 * 60],
      ["day-overrun", "SD-334-A", 0, 62 * 60],
      ["day-unscheduled", "SD-334-A", 0, Infinity],
    ];
    for (const [id, ref, from, to] of cases) {
      const r = classifyConversation({ lines: scriptLines(id, from, to), client: await candidate(ref) });
      expect([id, ref, r.conversationType]).toEqual([id, ref, "client_session"]);
      expect(needsConfirmation(r)).toBe(false);
    }
  });

  it("participant mentions: addressing is not talking about", () => {
    const parts = ["Sam", "Rivera"];
    const n = (t: string) => participantMentionLines([{ text: t }], parts);
    expect(n("Okay Sam, let's look at the bus route.")).toBe(0);
    expect(n("See you Thursday, Sam.")).toBe(0);
    expect(n("Great job, Sam!")).toBe(0);
    expect(n("Is everything okay with Sam?")).toBe(1);
    expect(n("Sam's bus pass form is ready.")).toBe(1);
    expect(n("Tell Sam I said hi.")).toBe(1);
    expect(participantMentionLines([{ text: "Sam isn't home." }], [])).toBe(0);
  });

  it("AI and rules both non-client (guardian vs phone call): stays flagged", () => {
    const rules = { conversationType: "guardian_or_family" as const, confidence: 0.8, method: "rules" as const, signals: {} as never };
    const out = combineConversation(rules, { conversationType: "phone_call", confidence: 0.8 });
    expect(needsConfirmation(out)).toBe(true);
    // A real disagreement (client vs non-client) still halves the winner.
    expect(combineConversation(rules, { conversationType: "client_session", confidence: 0.7 }).confidence).toBe(0.4);
  });
});

describe("visit tail: leftover right after (or before) a client's own slot", () => {
  const EVENT = { eventId: "ev_sd334a", startMs: T0 - 2 * 60_000, endMs: T0 + 58 * 60_000 };

  it("day-overrun's goodbye (past end + 10 min) extends SD-334-A's event, even if the AI says none", async () => {
    const tail = scriptLines("day-overrun", 69 * 60); // the 2 lines pass 1 left unassigned
    expect(tail).toHaveLength(2);
    const block = { segments: tail, fromMs: Date.parse(tail[0]!.observedFrom), toMs: Date.parse(tail.at(-1)!.observedTo) };
    const cands = [await candidate("SD-334-A", [EVENT]), await candidate("C-104", [{ eventId: "ev_c104", startMs: T0 - 3 * 3600_000, endMs: T0 - 2 * 3600_000 }])];
    const d = scoreBlock(block, cands);
    expect(d).toMatchObject({ clientRef: "SD-334-A", eventId: "ev_sd334a", tail: true });
    expect(d.confidence).toBeGreaterThanOrEqual(0.6);
    const f = combine(d, { clientRef: null, confidence: 0.9, citedSegmentIndexes: [] });
    expect(f).toMatchObject({ clientRef: "SD-334-A", eventId: "ev_sd334a", method: "ai+rules" });
  });

  it("before the start counts too; > 20 min away, or nothing linking it to the client → no tail", async () => {
    const lines = scriptLines("day-overrun", 69 * 60);
    const shift = (segs: LeftoverSegment[], ms: number) =>
      segs.map((s) => ({ ...s, observedFrom: new Date(Date.parse(s.observedFrom) + ms).toISOString(), observedTo: new Date(Date.parse(s.observedTo) + ms).toISOString() }));
    const blockOf = (segs: LeftoverSegment[]) => ({ segments: segs, fromMs: Date.parse(segs[0]!.observedFrom), toMs: Date.parse(segs.at(-1)!.observedTo) });
    const c = await candidate("SD-334-A", [EVENT]);
    // 15 min before the slot starts.
    const early = shift(lines, EVENT.startMs - 15 * 60_000 - Date.parse(lines.at(-1)!.observedTo));
    expect(scoreBlock(blockOf(early), [c])).toMatchObject({ clientRef: "SD-334-A", eventId: "ev_sd334a", tail: true });
    // 30 min after the end.
    const late = shift(lines, EVENT.endMs + 30 * 60_000 - Date.parse(lines[0]!.observedFrom));
    expect(scoreBlock(blockOf(late), [c]).clientRef).toBeNull();
    // Right after the slot but no name and no plan terms.
    const anon = lines.map((s) => ({ ...s, text: s.text.replace(/,? Jordan/, "") }));
    expect(scoreBlock(blockOf(anon), [c]).clientRef).toBeNull();
  });
});
