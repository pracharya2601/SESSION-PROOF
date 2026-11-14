import { describe, expect, it } from "vitest";
import type { BandSegment } from "../../../contracts";
import {
  decodeAudioFrame,
  encodeAudioFrame,
  formatElapsed,
  mergeSegment,
  parseBandNumber,
  parseServerMessage,
  processingSettled,
  startControl,
} from "./protocol";

const seg = (index: number, id = `seg_${index}`): BandSegment => ({
  id,
  visitId: "visit_1",
  index,
  observedFrom: "2026-11-14T10:00:00.000Z",
  observedTo: "2026-11-14T10:00:02.000Z",
  speaker: "Speaker 0",
  text: `line ${index}`,
  sourceMode: "fixture",
});

describe("encodeAudioFrame", () => {
  it("prefixes the opus bytes with the seq as u16 big-endian", () => {
    const f = encodeAudioFrame(0x1234, new Uint8Array([9, 8, 7]));
    expect(Array.from(f)).toEqual([0x12, 0x34, 9, 8, 7]);
  });

  it("handles seq 0, 255, 256 and 65535", () => {
    expect(Array.from(encodeAudioFrame(0, new Uint8Array()))).toEqual([0, 0]);
    expect(Array.from(encodeAudioFrame(255, new Uint8Array([1])))).toEqual([0, 255, 1]);
    expect(Array.from(encodeAudioFrame(256, new Uint8Array([1])))).toEqual([1, 0, 1]);
    expect(Array.from(encodeAudioFrame(65535, new Uint8Array([1])))).toEqual([255, 255, 1]);
  });

  it("wraps a seq beyond 16 bits", () => {
    expect(Array.from(encodeAudioFrame(65536 + 2, new Uint8Array()))).toEqual([0, 2]);
  });

  it("does not alias the input buffer and round-trips", () => {
    const opus = new Uint8Array([1, 2, 3, 4]);
    const f = encodeAudioFrame(513, opus);
    opus[0] = 99;
    expect(decodeAudioFrame(f)).toEqual({ seq: 513, opus: new Uint8Array([1, 2, 3, 4]) });
    expect(decodeAudioFrame(new Uint8Array([1]))).toBeNull();
  });
});

describe("startControl", () => {
  it("sends an integer epoch ms", () => {
    expect(JSON.parse(startControl(1794484800123.4))).toEqual({ type: "start", audioStartMs: 1794484800123 });
  });
});

describe("parseServerMessage", () => {
  it("parses each known message", () => {
    expect(parseServerMessage('{"type":"ready","transcriber":"simulated"}')).toEqual({ type: "ready", transcriber: "simulated" });
    expect(parseServerMessage('{"type":"interim","text":"hel"}')).toEqual({ type: "interim", text: "hel" });
    expect(parseServerMessage(JSON.stringify({ type: "final", segment: seg(1) }))).toEqual({ type: "final", segment: seg(1) });
    expect(parseServerMessage('{"type":"stats","packets":50,"lostPackets":1}')).toEqual({ type: "stats", packets: 50, lostPackets: 1 });
    expect(parseServerMessage('{"type":"error","code":"TRANSCRIBER_DOWN","message":"x"}')).toEqual({
      type: "error",
      code: "TRANSCRIBER_DOWN",
      message: "x",
    });
    expect(parseServerMessage('{"type":"done","segmentCount":3}')).toEqual({ type: "done", segmentCount: 3 });
  });

  it("falls back to the code when an error has no message", () => {
    expect(parseServerMessage('{"type":"error","code":"E"}')).toEqual({ type: "error", code: "E", message: "E" });
  });

  it("rejects junk", () => {
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("[]")).toBeNull();
    expect(parseServerMessage('{"type":"nope"}')).toBeNull();
    expect(parseServerMessage('{"type":"ready","transcriber":"whisper"}')).toBeNull();
    expect(parseServerMessage('{"type":"stats","packets":"1","lostPackets":0}')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "final", segment: { ...seg(1), text: 5 } }))).toBeNull();
  });
});

describe("mergeSegment", () => {
  it("appends, dedupes by id and keeps index order", () => {
    let list = mergeSegment([], seg(1));
    list = mergeSegment(list, seg(3));
    list = mergeSegment(list, seg(2));
    list = mergeSegment(list, { ...seg(2), text: "edited" });
    expect(list.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(list[1]?.text).toBe("edited");
  });
});

describe("small helpers", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_900)).toBe("0:07");
    expect(formatElapsed(724_000)).toBe("12:04");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("parses band numbers 1..999", () => {
    expect(parseBandNumber("42")).toBe(42);
    expect(parseBandNumber(" 7 ")).toBe(7);
    for (const bad of ["", "0", "1000", "4.2", "-3", "abc"]) expect(parseBandNumber(bad)).toBeNull();
  });

  it("knows when processing has settled", () => {
    expect(processingSettled("QUEUED")).toBe(false);
    expect(processingSettled("PROCESSING")).toBe(false);
    expect(processingSettled("NEEDS_REVIEW")).toBe(true);
    expect(processingSettled("FAILED")).toBe(true);
  });
});
