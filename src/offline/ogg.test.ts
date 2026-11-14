import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { oggPackets } from "../ui/vendor/vexo-open/index.js";
import { muxOggOpus, oggCrc32, opusPacketSamples48k } from "./ogg";

/** The band-format sample: 796 real band Opus packets (CELT WB 20 ms, 60 bytes each). */
function samplePackets(): Uint8Array[] {
  return oggPackets(new Uint8Array(readFileSync(resolve(__dirname, "../ui/public/sample-speech.opus"))));
}

interface Page {
  headerType: number;
  granule: bigint;
  serial: number;
  seq: number;
  crc: number;
  raw: Uint8Array;
}

function pages(bytes: Uint8Array): Page[] {
  const out: Page[] = [];
  let at = 0;
  while (at < bytes.length) {
    expect(String.fromCharCode(...bytes.subarray(at, at + 4))).toBe("OggS");
    const v = new DataView(bytes.buffer, bytes.byteOffset + at);
    const n = bytes[at + 26]!;
    let body = 0;
    for (let i = 0; i < n; i++) body += bytes[at + 27 + i]!;
    const len = 27 + n + body;
    out.push({ headerType: bytes[at + 5]!, granule: v.getBigUint64(6, true), serial: v.getUint32(14, true), seq: v.getUint32(18, true), crc: v.getUint32(22, true), raw: bytes.subarray(at, at + len) });
    at += len;
  }
  expect(at).toBe(bytes.length);
  return out;
}

describe("Ogg Opus muxer", () => {
  it("round-trips the band sample through the kit's oggPackets", () => {
    const pk = samplePackets();
    expect(pk).toHaveLength(796);
    const ogg = muxOggOpus(pk);
    const back = oggPackets(ogg);
    expect(back).toHaveLength(pk.length);
    for (let i = 0; i < pk.length; i++) expect(Buffer.from(back[i]!).equals(Buffer.from(pk[i]!))).toBe(true);
  });

  it("writes OpusHead/OpusTags, BOS/EOS, monotonic granules in 48 kHz units, and valid CRCs", () => {
    const pk = samplePackets();
    const ogg = muxOggOpus(pk);
    const ps = pages(ogg);
    expect(ps[0]!.headerType).toBe(0x02);
    expect(ps[0]!.granule).toBe(0n);
    const head = ps[0]!.raw.subarray(28);
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe("OpusHead");
    expect(head[8]).toBe(1); // version
    expect(head[9]).toBe(1); // mono
    const hv = new DataView(head.buffer, head.byteOffset);
    expect(hv.getUint16(10, true)).toBe(0); // pre-skip
    expect(hv.getUint32(12, true)).toBe(16000);
    expect(head[18]).toBe(0);
    expect(String.fromCharCode(...ps[1]!.raw.subarray(28, 36))).toBe("OpusTags");
    expect(ps[1]!.granule).toBe(0n);
    expect(ps.at(-1)!.headerType).toBe(0x04);
    expect(ps.at(-1)!.granule).toBe(BigInt(796 * 960));
    let prev = -1n;
    ps.forEach((p, i) => {
      expect(p.seq).toBe(i);
      expect(p.serial).toBe(ps[0]!.serial);
      if (i >= 2) expect(p.granule > prev).toBe(true);
      prev = p.granule;
      const copy = p.raw.slice();
      copy.fill(0, 22, 26);
      expect(oggCrc32(copy)).toBe(p.crc);
    });
    // 50 packets per page → 16 audio pages for 796 packets
    expect(ps.length).toBe(2 + Math.ceil(796 / 50));
  });

  it("laces packets of 255+ bytes and keeps every packet on one page", () => {
    const big = [new Uint8Array(255).fill(0xb8), new Uint8Array(600).fill(0xb8), new Uint8Array(1).fill(0xb8), new Uint8Array(1500).fill(0xb8)];
    const back = oggPackets(muxOggOpus(big, { packetsPerPage: 255 }));
    expect(back.map((p) => p.length)).toEqual([255, 600, 1, 1500]);
  });

  it("uses the Ogg CRC-32 (check value of '123456789')", () => {
    // CRC-32/OGG (poly 0x04c11db7, init 0, no reflection) check value for "123456789".
    expect(oggCrc32(new TextEncoder().encode("123456789"))).toBe(0x89a1897f);
  });

  it("reads packet durations from the TOC byte", () => {
    expect(opusPacketSamples48k(new Uint8Array([0xb8, 1, 2]))).toBe(960); // CELT WB 20 ms (the band)
    expect(opusPacketSamples48k(new Uint8Array([0x08]))).toBe(960); // SILK NB 20 ms
    expect(opusPacketSamples48k(new Uint8Array([0x18]))).toBe(2880); // SILK NB 60 ms
    expect(opusPacketSamples48k(new Uint8Array([0xb9]))).toBe(1920); // two 20 ms frames
    expect(opusPacketSamples48k(new Uint8Array([0xbb, 0x03]))).toBe(2880); // code 3, 3 frames
    expect(opusPacketSamples48k(new Uint8Array([0xbb]))).toBeNull();
    expect(opusPacketSamples48k(new Uint8Array([]))).toBeNull();
  });

  it("rejects an empty stream", () => {
    expect(() => muxOggOpus([])).toThrow();
  });
});
