import { describe, expect, it } from "vitest";
import { openSimulated, SIMULATED_SCRIPT, type FinalPiece, type TranscriberEvents } from "./transcriber";
import type { ScenarioLine } from "../../fixtures/band/types";

function collect() {
  const finals: FinalPiece[] = [];
  const interims: string[] = [];
  const events: TranscriberEvents = { onFinal: (p) => finals.push(p), onInterim: (t) => interims.push(t), onError: () => undefined };
  return { finals, interims, events };
}
const feed = (s: ReturnType<typeof openSimulated>, from: number, to: number) => {
  for (let i = from; i < to; i++) s.feed(new Uint8Array(1), i);
};

const script: ScenarioLine[] = [
  { atSec: 1, durationSec: 2, speaker: "Speaker 0", text: "First line here." },
  { atSec: 5, durationSec: 4, speaker: null, text: "Second line of the scripted visit." },
  { atSec: 30, durationSec: 3, speaker: "Speaker 1", text: "Late line." },
];

describe("openSimulated (scripted)", () => {
  it("emits each line once the audio reaches atSec, with its own times and speaker", () => {
    const { finals, interims, events } = collect();
    const s = openSimulated(events, script);
    feed(s, 0, 50); // up to 0.98 s
    expect(finals).toHaveLength(0);
    expect(interims.length).toBeGreaterThan(0);
    feed(s, 50, 51); // 1.00 s
    expect(finals).toEqual([{ startSec: 1, endSec: 3, text: "First line here.", speaker: "Speaker 0" }]);
    feed(s, 51, 250); // up to 4.98 s
    expect(finals).toHaveLength(1);
    feed(s, 250, 251); // 5.00 s
    expect(finals[1]).toEqual({ startSec: 5, endSec: 9, text: "Second line of the scripted visit.", speaker: null });
  });

  it("interim partials grow while approaching the next line", () => {
    const { interims, events } = collect();
    const s = openSimulated(events, [{ atSec: 4, durationSec: 1, speaker: null, text: "one two three four" }]);
    feed(s, 0, 200);
    expect(interims[0]).toBe("one");
    expect(interims.at(-1)!.split(" ").length).toBeGreaterThan(1);
  });

  it("finish() emits every remaining line", async () => {
    const { finals, events } = collect();
    const s = openSimulated(events, script);
    feed(s, 0, 300); // 6 s: two lines out
    expect(finals).toHaveLength(2);
    await s.finish();
    expect(finals.map((f) => f.text)).toEqual(script.map((l) => l.text));
    expect(finals[2]).toMatchObject({ startSec: 30, endSec: 33 });
    await s.finish();
    expect(finals).toHaveLength(3);
  });

  it("empty script emits nothing", async () => {
    const { finals, interims, events } = collect();
    const s = openSimulated(events, []);
    feed(s, 0, 500);
    await s.finish();
    expect(finals).toHaveLength(0);
    expect(interims).toHaveLength(0);
  });

  it("default script: one line per 3 s, all lines by finish", async () => {
    const { finals, events } = collect();
    const s = openSimulated(events);
    feed(s, 0, 301); // 6 s → lines at 0, 3, 6
    expect(finals.map((f) => f.startSec)).toEqual([0, 3, 6]);
    await s.finish();
    expect(finals.map((f) => f.text)).toEqual(SIMULATED_SCRIPT.map((l) => l.text));
    expect(finals[1]!.speaker).toBe("Participant");
  });
});
