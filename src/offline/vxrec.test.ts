import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { oggPackets } from "../ui/vendor/vexo-open/index.js";
import type { VxrecHeader } from "../contracts/offline";
import { buildTimeline, buildVxrec, parseVxrec, VxrecError } from "./vxrec";

const T0 = Date.parse("2026-11-12T15:00:00.000Z");
const packets = oggPackets(new Uint8Array(readFileSync(resolve(__dirname, "../ui/public/sample-speech.opus"))));

function header(over: Partial<VxrecHeader> = {}): VxrecHeader {
  return {
    version: 1,
    bandNumber: 7,
    audioRuns: [
      { runIndex: 0, audioStartMs: T0 },
      { runIndex: 1, audioStartMs: T0 + 60_000 },
    ],
    recordedFrom: new Date(T0 - 5000).toISOString(),
    recordedTo: new Date(T0 + 120_000).toISOString(),
    clientRef: "C-104",
    localId: "rec-0001-abcdef",
    appVersion: "1.4.0 (77)",
    ...over,
  };
}

/** Run 0: 400 packets starting at seq 65400 (wraps), with packets 10..14 lost; run 1: 396 packets from seq 0. */
function sampleFile(): Uint8Array {
  const recs: { runIndex: number; seq: number; opus: Uint8Array }[] = [];
  for (let i = 0; i < 400; i++) if (i < 10 || i >= 15) recs.push({ runIndex: 0, seq: (65400 + i) % 65536, opus: packets[i]! });
  for (let i = 400; i < 796; i++) recs.push({ runIndex: 1, seq: i - 400, opus: packets[i]! });
  return buildVxrec(header(), recs);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof VxrecError) return e.code;
    throw e;
  }
  return "OK";
}

describe("VXREC1 parser", () => {
  it("parses a good file: header, runs, packets", () => {
    const f = parseVxrec(sampleFile());
    expect(f.header.localId).toBe("rec-0001-abcdef");
    expect(f.runs.map((r) => [r.runIndex, r.audioStartMs, r.packets.length])).toEqual([
      [0, T0, 395],
      [1, T0 + 60_000, 396],
    ]);
    expect(f.packetCount).toBe(791);
    expect(f.truncatedTail).toBe(false);
    expect(Buffer.from(f.runs[1]!.packets[0]!.opus).equals(Buffer.from(packets[400]!))).toBe(true);
    expect(f.runs[0]!.packets[0]!.seq).toBe(65400);
  });

  it("ignores unknown header keys (forward compatible)", () => {
    const bytes = new TextEncoder().encode(`VXREC1\n${JSON.stringify({ ...header(), futureField: { x: 1 } })}\n`);
    const withRec = new Uint8Array([...bytes, 0, 0, 1, 0, 3, 0xb8, 1, 2]);
    expect(parseVxrec(withRec).packetCount).toBe(1);
  });

  it("tolerates a cut-off last record (app killed mid-write)", () => {
    const full = sampleFile();
    for (const cut of [1, 3, 5, 30]) {
      const f = parseVxrec(full.subarray(0, full.length - cut));
      expect(f.truncatedTail).toBe(true);
      expect(f.packetCount).toBe(790);
    }
  });

  it("rejects wrong magic, bad / truncated header, huge len, unknown or out-of-order runs, no audio", () => {
    const good = sampleFile();
    expect(code(() => parseVxrec(new TextEncoder().encode("OggS....")))).toBe("BAD_MAGIC");
    expect(code(() => parseVxrec(new TextEncoder().encode("VXREC2\n{}\n")))).toBe("BAD_MAGIC");
    expect(code(() => parseVxrec(good.subarray(0, 40)))).toBe("BAD_HEADER"); // header line cut off
    expect(code(() => parseVxrec(new TextEncoder().encode("VXREC1\nnot json\n")))).toBe("BAD_HEADER");
    expect(code(() => parseVxrec(buildVxrec({ ...header(), version: 2 as 1 }, [])))).toBe("BAD_HEADER");
    expect(code(() => parseVxrec(buildVxrec(header({ audioRuns: [] }), [])))).toBe("BAD_HEADER");
    expect(code(() => parseVxrec(buildVxrec(header({ audioRuns: [{ runIndex: 1, audioStartMs: T0 }, { runIndex: 0, audioStartMs: T0 }] }), [])))).toBe("BAD_HEADER");
    expect(code(() => parseVxrec(new TextEncoder().encode(`VXREC1\n${" ".repeat(20000)}`)))).toBe("BAD_HEADER");

    const head = new TextEncoder().encode(`VXREC1\n${JSON.stringify(header())}\n`);
    const huge = new Uint8Array([...head, 0, 0, 1, 0x7f, 0xff, ...new Uint8Array(100)]);
    expect(code(() => parseVxrec(huge))).toBe("BAD_RECORD");
    const zero = new Uint8Array([...head, 0, 0, 1, 0, 0]);
    expect(code(() => parseVxrec(zero))).toBe("BAD_RECORD");
    expect(code(() => parseVxrec(buildVxrec(header(), [{ runIndex: 5, seq: 0, opus: packets[0]! }])))).toBe("UNKNOWN_RUN");
    expect(
      code(() =>
        parseVxrec(
          buildVxrec(header(), [
            { runIndex: 1, seq: 0, opus: packets[0]! },
            { runIndex: 0, seq: 1, opus: packets[1]! },
          ]),
        ),
      ),
    ).toBe("RUN_ORDER");
    expect(code(() => parseVxrec(buildVxrec(header(), [])))).toBe("NO_AUDIO");
    expect(code(() => parseVxrec(good, { maxPackets: 100 }))).toBe("TOO_MANY_PACKETS");
  });
});

describe("timeline", () => {
  it("keeps wall time across seq wrap, lost packets and run breaks", () => {
    const f = parseVxrec(sampleFile());
    const t = buildTimeline(f.runs);
    expect(t.packets).toHaveLength(791);
    expect(t.lostPackets).toBe(5);
    expect(t.droppedPackets).toBe(0);
    expect(t.firstMs).toBe(T0);
    expect(t.lastMs).toBe(T0 + 60_000 + 396 * 20);
    // stream 0.1 s = packet 5 of run 0 → T0 + 100 ms
    expect(t.toWallMs(0.1)).toBeCloseTo(T0 + 100, 6);
    // stream packet 10 is band packet 15 (5 lost) → T0 + 300 ms
    expect(t.toWallMs(0.2)).toBeCloseTo(T0 + 300, 6);
    expect(t.toWallMs(0.21)).toBeCloseTo(T0 + 310, 6);
    // packet 395 of the stream is run 1's first → T0 + 60 s
    expect(t.toWallMs(395 * 0.02)).toBeCloseTo(T0 + 60_000, 6);
    expect(t.toWallMs(395 * 0.02 + 1)).toBeCloseTo(T0 + 61_000, 6);
    // last run's seq 0x0000..: past the end extrapolates
    expect(t.toWallMs(791 * 0.02 + 2)).toBeCloseTo(T0 + 60_000 + 396 * 20 + 2000, 6);
    expect(t.toWallMs(-1)).toBe(T0);
  });

  it("drops duplicate and backwards records", () => {
    const t = buildTimeline([
      {
        runIndex: 0,
        audioStartMs: T0,
        packets: [
          { seq: 1, opus: packets[0]! },
          { seq: 2, opus: packets[1]! },
          { seq: 2, opus: packets[1]! },
          { seq: 1, opus: packets[0]! },
          { seq: 3, opus: packets[2]! },
        ],
      },
    ]);
    expect(t.packets).toHaveLength(3);
    expect(t.droppedPackets).toBe(2);
    expect(t.lostPackets).toBe(0);
    expect(t.lastMs).toBe(T0 + 60);
  });
});
