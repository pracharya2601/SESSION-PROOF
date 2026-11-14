/**
 * One streaming connection for one visit (browser or native bridge). Socket-
 * agnostic: the route feeds it text/binary messages and gives it `send`.
 *
 * Timing: every segment is placed on the wall clock as
 *   audioStartMs (packet 0 of this connection, from the band clock) + engine seconds.
 * A bridge that reconnects opens a new CaptureSession; segment numbering continues
 * from what is already stored, and times restart from the new connection's start.
 */
import {
  VisitClientControl,
  type BandSegment,
  type Visit,
  type VisitServerMessage,
} from "../contracts";
import type { VisitStore } from "./store";
import { PACKET_SECONDS, type FinalPiece, type TranscriberEvents, type TranscriberSession } from "./transcriber";

/** Max bytes of one binary message: 2-byte seq + one Opus packet (the band's frames are far smaller). */
export const MAX_PACKET_BYTES = 1500;
/** A visit cannot stream longer than this (50 packets/s). */
export const MAX_PACKETS = 4 * 60 * 60 * 50;
const STATS_EVERY = 250;

export interface CaptureOptions {
  visit: Visit;
  store: VisitStore;
  openTranscriber: (events: TranscriberEvents) => Promise<TranscriberSession>;
  send: (msg: VisitServerMessage) => void;
  now: () => Date;
  /** Keeps background work alive (ctx.waitUntil in the Worker). */
  defer?: (p: Promise<unknown>) => void;
}

/** 2-byte big-endian seq header + Opus bytes. */
export function decodePacket(buf: Uint8Array): { seq: number; opus: Uint8Array } | null {
  if (buf.byteLength < 3 || buf.byteLength > MAX_PACKET_BYTES) return null;
  return { seq: (buf[0]! << 8) | buf[1]!, opus: buf.subarray(2) };
}

export class CaptureSession {
  private transcriber: TranscriberSession | null = null;
  private opening: Promise<void> | null = null;
  private audioStartMs: number | null = null;
  private prevSeq: number | null = null;
  private index = -1;
  private packets = 0;
  private lost = 0;
  private nextSegment = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private finished = false;

  constructor(private readonly o: CaptureOptions) {}

  /** Opens the transcriber and tells the client it may send audio. */
  async open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const existing = await this.o.store.listSegments(this.o.visit.id);
      this.nextSegment = existing.reduce((m, s) => Math.max(m, s.index), 0) + 1;
      this.transcriber = await this.o.openTranscriber({
        onInterim: (text) => this.o.send({ type: "interim", text: text.slice(0, 2000) }),
        onFinal: (p) => this.onFinal(p),
        onError: (code, message) => this.o.send({ type: "error", code, message }),
      });
      this.o.send({ type: "ready", transcriber: this.transcriber.kind });
    })();
    return this.opening;
  }

  /** Returns true when the session is finished and the socket should close. */
  async onText(raw: string): Promise<boolean> {
    if (raw.length > 4096) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    const c = VisitClientControl.safeParse(parsed);
    if (!c.success) {
      this.o.send({ type: "error", code: "bad_message", message: "Unknown control message." });
      return false;
    }
    switch (c.data.type) {
      case "start": {
        // First start fixes the timeline; a later start (band reconnected, seq back to 0) begins a new epoch.
        if (this.audioStartMs === null) {
          this.audioStartMs = c.data.audioStartMs;
          this.track(this.o.store.setAudioStarted(this.o.visit.id, new Date(c.data.audioStartMs).toISOString()));
        } else {
          // New run after a band reconnect: jump the packet timeline over the gap (never backwards).
          const atIndex = Math.floor((c.data.audioStartMs - this.audioStartMs) / (PACKET_SECONDS * 1000)) - 1;
          this.index = Math.max(this.index, atIndex);
        }
        this.prevSeq = null;
        return false;
      }
      case "keepalive":
        this.transcriber?.keepAlive();
        return false;
      case "stop":
        await this.finish();
        return true;
    }
  }

  onBinary(buf: Uint8Array): void {
    if (this.finished || !this.transcriber) return;
    if (this.audioStartMs === null) {
      this.o.send({ type: "error", code: "no_start", message: 'Send {"type":"start"} before audio.' });
      return;
    }
    const p = decodePacket(buf);
    if (!p) return;
    if (this.packets >= MAX_PACKETS) return;
    if (this.prevSeq === null) {
      this.index += 1;
    } else {
      const gap = (p.seq - this.prevSeq - 1 + 65536) % 65536;
      if (gap > 0 && gap < 3000) {
        this.lost += gap;
        this.index += gap + 1;
      } else if (gap === 0) {
        this.index += 1;
      } else {
        // Duplicate/reordered or a huge jump: treat as contiguous, never move time backwards.
        this.index += 1;
      }
    }
    this.prevSeq = p.seq;
    this.packets++;
    this.transcriber.feed(p.opus, this.index);
    if (this.packets % STATS_EVERY === 0) {
      this.o.send({ type: "stats", packets: this.packets, lostPackets: this.lost });
      this.track(this.o.store.updateStats(this.o.visit.id, this.packets + this.o.visit.packets, this.lost + this.o.visit.lostPackets));
    }
  }

  /** Socket closed without "stop": flush what the engine has, keep what was saved. */
  async onClose(): Promise<void> {
    if (this.finished) return;
    await this.finish(false);
  }

  private async finish(notify = true): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.transcriber) {
      if (notify) await this.transcriber.finish();
      else this.transcriber.close();
    }
    this.track(this.o.store.updateStats(this.o.visit.id, this.packets + this.o.visit.packets, this.lost + this.o.visit.lostPackets));
    await this.chain;
    if (notify) {
      const segs = await this.o.store.listSegments(this.o.visit.id);
      this.o.send({ type: "stats", packets: this.packets, lostPackets: this.lost });
      this.o.send({ type: "done", segmentCount: segs.length });
    }
  }

  private onFinal(p: FinalPiece): void {
    const base = this.audioStartMs ?? this.o.now().getTime();
    const from = base + Math.max(0, p.startSec) * 1000;
    const to = Math.max(from + PACKET_SECONDS * 1000, base + Math.max(0, p.endSec) * 1000);
    const segment: BandSegment = {
      id: `${this.o.visit.id}:${this.nextSegment}`,
      visitId: this.o.visit.id,
      index: this.nextSegment++,
      observedFrom: new Date(from).toISOString(),
      observedTo: new Date(to).toISOString(),
      speaker: p.speaker,
      text: p.text,
      sourceMode: this.transcriber?.kind === "deepgram" ? "live" : "fixture",
    };
    this.track(this.o.store.saveSegment(this.o.visit.providerId, segment, this.o.now().toISOString()));
    this.o.send({ type: "final", segment });
  }

  /** Serializes D1 writes so segments land in order, and keeps them alive. */
  private track(p: Promise<unknown>): void {
    this.chain = this.chain.then(() => p).catch(() => undefined);
    this.o.defer?.(this.chain);
  }
}
