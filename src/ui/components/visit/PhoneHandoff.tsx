import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangle, ArrowRight, Copy, Eye, EyeOff, Smartphone, Square } from "lucide-react";
import type { StartVisitResponse, VisitDetail } from "../../../contracts";
import { api } from "../../api";
import { Badge, Button, Spinner, useToast } from "../../design";
import { hrefs } from "../../shell/routes";
import { LiveTranscript } from "./LiveTranscript";
import { formatElapsed } from "./protocol";
import { glasscamLink, handoffFinished, streamHostIsLoopback } from "./handoff";
import { waitForProcessing } from "./useVisitRecorder";
import type { PhoneChoice } from "./BandPanel";

const POLL_MS = 3000;
const LATEST_LINES = 5;

type Phase = "idle" | "starting" | "waiting" | "stopping" | "processing";

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * "Record on iPhone (GlassCam)": start the visit here, hand its stream URL to the phone with a
 * QR code / deep link, then follow the visit by polling until the phone (or this page) stops it.
 */
export function PhoneHandoff({
  clientRef,
  choice,
  blockers,
  onActiveChange,
}: {
  clientRef: string;
  choice: PhoneChoice;
  /** Reasons the visit can't start yet (choose a client, consent…); empty = ready. */
  blockers: string[];
  /** True from Start until the visit is handed to processing (locks client, consent, method). */
  onActiveChange: (active: boolean) => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [started, setStarted] = useState<StartVisitResponse | null>(null);
  const [detail, setDetail] = useState<VisitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const finishing = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const active = phase !== "idle";
  useEffect(() => onActiveChange(active), [active, onActiveChange]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);

  const visit = detail?.visit ?? started?.visit ?? null;
  const link = started ? glasscamLink({ streamUrl: started.streamUrl, streamToken: started.streamToken, bandNumber: started.visit.bandNumber, clientRef: started.visit.clientRef }) : null;
  const loopback = started ? streamHostIsLoopback(started.streamUrl) : false;

  // QR code of the deep link (rendered locally; the link never leaves this page).
  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 240 })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQrFailed(true));
    return () => {
      cancelled = true;
    };
  }, [link]);

  // Show the visit's own URL so a reload can still finish it (#/visit/<id>).
  useEffect(() => {
    const id = started?.visit.id;
    if (!id || phase === "processing") return;
    const h = hrefs.visit(id);
    if (window.location.hash !== h) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${h}`);
    }
  }, [started?.visit.id, phase]);

  const finish = useCallback(
    async (sessionId: string, segmentCount: number) => {
      if (finishing.current) return;
      finishing.current = true;
      setSessionId(sessionId);
      setPhase("processing");
      await waitForProcessing(sessionId, { isCancelled: () => !mounted.current });
      if (!mounted.current) return;
      toast.success("Visit recorded", `${segmentCount} transcript line(s) captured. Opening the session…`);
      window.location.hash = hrefs.session(sessionId);
    },
    [toast],
  );

  // Follow the visit while the phone records.
  useEffect(() => {
    const id = started?.visit.id;
    if (!id || phase !== "waiting") return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.getVisit(id);
        if (stop || !mounted.current) return;
        setDetail(d);
        setPollFailed(false);
        const sessionId = handoffFinished(d.visit);
        if (sessionId) void finish(sessionId, d.visit.segmentCount);
      } catch {
        if (!stop && mounted.current) setPollFailed(true);
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [started?.visit.id, phase, finish]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  async function start() {
    setError(null);
    setPhase("starting");
    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      timezone = undefined;
    }
    try {
      const res = await api.startVisit({
        clientRef,
        bandNumber: choice.number,
        transport: "ble",
        ...(timezone ? { timezone } : {}),
      });
      if (!mounted.current) return;
      setStarted(res);
      setDetail(null);
      setPhase("waiting");
    } catch (e) {
      if (!mounted.current) return;
      setPhase("idle");
      setError(errText(e, "Could not start the visit."));
    }
  }

  async function stopHere() {
    if (!started) return;
    setPhase("stopping");
    try {
      const res = await api.stopVisit(started.visit.id);
      if (!mounted.current) return;
      setDetail((d) => (d ? { ...d, visit: res.visit } : d));
      await finish(res.sessionId, res.visit.segmentCount);
    } catch (e) {
      if (!mounted.current) return;
      setPhase("waiting");
      toast.error("Could not stop the visit", errText(e, ""));
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied", "Open it on the iPhone to hand the visit to GlassCam.");
    } catch {
      toast.error("Couldn't copy", "Your browser blocked the clipboard. Use Show link and copy it by hand.");
    }
  }

  if (!started || phase === "idle" || phase === "starting") {
    return (
      <>
        {error && (
          <p className="u2-inline-error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        <div className="rv-actions">
          <Button
            variant="primary"
            icon={<Smartphone size={16} />}
            loading={phase === "starting"}
            disabled={blockers.length > 0 || choice.numberError}
            onClick={() => void start()}
          >
            {phase === "starting" ? "Starting…" : "Start on phone"}
          </Button>
        </div>
        {blockers.length > 0 ? (
          <p className="rv-why">To start: {blockers.join(", ")}.</p>
        ) : (
          <p className="rv-why">Starts the visit here and shows a code for the iPhone to scan.</p>
        )}
      </>
    );
  }

  const streaming = !!visit && visit.packets > 0;
  const recording = visit?.status === "recording";
  const elapsed = visit ? Math.max(0, now - Date.parse(visit.startedAt)) : 0;
  const expires = new Date(started.streamTokenExpiresAt);
  const segments = detail?.segments ?? [];

  return (
    <div className="rv-handoff">
      {loopback && (
        <p className="u2-note u2-note-warn" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> Your phone can't reach localhost. Set PUBLIC_STREAM_ORIGIN in .dev.vars
          to ws://&lt;this Mac's LAN IP&gt;:8787 and run wrangler dev with --ip 0.0.0.0.
        </p>
      )}

      <div className="rv-handoff-main">
        <div className="rv-qr" aria-label="QR code for GlassCam">
          {qr ? (
            <img src={qr} width={240} height={240} alt="QR code: open this visit in GlassCam" />
          ) : qrFailed ? (
            <span className="u2-muted u2-small">QR code unavailable. Use Copy link.</span>
          ) : (
            <Spinner size={18} />
          )}
        </div>
        <div className="rv-handoff-steps">
          <ol className="rv-steps">
            <li>Open the iPhone camera and scan the code (or open the copied link on the phone).</li>
            <li>GlassCam opens, connects to band {started.visit.bandNumber ?? "(choose in the app)"} and starts streaming.</li>
            <li>Stop on the phone when the visit ends. This page opens the session draft.</li>
          </ol>
          <div className="rv-actions">
            <Button size="sm" icon={<Copy size={15} />} onClick={() => void copyLink()}>
              Copy link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={showLink ? <EyeOff size={15} /> : <Eye size={15} />}
              aria-expanded={showLink}
              onClick={() => setShowLink((s) => !s)}
            >
              {showLink ? "Hide link" : "Show link"}
            </Button>
          </div>
        </div>
      </div>

      {showLink && link && (
        <div className="rv-secret">
          <p className="u2-note u2-note-warn">
            <AlertTriangle size={15} aria-hidden="true" /> This link is a secret: anyone with it can stream audio into this visit
            and stop it until {expires.toLocaleString()}. Don't paste it into chats, tickets or logs.
          </p>
          <code className="mono rv-secret-link">{link}</code>
        </div>
      )}

      <div className="rv-live">
        <span className="rv-timer" aria-label={`Elapsed ${formatElapsed(elapsed)}`}>
          {formatElapsed(elapsed)}
        </span>
        <Badge tone={!recording ? "success" : streaming ? "info" : "warning"} dot>
          {!recording ? "Stopped" : streaming ? "Phone streaming" : "Waiting for the phone"}
        </Badge>
        <span className="rv-counters" aria-live="polite">
          <span>
            <strong>{visit?.packets ?? 0}</strong> packets
          </span>
          <span>
            <strong>{visit?.lostPackets ?? 0}</strong> lost
          </span>
          <span>
            <strong>{visit?.segmentCount ?? 0}</strong> lines
          </span>
        </span>
      </div>

      {pollFailed && <p className="rv-why">Couldn't refresh the visit status; retrying every few seconds.</p>}

      {phase === "processing" ? (
        <p className="u2-note" role="status">
          <Spinner size={14} /> Processing… preparing the session draft from the transcript.
        </p>
      ) : (
        <div className="rv-actions">
          <Button variant="danger" icon={<Square size={15} />} loading={phase === "stopping"} onClick={() => void stopHere()}>
            {phase === "stopping" ? "Stopping…" : "Stop from here"}
          </Button>
          <span className="rv-why">Use this if the phone is gone. Stop on the phone first if you can.</span>
        </div>
      )}
      {phase === "processing" && sessionId && (
        <div className="rv-actions">
          <a className="ds-btn ds-btn-secondary ds-btn-md" href={hrefs.session(sessionId)}>
            <span className="ds-btn-label">Open session now</span>
            <ArrowRight size={15} aria-hidden="true" />
          </a>
        </div>
      )}

      <LiveTranscript segments={segments.slice(-LATEST_LINES)} interim="" live={recording && phase === "waiting"} />
    </div>
  );
}
