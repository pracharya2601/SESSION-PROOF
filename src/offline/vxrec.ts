/**
 * VXREC1: the offline recording file a phone uploads (format: src/contracts/offline.ts,
 * docs/offline-recording.md). Parse it, and build the playback timeline:
 * one Ogg-ready packet list plus a map from stream time (what Deepgram reports) to wall time.
 * Pure; never logs packet contents.
 */
import {
  MAX_OFFLINE_PACKETS,
  VXREC_MAGIC,
  VXREC_MAX_HEADER_BYTES,
  VXREC_MAX_PACKET_BYTES,
  VxrecHeader,
} from "../contracts/offline";
import { DEFAULT_PACKET_SAMPLES_48K, opusPacketSamples48k } from "./ogg";

export type VxrecErrorCode =
  | "BAD_MAGIC"
  | "BAD_HEADER"
  | "BAD_RECORD"
  | "UNKNOWN_RUN"
  | "RUN_ORDER"
  | "TOO_MANY_PACKETS"
  | "NO_AUDIO";

export class VxrecError extends Error {
  constructor(
    readonly code: VxrecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VxrecError";
  }
}

export interface VxrecPacket {
  seq: number;
  opus: Uint8Array;
}

export interface VxrecRunData {
  runIndex: number;
  audioStartMs: number;
  packets: VxrecPacket[];
}

export interface ParsedVxrec {
  header: VxrecHeader;
  /** Only runs that have at least one packet, in file order. */
  runs: VxrecRunData[];
  packetCount: number;
  /** A cut-off last record was dropped (app killed mid-write). */
  truncatedTail: boolean;
}

const MAGIC = new TextEncoder().encode(VXREC_MAGIC);

/** Parses a whole VXREC1 file. Packet bytes are subarrays of `bytes` (no copy). Throws VxrecError. */
export function parseVxrec(bytes: Uint8Array, opts: { maxPackets?: number } = {}): ParsedVxrec {
  const maxPackets = opts.maxPackets ?? MAX_OFFLINE_PACKETS;
  if (bytes.length < MAGIC.length || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new VxrecError("BAD_MAGIC", 'Not a VXREC1 file (expected "VXREC1\\n").');
  }
  const limit = Math.min(bytes.length, MAGIC.length + VXREC_MAX_HEADER_BYTES);
  let nl = -1;
  for (let i = MAGIC.length; i < limit; i++) {
    if (bytes[i] === 0x0a) {
      nl = i;
      break;
    }
  }
  if (nl < 0) throw new VxrecError("BAD_HEADER", `Header line missing or longer than ${VXREC_MAX_HEADER_BYTES} bytes.`);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(MAGIC.length, nl)));
  } catch {
    throw new VxrecError("BAD_HEADER", "Header is not valid UTF-8 JSON.");
  }
  const h = VxrecHeader.safeParse(json);
  if (!h.success) {
    throw new VxrecError("BAD_HEADER", `Header invalid: ${h.error.issues.map((i) => `${i.path.join(".") || "header"}: ${i.message}`).join("; ").slice(0, 300)}`);
  }
  const header = h.data;
  const runInfo = new Map<number, number>();
  let prevIndex = -1;
  let prevStart = 0;
  for (const r of header.audioRuns) {
    if (r.runIndex <= prevIndex) throw new VxrecError("BAD_HEADER", "audioRuns must be in increasing runIndex order.");
    if (r.audioStartMs < prevStart) throw new VxrecError("BAD_HEADER", "audioRuns audioStartMs must not go backwards.");
    prevIndex = r.runIndex;
    prevStart = r.audioStartMs;
    runInfo.set(r.runIndex, r.audioStartMs);
  }
  if (Date.parse(header.recordedTo) < Date.parse(header.recordedFrom)) {
    throw new VxrecError("BAD_HEADER", "recordedTo is before recordedFrom.");
  }

  const runs: VxrecRunData[] = [];
  let current: VxrecRunData | null = null;
  let count = 0;
  let truncatedTail = false;
  let at = nl + 1;
  while (at < bytes.length) {
    if (at + 5 > bytes.length) {
      truncatedTail = true;
      break;
    }
    const runIndex = bytes[at]!;
    const seq = (bytes[at + 1]! << 8) | bytes[at + 2]!;
    const len = (bytes[at + 3]! << 8) | bytes[at + 4]!;
    if (len < 1 || len > VXREC_MAX_PACKET_BYTES) {
      throw new VxrecError("BAD_RECORD", `Record at byte ${at}: length ${len} is outside 1..${VXREC_MAX_PACKET_BYTES}.`);
    }
    if (at + 5 + len > bytes.length) {
      truncatedTail = true;
      break;
    }
    const start = runInfo.get(runIndex);
    if (start === undefined) throw new VxrecError("UNKNOWN_RUN", `Record at byte ${at}: runIndex ${runIndex} is not in audioRuns.`);
    if (!current || current.runIndex !== runIndex) {
      if (current && runIndex < current.runIndex) {
        throw new VxrecError("RUN_ORDER", `Record at byte ${at}: runIndex ${runIndex} after ${current.runIndex} (records must be grouped by run, in order).`);
      }
      current = { runIndex, audioStartMs: start, packets: [] };
      runs.push(current);
    }
    if (++count > maxPackets) throw new VxrecError("TOO_MANY_PACKETS", `More than ${maxPackets} packets.`);
    current.packets.push({ seq, opus: bytes.subarray(at + 5, at + 5 + len) });
    at += 5 + len;
  }
  if (count === 0) throw new VxrecError("NO_AUDIO", "The recording holds no audio packets.");
  return { header, runs, packetCount: count, truncatedTail };
}

/** Builds a VXREC1 file (tests, smoke script; the phone writes the same bytes). */
export function buildVxrec(header: VxrecHeader, records: { runIndex: number; seq: number; opus: Uint8Array }[]): Uint8Array {
  const head = new TextEncoder().encode(`${VXREC_MAGIC}${JSON.stringify(header)}\n`);
  const size = head.length + records.reduce((s, r) => s + 5 + r.opus.length, 0);
  const out = new Uint8Array(size);
  out.set(head, 0);
  let at = head.length;
  for (const r of records) {
    out[at] = r.runIndex;
    out[at + 1] = (r.seq >> 8) & 0xff;
    out[at + 2] = r.seq & 0xff;
    out[at + 3] = (r.opus.length >> 8) & 0xff;
    out[at + 4] = r.opus.length & 0xff;
    out.set(r.opus, at + 5);
    at += 5 + r.opus.length;
  }
  return out;
}

// ------------------------------------------------------------------ timeline
export interface Timeline {
  /** Packets in stream order, ready for muxOggOpus. */
  packets: Uint8Array[];
  /** Packets the band sent but the phone never got (seq gaps inside a run). */
  lostPackets: number;
  /** Duplicate / backwards seq records that were dropped. */
  droppedPackets: number;
  /** Wall time of the first packet and the end of the last one. */
  firstMs: number;
  lastMs: number;
  /** Stream seconds (as reported by the decoder / Deepgram) → epoch ms. */
  toWallMs(streamSec: number): number;
}

/**
 * Lays the runs end to end into ONE stream (no silence between runs) and remembers where
 * every packet sits on the wall clock: packet wall time = run.audioStartMs + seq distance × packet
 * duration. So a Deepgram time maps back exactly, across seq gaps and run breaks.
 * seq wraps at 65536; a forward step of 1..32767 is progress (step − 1 lost); a step of 0
 * (duplicate) or ≥ 32768 (backwards) drops the record.
 */
export function buildTimeline(runs: VxrecRunData[]): Timeline {
  const packets: Uint8Array[] = [];
  const stream48: number[] = []; // stream start of each packet (48 kHz samples)
  const wallMs: number[] = []; // wall start of each packet
  const dur48: number[] = [];
  let streamAt = 0;
  let lost = 0;
  let dropped = 0;
  for (const run of runs) {
    let prevSeq: number | null = null;
    let wallOffset48 = 0;
    for (const p of run.packets) {
      const d = opusPacketSamples48k(p.opus) ?? DEFAULT_PACKET_SAMPLES_48K;
      if (prevSeq !== null) {
        const step = (p.seq - prevSeq + 65536) % 65536;
        if (step === 0 || step >= 32768) {
          dropped++;
          continue;
        }
        lost += step - 1;
        wallOffset48 += (step - 1) * d;
      }
      prevSeq = p.seq;
      packets.push(p.opus);
      stream48.push(streamAt);
      wallMs.push(run.audioStartMs + wallOffset48 / 48);
      dur48.push(d);
      streamAt += d;
      wallOffset48 += d;
    }
  }
  const n = packets.length;
  const firstMs = n ? wallMs[0]! : 0;
  const lastMs = n ? wallMs[n - 1]! + dur48[n - 1]! / 48 : 0;
  return {
    packets,
    lostPackets: lost,
    droppedPackets: dropped,
    firstMs,
    lastMs,
    toWallMs(streamSec: number): number {
      if (n === 0) return 0;
      const t = Math.max(0, streamSec) * 48000;
      // last packet whose stream start <= t
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (stream48[mid]! <= t) lo = mid;
        else hi = mid - 1;
      }
      const into = t - stream48[lo]!;
      // Inside the packet → interpolate; past the very end → extrapolate (simulated script lines).
      const within = lo === n - 1 ? into : Math.min(into, dur48[lo]!);
      return wallMs[lo]! + within / 48;
    },
  };
}
