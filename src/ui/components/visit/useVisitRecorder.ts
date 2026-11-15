/**
 * Band + stream logic for the Record visit page, kept apart from rendering.
 *
 * Flow: connect (inside a click) → start: POST /api/visits → WebSocket(streamUrl) → "ready" →
 * band.on('audio') → band.configure({ audio: true }). Each audio packet becomes one binary
 * frame [u16 BE seq][opus]; the {"type":"start"} control goes out before the first frame of
 * every audio run. Stop: audio off → {"type":"stop"} → wait for "done" (10 s) → close →
 * POST /api/visits/:id/stop → wait for the session to leave QUEUED/PROCESSING (30 s).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BandSegment, SessionDetail, Transcriber, Visit } from "../../../contracts";
import { api } from "../../api";
import { Band, oggPackets, SimTransport, type AudioEvent } from "../../vendor/vexo-open/index.js";
import { encodeAudioFrame, mergeSegment, parseServerMessage, processingSettled, startControl } from "./protocol";


/** WebSocket subprotocols for a stream: `vfa-stream` (echoed) + the token (docs/band-bridge.md §1). */
export function streamProtocols(token: string): string[] {
  return ["vfa-stream", `vfa-token.${token}`];
}

export type ConnectMethod = "ble" | "serial" | "sim";
export type BandPhase = "idle" | "connecting" | "connected" | "reconnecting";
export type RecPhase = "idle" | "starting" | "recording" | "stopping" | "processing" | "error";

export interface BandView {
  phase: BandPhase;
  method: ConnectMethod | null;
  name: string | null;
  number: number | null;
  firmware: string | null;
  battery: { percent: number; charging: boolean } | null;
  /** Pretend band without its voice file: it streams silence. */
  silent: boolean;
  error: string | null;
}

export interface RecorderState {
  band: BandView;
  phase: RecPhase;
  visit: Visit | null;
  transcriber: Transcriber | null;
  segments: BandSegment[];
  interim: string;
  /** From the server's "stats" messages. */
  stats: { packets: number; lostPackets: number } | null;
  /** Frames this tab has sent (updated about once a second). */
  sentPackets: number;
  /** Date.now() when the microphone went on. */
  recordingSince: number | null;
  /** Inline error for the recording (server "error", stream closed, start/stop failures). */
  error: { code: string; message: string } | null;
  /** The visit was stopped; processing is running for this session. */
  sessionId: string | null;
}

export interface RecorderNotice {
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  description?: string;
}

const READY_TIMEOUT_MS = 15_000;
const DONE_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 5_000;
const PROCESSING_TIMEOUT_MS = 30_000;
const POLL_MS = 1_500;
const VOICE_URL = "/sample-speech.opus";

const IDLE_BAND: BandView = {
  phase: "idle",
  method: null,
  name: null,
  number: null,
  firmware: null,
  battery: null,
  silent: false,
  error: null,
};

const INITIAL: RecorderState = {
  band: IDLE_BAND,
  phase: "idle",
  visit: null,
  transcriber: null,
  segments: [],
  interim: "",
  stats: null,
  sentPackets: 0,
  recordingSince: null,
  error: null,
  sessionId: null,
};

let voiceCache: Promise<Uint8Array[]> | null = null;

/** The pretend band's voice: the kit's public-domain sample, served from src/ui/public. */
function loadVoice(): Promise<Uint8Array[]> {
  voiceCache ??= fetch(VOICE_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => oggPackets(new Uint8Array(b)))
    .catch((e) => {
      voiceCache = null;
      throw e;
    });
  return voiceCache;
}

export function bandErrorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "Something went wrong talking to the band.";
}

function errorCode(e: unknown, fallback: string): string {
  return e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string"
    ? (e as { code: string }).code
    : fallback;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls the session until processing has settled (NEEDS_REVIEW, FAILED, …) or the timeout passes.
 * Returns the last detail seen (null if none could be read). Review does not poll QUEUED/PROCESSING itself.
 */
export async function waitForProcessing(
  sessionId: string,
  opts: { timeoutMs?: number; isCancelled?: () => boolean } = {},
): Promise<SessionDetail | null> {
  const until = Date.now() + (opts.timeoutMs ?? PROCESSING_TIMEOUT_MS);
  let last: SessionDetail | null = null;
  while (!opts.isCancelled?.()) {
    try {
      last = await api.getSession(sessionId);
      if (processingSettled(last.session.status)) return last;
    } catch {
      /* the session may not be readable for a moment; keep polling */
    }
    if (Date.now() + POLL_MS > until) break;
    await sleep(POLL_MS);
  }
  return last;
}

export function useVisitRecorder(opts: { onNotice?: (n: RecorderNotice) => void } = {}) {
  const [state, setState] = useState<RecorderState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const noticeRef = useRef(opts.onNotice);
  noticeRef.current = opts.onNotice;

  const mounted = useRef(true);
  const bandRef = useRef<Band | null>(null);
  const bandOffs = useRef<(() => void)[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const audioOff = useRef<(() => void) | null>(null);
  const startSent = useRef(false);
  const lastSend = useRef(0);
  const sentCount = useRef(0);
  const timer = useRef<number | null>(null);
  const doneWaiter = useRef<(() => void) | null>(null);
  const stopping = useRef(false);

  const patch = useCallback((p: Partial<RecorderState> | ((s: RecorderState) => Partial<RecorderState>)) => {
    if (!mounted.current) return;
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);
  const patchBand = useCallback(
    (p: Partial<BandView>) => patch((s) => ({ band: { ...s.band, ...p } })),
    [patch],
  );
  const notify = (n: RecorderNotice) => noticeRef.current?.(n);

  // ------------------------------------------------------------------ stream teardown
  const stopTimer = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };

  const detachAudio = () => {
    audioOff.current?.();
    audioOff.current = null;
  };

  const closeSocket = (code = 1000) => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(code);
    } catch {
      /* already closed */
    }
  };

  const releaseBandListeners = () => {
    for (const off of bandOffs.current) off();
    bandOffs.current = [];
  };

  // Unmount: best effort to leave the band and the stream in a clean state. The visit stays open
  // on the server (status "recording") and can be finished from #/visit/<id>.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTimer();
      const band = bandRef.current;
      bandRef.current = null;
      if (audioOff.current) {
        detachAudio();
        band?.configure({ audio: false }).catch(() => {});
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "stop" }));
        } catch {
          /* ignore */
        }
      }
      closeSocket();
      releaseBandListeners();
      band?.disconnect().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ band
  /**
   * Must be called straight from a click handler: for Bluetooth and USB, Band.connect opens the
   * browser's chooser, which needs the click's user activation, so nothing is awaited before it.
   */
  const connect = useCallback(
    (number: number | null, method: ConnectMethod) => {
      if (bandRef.current || stateRef.current.band.phase === "connecting") return;
      patch({ band: { ...IDLE_BAND, phase: "connecting", method } });
      let silent = false;
      // autoReconnect: a dropped link (out of range for a moment) is repaired by the library, which
      // turns the microphone back on by itself. For the USB cable it re-opens the port without a click.
      const pending: Promise<Band> =
        method === "sim"
          ? loadVoice()
              .catch(() => {
                silent = true;
                return null;
              })
              .then((audioPackets) =>
                Band.connect(number ?? 42, {
                  transport: new SimTransport(number ?? 42, { audioPackets }),
                  autoReconnect: true,
                }),
              )
          : Band.connect(number, { transport: method, autoReconnect: true });

      pending
        .then(async (band) => {
          if (!mounted.current) {
            await band.disconnect().catch(() => {});
            return;
          }
          bandRef.current = band;
          bandOffs.current = [
            band.on("battery", (b) => patchBand({ battery: { percent: b.percent, charging: b.charging } })),
            band.on("reconnecting", (e) => {
              patchBand({ phase: "reconnecting" });
              notify({
                tone: "warning",
                title: "Band link dropped",
                description: e.message ?? `Reconnecting for up to ${Math.round(e.seconds)} s. Keep the band close.`,
              });
            }),
            band.on("reconnected", () => {
              // The library has turned the microphone back on. Band seq restarts at 0 and the audio
              // `time` belongs to the new run, so the next packet must be preceded by a fresh
              // {"type":"start"} with the new audioStartMs (see the audio handler).
              startSent.current = false;
              patchBand({ phase: "connected" });
              notify({ tone: "success", title: "Band reconnected" });
            }),
            band.on("disconnect", (e) => {
              const wasStreaming = audioOff.current !== null;
              releaseBandListeners();
              bandRef.current = null;
              detachAudio();
              patch({ band: { ...IDLE_BAND, method: stateRef.current.band.method } });
              if (e.reason !== "closed") {
                const message =
                  e.reason === "lost"
                    ? e.reconnect === "gave-up"
                      ? "The band did not come back within the reconnect window."
                      : "The band link was lost."
                    : e.message ?? `The band disconnected (${e.reason}).`;
                notify({ tone: "danger", title: "Band disconnected", description: message });
                if (wasStreaming) patch({ error: { code: "BAND_DISCONNECTED", message: `${message} Stop to keep what was transcribed.` } });
              }
            }),
            band.on("notice", (n) => {
              if (n.kind === "low-battery") notify({ tone: "warning", title: "Band battery is low" });
              else if (n.kind === "critical-battery") notify({ tone: "danger", title: "Band battery is empty", description: "Charge the band." });
              else if (n.kind === "stream-dropped") notify({ tone: "warning", title: "The link could not keep up", description: "Some audio may be missing." });
            }),
          ];
          patchBand({
            phase: "connected",
            name: band.name,
            number: band.number,
            firmware: band.info?.firmware ?? null,
            silent,
          });
          try {
            await band.configure({ battery: true });
          } catch {
            /* battery stream is a nicety */
          }
        })
        .catch((e) => {
          patch({ band: { ...IDLE_BAND, method, error: bandErrorText(e) } });
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, patchBand],
  );

  const disconnect = useCallback(async () => {
    const band = bandRef.current;
    if (!band) return;
    try {
      await band.disconnect(); // fires 'disconnect' (reason "closed"), which resets the view
    } catch {
      releaseBandListeners();
      bandRef.current = null;
      patch({ band: IDLE_BAND });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);

  /** Blinks the band white for 5 s. Not possible while the microphone is on (LED locked blue). */
  const flash = useCallback(async () => {
    const band = bandRef.current;
    if (!band) return;
    try {
      await band.identify(5);
    } catch (e) {
      notify({ tone: "warning", title: "Could not flash the light", description: bandErrorText(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ recording
  const onAudio = useCallback((a: AudioEvent) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!startSent.current) {
      // First packet of an audio run (recording start, or after a band reconnect): the start
      // control must reach the server before this run's first binary frame.
      ws.send(startControl(a.time));
      startSent.current = true;
    }
    ws.send(encodeAudioFrame(a.seq, a.opus));
    lastSend.current = Date.now();
    sentCount.current += 1;
  }, []);

  const failRecording = useCallback(
    (code: string, message: string) => {
      stopTimer();
      patch({ phase: "error", error: { code, message }, interim: "" });
    },
    [patch],
  );

  const start = useCallback(
    async (clientRef: string) => {
      const band = bandRef.current;
      const s = stateRef.current;
      if (!band || s.band.phase !== "connected" || (s.phase !== "idle" && s.phase !== "error")) return;
      const method = s.band.method ?? "ble";
      stopping.current = false;
      startSent.current = false;
      sentCount.current = 0;
      patch({ ...INITIAL, band: s.band, phase: "starting" });

      let streamUrl: string;
      let streamToken: string;
      try {
        let timezone: string | undefined;
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
        } catch {
          timezone = undefined;
        }
        const res = await api.startVisit({
          clientRef,
          bandNumber: method === "sim" ? null : band.number,
          transport: method,
          ...(timezone ? { timezone } : {}),
        });
        streamUrl = res.streamUrl;
        streamToken = res.streamToken;
        patch({ visit: res.visit, transcriber: res.visit.transcriber });
      } catch (e) {
        patch({ phase: "idle", error: { code: errorCode(e, "START_FAILED"), message: bandErrorText(e) } });
        return;
      }
      if (!mounted.current) return;

      let ws: WebSocket;
      try {
        // The token rides in Sec-WebSocket-Protocol, never in the URL (Cloudflare logs URLs);
        // the server echoes "vfa-stream".
        ws = new WebSocket(streamUrl, streamProtocols(streamToken));
      } catch (e) {
        failRecording("STREAM_FAILED", bandErrorText(e));
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      let readyResolve: (() => void) | null = null;
      let readyReject: ((e: Error) => void) | null = null;
      const ready = new Promise<void>((res, rej) => {
        readyResolve = res;
        readyReject = rej;
      });

      ws.onmessage = (ev) => {
        const m = parseServerMessage(ev.data);
        if (!m) return;
        switch (m.type) {
          case "ready":
            patch({ transcriber: m.transcriber });
            readyResolve?.();
            break;
          case "interim":
            patch({ interim: m.text });
            break;
          case "final":
            patch((st) => ({ segments: mergeSegment(st.segments, m.segment), interim: "" }));
            break;
          case "stats":
            patch({ stats: { packets: m.packets, lostPackets: m.lostPackets } });
            break;
          case "error":
            patch({ error: { code: m.code, message: m.message } });
            notify({ tone: "danger", title: "Transcription problem", description: `${m.message} (${m.code})` });
            readyReject?.(new Error(m.message));
            break;
          case "done":
            doneWaiter.current?.();
            break;
        }
      };
      ws.onerror = () => {
        /* a close event follows with the details */
      };
      ws.onclose = (ev) => {
        wsRef.current = null;
        detachAudio();
        doneWaiter.current?.();
        readyReject?.(new Error(ev.reason || "The stream closed before it was ready."));
        if (!stopping.current && mounted.current) {
          const message = `The stream to the server closed${ev.reason ? `: ${ev.reason}` : ""}. Stop to keep what was transcribed.`;
          bandRef.current?.configure({ audio: false }).catch(() => {});
          failRecording("STREAM_CLOSED", message);
          notify({ tone: "danger", title: "Stream closed", description: message });
        }
      };

      try {
        await Promise.race([
          ready,
          sleep(READY_TIMEOUT_MS).then(() => {
            throw new Error("The server did not get ready in time.");
          }),
        ]);
      } catch (e) {
        if (wsRef.current === ws) {
          closeSocket();
          failRecording("STREAM_NOT_READY", bandErrorText(e));
        }
        return;
      }
      readyResolve = null;
      readyReject = null;
      if (!mounted.current || wsRef.current !== ws) return;

      const b = bandRef.current;
      if (!b) {
        closeSocket();
        failRecording("BAND_DISCONNECTED", "The band disconnected before the microphone went on.");
        return;
      }
      audioOff.current = b.on("audio", onAudio);
      try {
        await b.configure({ audio: true });
      } catch (e) {
        detachAudio();
        closeSocket();
        failRecording(errorCode(e, "MIC_FAILED"), bandErrorText(e));
        return;
      }
      lastSend.current = Date.now();
      patch({ phase: "recording", recordingSince: Date.now(), error: null });
      stopTimer();
      timer.current = window.setInterval(() => {
        const sock = wsRef.current;
        if (sock && sock.readyState === WebSocket.OPEN && Date.now() - lastSend.current >= KEEPALIVE_MS) {
          sock.send(JSON.stringify({ type: "keepalive" }));
          lastSend.current = Date.now();
        }
        const n = sentCount.current;
        patch((st) => (st.sentPackets === n ? {} : { sentPackets: n }));
      }, 1000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, failRecording, onAudio],
  );

  /**
   * Stops the microphone, flushes the stream and hands the visit to processing.
   * Resolves with the session id once processing settled (or after 30 s), or null on failure.
   * Safe to call again after a failure (e.g. the stop request failed): it skips what is done.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    const s = stateRef.current;
    const visit = s.visit;
    if (!visit || s.phase === "stopping" || s.phase === "processing") return null;
    stopping.current = true;
    stopTimer();
    patch({ phase: "stopping" });

    const band = bandRef.current;
    if (band && audioOff.current) {
      try {
        await band.configure({ audio: false });
      } catch {
        /* reconnecting or gone; the stream ends anyway */
      }
    }
    detachAudio();

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const done = new Promise<void>((res) => {
        doneWaiter.current = res;
      });
      try {
        ws.send(JSON.stringify({ type: "stop" }));
        await Promise.race([done, sleep(DONE_TIMEOUT_MS)]);
      } catch {
        /* closed under us */
      }
      doneWaiter.current = null;
    }
    closeSocket();
    patch({ interim: "", sentPackets: sentCount.current });

    let sessionId: string;
    try {
      const res = await api.stopVisit(visit.id);
      sessionId = res.sessionId;
      patch({ visit: res.visit, phase: "processing", sessionId });
    } catch (e) {
      stopping.current = false;
      patch({ phase: "error", error: { code: errorCode(e, "STOP_FAILED"), message: bandErrorText(e) } });
      notify({ tone: "danger", title: "Could not finish the visit", description: bandErrorText(e) });
      return null;
    }
    await waitForProcessing(sessionId, { isCancelled: () => !mounted.current });
    return sessionId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);

  return { state, connect, disconnect, flash, start, stop };
}

export type VisitRecorder = ReturnType<typeof useVisitRecorder>;
