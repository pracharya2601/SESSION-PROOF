/**
 * Speech-to-text behind one small interface. Times are seconds from the start
 * of the band audio stream (packet seq 0).
 *
 * - deepgram: Deepgram live streaming (nova-3) with the Vexo kit's settings for
 *   the band's Opus packets, plus diarize=true so speakers are told apart.
 *   `mip_opt_out=true`: Deepgram does not keep the audio for model training.
 * - simulated: dev only. Plays a SYNTHETIC script (the default visit, or a dev
 *   scenario from fixtures/band) as audio arrives, labelled fixture. Lets the
 *   pretend band run the whole pipeline with no key.
 */
import type { Transcriber } from "../contracts";
import type { ScenarioLine } from "../../fixtures/band/types";

export interface FinalPiece {
  startSec: number;
  endSec: number;
  text: string;
  /** Exactly as the engine labelled it, or null. */
  speaker: string | null;
}

export interface TranscriberEvents {
  onInterim(text: string): void;
  onFinal(piece: FinalPiece): void;
  onError(code: string, message: string): void;
}

export interface TranscriberSession {
  readonly kind: Transcriber;
  /** One Opus packet (20 ms) with its band seq, already unwrapped to a running index. */
  feed(opus: Uint8Array, packetIndex: number): void;
  keepAlive(): void;
  /** Flush everything pending; resolves when the last final has been emitted. */
  finish(): Promise<void>;
  /** Hard stop (socket gone). */
  close(): void;
}

export const PACKET_SECONDS = 0.02;

// ------------------------------------------------------------------ deepgram
export const DEEPGRAM_LISTEN_URL =
  "https://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=opus&sample_rate=16000&channels=1" +
  "&interim_results=true&smart_format=true&endpointing=100&utterance_end_ms=1000&diarize=true&mip_opt_out=true";

interface DgWord {
  word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}
interface DgResults {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: { transcript?: string; words?: DgWord[] }[] };
}

/** Most frequent speaker among the words, as Deepgram numbers them. */
function speakerOf(words: DgWord[]): string | null {
  const counts = new Map<number, number>();
  for (const w of words) if (typeof w.speaker === "number") counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  let best: number | null = null;
  let n = 0;
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c];
  return best === null ? null : `Speaker ${best}`;
}

/**
 * Accumulates Deepgram "is_final" pieces into one utterance and emits it when the
 * speaker pauses (speech_final / UtteranceEnd) or at the end. Pure: testable without sockets.
 */
export class DeepgramAssembler {
  private parts: { start: number; end: number; text: string; words: DgWord[] }[] = [];
  constructor(private readonly events: TranscriberEvents) {}

  handle(raw: string): void {
    let msg: DgResults;
    try {
      msg = JSON.parse(raw) as DgResults;
    } catch {
      return;
    }
    if (msg.type === "UtteranceEnd") return this.flush();
    if (msg.type !== "Results") return;
    const alt = msg.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (!msg.is_final) {
      if (text) this.events.onInterim([...this.parts.map((p) => p.text), text].join(" "));
      return;
    }
    if (text) {
      const start = Number(msg.start ?? 0);
      this.parts.push({ start, end: start + Number(msg.duration ?? 0), text, words: alt?.words ?? [] });
    }
    if (msg.speech_final) this.flush();
  }

  flush(): void {
    if (this.parts.length === 0) return;
    const parts = this.parts;
    this.parts = [];
    this.events.onFinal({
      startSec: parts[0]!.start,
      endSec: parts[parts.length - 1]!.end,
      text: parts.map((p) => p.text).join(" ").slice(0, 4000),
      speaker: speakerOf(parts.flatMap((p) => p.words)),
    });
  }
}

export async function openDeepgram(
  apiKey: string,
  events: TranscriberEvents,
  fetchFn: typeof fetch = fetch,
): Promise<TranscriberSession> {
  const res = await fetchFn(DEEPGRAM_LISTEN_URL, { headers: { Upgrade: "websocket", Authorization: `Token ${apiKey}` } });
  const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket;
  if (!ws) {
    // Status only: never echo what the service wrote (it can include request details).
    throw new TranscriberError(res.status === 401 ? "deepgram_auth" : "deepgram_unavailable", `Deepgram refused the connection (status ${res.status}).`);
  }
  (ws as WebSocket & { accept?: () => void }).accept?.();
  const assembler = new DeepgramAssembler(events);
  let closed = false;
  let onClosed: (() => void) | null = null;
  ws.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") assembler.handle(e.data);
  });
  ws.addEventListener("close", () => {
    closed = true;
    assembler.flush();
    onClosed?.();
  });
  ws.addEventListener("error", () => events.onError("deepgram_stream", "The transcription stream failed."));

  return {
    kind: "deepgram",
    feed(opus) {
      if (!closed) ws.send(opus);
    },
    keepAlive() {
      if (!closed) ws.send(JSON.stringify({ type: "KeepAlive" }));
    },
    finish() {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          assembler.flush();
          try {
            ws.close(1000, "done");
          } catch {
            /* already closing */
          }
          resolve();
        }, 8000);
        onClosed = () => {
          clearTimeout(timer);
          resolve();
        };
        // "Send me the rest, then hang up."
        ws.send(JSON.stringify({ type: "CloseStream" }));
      });
    },
    close() {
      if (closed) return;
      closed = true;
      assembler.flush();
      try {
        ws.close(1000, "client gone");
      } catch {
        /* ignore */
      }
    },
  };
}

export class TranscriberError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TranscriberError";
  }
}

// ------------------------------------------------------------------ simulated (dev)
/** SYNTHETIC visit script (same lines as the canonical fixture transcript), one line per 3 s of audio. */
export const SIMULATED_SCRIPT: ScenarioLine[] = [
  "Today we will practice planning the bus route to the library.",
  "I found the route and the transfer stop on this map.",
  "We also reviewed the weekly food budget together.",
  "I will bring another route-planning worksheet next time.",
  "We are finishing the practice for today.",
].map((text, i) => ({ atSec: i * 3, durationSec: 3, speaker: i === 1 ? "Participant" : "Provider", text }));
/** One default-script line per 3 seconds of audio. */
export const SIMULATED_PACKETS_PER_LINE = 150;
/** An interim partial for the next line every this many packets (0.5 s). */
const INTERIM_EVERY = 25;

/**
 * Plays a script: each line is emitted as a final once the received audio reaches
 * `line.atSec` (packetIndex * 20 ms >= atSec), timed [atSec, atSec + durationSec].
 * Interim partials of the next line show while approaching it. finish() emits every
 * remaining line (a short recording still gets the whole script). Empty script: nothing.
 */
export function openSimulated(events: TranscriberEvents, script: ScenarioLine[] = SIMULATED_SCRIPT): TranscriberSession {
  const lines = [...script].sort((a, b) => a.atSec - b.atSec);
  let emitted = 0;
  const emitNext = () => {
    const line = lines[emitted++]!;
    events.onFinal({ startSec: line.atSec, endSec: line.atSec + line.durationSec, text: line.text, speaker: line.speaker });
  };
  return {
    kind: "simulated",
    feed(_opus, packetIndex) {
      const sec = packetIndex * PACKET_SECONDS;
      while (emitted < lines.length && sec >= lines[emitted]!.atSec) emitNext();
      if (emitted < lines.length && packetIndex % INTERIM_EVERY === 0) {
        const line = lines[emitted]!;
        const from = emitted > 0 ? lines[emitted - 1]!.atSec : 0;
        const span = line.atSec - from;
        const frac = span > 0 ? Math.min(1, Math.max(0, (sec - from) / span)) : 1;
        const words = line.text.split(" ");
        events.onInterim(words.slice(0, Math.max(1, Math.ceil(words.length * frac))).join(" "));
      }
    },
    keepAlive() {},
    async finish() {
      while (emitted < lines.length) emitNext();
    },
    close() {},
  };
}
