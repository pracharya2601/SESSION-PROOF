/**
 * Pure helpers for the visit stream (wire protocol in src/contracts/band.ts).
 * No DOM, no band: unit-tested in protocol.test.ts.
 */
import type { BandSegment, Transcriber, VisitClientControl, VisitServerMessage } from "../../../contracts";

/** One binary frame: [u16 big-endian band seq][one Opus packet]. */
export function encodeAudioFrame(seq: number, opus: Uint8Array): Uint8Array {
  const frame = new Uint8Array(2 + opus.length);
  const s = seq & 0xffff;
  frame[0] = s >> 8;
  frame[1] = s & 0xff;
  frame.set(opus, 2);
  return frame;
}

/** Inverse of encodeAudioFrame (tests, debugging). */
export function decodeAudioFrame(frame: Uint8Array): { seq: number; opus: Uint8Array } | null {
  if (frame.length < 2) return null;
  return { seq: ((frame[0] ?? 0) << 8) | (frame[1] ?? 0), opus: frame.subarray(2) };
}

export function controlText(msg: VisitClientControl): string {
  return JSON.stringify(msg);
}

/** The start control for an audio run. audioStartMs is the epoch ms of the run's first packet. */
export function startControl(audioStartMs: number): string {
  return controlText({ type: "start", audioStartMs: Math.max(1, Math.round(audioStartMs)) });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const TRANSCRIBERS: readonly Transcriber[] = ["deepgram", "simulated"];

function isSegment(v: unknown): v is BandSegment {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.visitId) &&
    isNum(v.index) &&
    isStr(v.observedFrom) &&
    isStr(v.observedTo) &&
    (v.speaker === null || isStr(v.speaker)) &&
    isStr(v.text) &&
    (v.sourceMode === "live" || v.sourceMode === "fixture")
  );
}

/**
 * Parses one server text message. Returns null for anything that is not a known, well-formed
 * VisitServerMessage (binary data, bad JSON, unknown type, missing fields); callers ignore those.
 */
export function parseServerMessage(data: unknown): VisitServerMessage | null {
  if (!isStr(data)) return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(m) || !isStr(m.type)) return null;
  switch (m.type) {
    case "ready":
      return TRANSCRIBERS.includes(m.transcriber as Transcriber) ? { type: "ready", transcriber: m.transcriber as Transcriber } : null;
    case "interim":
      return isStr(m.text) ? { type: "interim", text: m.text } : null;
    case "final":
      return isSegment(m.segment) ? { type: "final", segment: m.segment } : null;
    case "stats":
      return isNum(m.packets) && isNum(m.lostPackets) ? { type: "stats", packets: m.packets, lostPackets: m.lostPackets } : null;
    case "error":
      return isStr(m.code) ? { type: "error", code: m.code, message: isStr(m.message) ? m.message : m.code } : null;
    case "done":
      return isNum(m.segmentCount) ? { type: "done", segmentCount: m.segmentCount } : null;
    default:
      return null;
  }
}

/** Adds a final segment, keeping index order and dropping a repeat of the same id. */
export function mergeSegment(list: readonly BandSegment[], seg: BandSegment): BandSegment[] {
  if (list.some((s) => s.id === seg.id)) return list.map((s) => (s.id === seg.id ? seg : s));
  const next = [...list, seg];
  if (list.length && (list[list.length - 1]?.index ?? 0) > seg.index) next.sort((a, b) => a.index - b.index);
  return next;
}

/** "0:07", "12:04", "1:02:03" */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Band numbers on the bag: whole numbers 1..999. Returns null when the text is not one. */
export function parseBandNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 999 ? n : null;
}

/** A session status the visit's processing has finished with (Review can take over). */
export function processingSettled(status: string): boolean {
  return !["SCHEDULED", "WAITING_FOR_EVIDENCE", "QUEUED", "PROCESSING"].includes(status);
}
