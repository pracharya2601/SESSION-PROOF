/**
 * Minimal Ogg Opus muxer (RFC 3533 pages + RFC 7845 Opus mapping) for one mono stream.
 * Used to hand an offline band recording to Deepgram pre-recorded (Content-Type audio/ogg).
 *
 * - Page 0 (BOS): OpusHead (version 1, 1 channel, pre-skip, input rate, gain 0, mapping 0).
 * - Page 1: OpusTags (vendor string, no comments).
 * - Audio pages: whole packets only (a band packet is ≤ 1500 bytes = ≤ 6 lacing values, so a
 *   packet never spans pages); granule position = cumulative 48 kHz samples at the end of the
 *   last packet on the page. Last page has the EOS flag.
 * Pure: no I/O, works in the Worker and in node.
 */

const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** Ogg CRC-32 (polynomial 0x04c11db7, no reflection, init 0, no final xor). */
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/**
 * Samples (at 48 kHz) one Opus packet decodes to, from its TOC byte (RFC 6716 §3.1).
 * Returns null for a packet whose TOC cannot be read (empty, or code 3 without a count byte).
 */
export function opusPacketSamples48k(packet: Uint8Array): number | null {
  if (packet.length < 1) return null;
  const toc = packet[0]!;
  const config = toc >> 3;
  let frame: number; // samples at 48 kHz per frame
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]!;
  else if (config < 16) frame = [480, 960][config & 1]!;
  else frame = [120, 240, 480, 960][config & 3]!;
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) return null;
    frames = packet[1]! & 0x3f;
  }
  const n = frame * frames;
  // A packet holds at most 120 ms (5760 samples at 48 kHz).
  return n > 0 && n <= 5760 ? n : null;
}

export interface OggOpusOptions {
  /** Encoder input rate written to OpusHead (informational for decoders). Default 16000. */
  inputSampleRate?: number;
  /** OpusHead pre-skip in 48 kHz samples. Default 0, so decoded time 0 = start of the first packet. */
  preSkip?: number;
  /** Bitstream serial number. Default fixed ("VXEC"): one stream per file. */
  serial?: number;
  /** Flush a page after this many packets (default 50 = 1 s of 20 ms packets). */
  packetsPerPage?: number;
  vendor?: string;
}

/** Samples per packet used when a TOC cannot be read (the band's 20 ms). */
export const DEFAULT_PACKET_SAMPLES_48K = 960;

function u32le(view: DataView, at: number, v: number) {
  view.setUint32(at, v >>> 0, true);
}

function page(headerType: number, granule: bigint, serial: number, seq: number, packets: Uint8Array[]): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error("ogg: too many segments on one page");
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + bodyLen);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  out[4] = 0; // version
  out[5] = headerType;
  view.setBigUint64(6, granule, true);
  u32le(view, 14, serial);
  u32le(view, 18, seq);
  u32le(view, 22, 0); // CRC placeholder
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  u32le(view, 22, oggCrc32(out));
  return out;
}

function opusHead(channels: number, preSkip: number, inputRate: number): Uint8Array {
  const b = new Uint8Array(19);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode("OpusHead"), 0);
  b[8] = 1; // version
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  v.setInt16(16, 0, true); // output gain
  b[18] = 0; // channel mapping family 0 (mono/stereo)
  return b;
}

function opusTags(vendor: string): Uint8Array {
  const vend = new TextEncoder().encode(vendor);
  const b = new Uint8Array(8 + 4 + vend.length + 4);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode("OpusTags"), 0);
  v.setUint32(8, vend.length, true);
  b.set(vend, 12);
  v.setUint32(12 + vend.length, 0, true); // no user comments
  return b;
}

/**
 * Wraps raw Opus packets (one mono stream) in an Ogg Opus file.
 * Throws on an empty packet list or a packet larger than 255×255 bytes (never the case for the band).
 */
export function muxOggOpus(packets: readonly Uint8Array[], opts: OggOpusOptions = {}): Uint8Array<ArrayBuffer> {
  if (packets.length === 0) throw new Error("ogg: no packets");
  const serial = (opts.serial ?? 0x56584543) >>> 0;
  const preSkip = opts.preSkip ?? 0;
  const perPage = Math.max(1, Math.min(255, opts.packetsPerPage ?? 50));
  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(page(0x02, 0n, serial, seq++, [opusHead(1, preSkip, opts.inputSampleRate ?? 16000)]));
  pages.push(page(0x00, 0n, serial, seq++, [opusTags(opts.vendor ?? "vexo-field-assistant offline")]));

  let granule = 0n;
  let batch: Uint8Array[] = [];
  let segs = 0;
  const flush = (last: boolean) => {
    if (batch.length === 0) return;
    pages.push(page(last ? 0x04 : 0x00, granule, serial, seq++, batch));
    batch = [];
    segs = 0;
  };
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i]!;
    if (p.length > 255 * 255 - 1) throw new Error("ogg: packet too large");
    const need = Math.floor(p.length / 255) + 1;
    if (segs + need > 255 || batch.length >= perPage) flush(false);
    batch.push(p);
    segs += need;
    granule += BigInt(opusPacketSamples48k(p) ?? DEFAULT_PACKET_SAMPLES_48K);
  }
  flush(true);
  const total = pages.reduce((s, x) => s + x.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const x of pages) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}
