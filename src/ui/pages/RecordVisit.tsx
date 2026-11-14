import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Mic, ShieldCheck, Square, UserRound } from "lucide-react";
import type { CaptureStatus, ClientSummary } from "../../contracts";
import { api } from "../api";
import { Badge, Button, Card, Dialog, ErrorNotice, Field, PageHeader, Select, Skeleton, Spinner, useToast } from "../design";
import { BandPanel } from "../components/visit/BandPanel";
import { LiveTranscript } from "../components/visit/LiveTranscript";
import { VisitDetailView } from "../components/visit/VisitDetailView";
import { formatElapsed } from "../components/visit/protocol";
import { useVisitRecorder, type RecorderNotice } from "../components/visit/useVisitRecorder";
import { setNavigationGuard } from "../shell/navGuard";
import { hrefs } from "../shell/routes";
import "../components/settings/u2.css";
import "../components/visit/visit.css";

export default function RecordVisit({ visitId }: { visitId?: string }) {
  return (
    <div className="u2-page">
      <PageHeader
        eyebrow="Work"
        title="Record visit"
        subtitle="Record the visit with the client’s band. The transcript becomes the evidence for the session draft you review."
      />
      {visitId ? <VisitDetailView visitId={visitId} /> : <Recorder />}
    </div>
  );
}

function captureLabel(s: CaptureStatus): { tone: "info" | "fixture" | "danger"; text: string } {
  if (s.transcriber === "deepgram") return { tone: "info", text: "Live transcription (Deepgram)" };
  if (s.transcriber === "simulated") return { tone: "fixture", text: "Simulated transcript (dev, synthetic)" };
  return { tone: "danger", text: "Capture unavailable" };
}

function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
  return now;
}

function Recorder() {
  const toast = useToast();
  const onNotice = useCallback(
    (n: RecorderNotice) => toast.toast({ title: n.title, description: n.description, tone: n.tone }),
    [toast],
  );
  const { state, connect, disconnect, flash, start, stop } = useVisitRecorder({ onNotice });
  const { band, phase } = state;

  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [captureErr, setCaptureErr] = useState<unknown>(null);
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [clientsErr, setClientsErr] = useState<unknown>(null);
  const [clientRef, setClientRef] = useState("");
  const [consent, setConsent] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const bypassGuard = useRef(false);
  const ownHash = useRef(typeof window !== "undefined" ? window.location.hash || "#/visit" : "#/visit");

  const loadCapture = useCallback(() => {
    setCaptureErr(null);
    api.captureStatus().then(setCapture).catch(setCaptureErr);
  }, []);
  const loadClients = useCallback(() => {
    setClientsErr(null);
    api
      .listClients()
      .then((list) => {
        const active = list.filter((c) => c.client.active);
        setClients(active);
        setClientRef((cur) => (cur && active.some((c) => c.client.clientRef === cur) ? cur : active.length === 1 ? active[0]!.client.clientRef : cur));
      })
      .catch(setClientsErr);
  }, []);
  useEffect(loadCapture, [loadCapture]);
  useEffect(loadClients, [loadClients]);

  const busy = phase === "starting" || phase === "recording" || phase === "stopping";
  const micOn = phase === "recording" && band.phase === "connected";
  const now = useNow(phase === "recording");
  const elapsed = state.recordingSince ? now - state.recordingSince : 0;
  const deepgram = (state.transcriber ?? capture?.transcriber) === "deepgram";
  const openVisit = state.visit && (phase === "error" || busy) ? state.visit : null;

  // Show the visit's own URL while it is open (no hashchange, so this page stays mounted).
  // A reload then lands on #/visit/<id>, which can finish the visit.
  useEffect(() => {
    const id = state.visit?.id;
    if (!id || phase === "processing") return;
    const h = hrefs.visit(id);
    if (window.location.hash !== h) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${h}`);
    }
    ownHash.current = h;
  }, [state.visit?.id, phase]);

  // Leaving while recording: in-app links ask first (design Dialog); closing the tab gets the browser's warning.
  useEffect(() => {
    if (!busy) return;
    const offGuard = setNavigationGuard((target) => {
      if (bypassGuard.current) return true;
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${ownHash.current}`);
      setPendingNav(target || "#/");
      return false;
    });
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      offGuard();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [busy]);

  function leave(target: string) {
    bypassGuard.current = true;
    setPendingNav(null);
    window.location.hash = target;
  }

  const blockers = useMemo(() => {
    const out: string[] = [];
    if (!capture) out.push("checking transcription");
    else if (capture.transcriber === null) out.push("transcription is unavailable");
    if (!clientRef) out.push("choose a client");
    if (band.phase !== "connected") out.push("connect the band");
    if (!consent) out.push("confirm consent");
    return out;
  }, [capture, clientRef, band.phase, consent]);

  async function onStop() {
    const sessionId = await stop();
    if (!sessionId) return;
    toast.success("Visit recorded", "The transcript was handed to processing. Opening the session…");
    leave(hrefs.session(sessionId));
  }

  const cap = capture ? captureLabel(capture) : null;
  const selected = clients?.find((c) => c.client.clientRef === clientRef);

  return (
    <>
      <div className="rv-strip" aria-live="polite">
        {captureErr != null && <ErrorNotice title="Couldn't check transcription" error={captureErr} onRetry={loadCapture} />}
        {!capture && captureErr == null && <Skeleton width={220} height={26} radius={999} />}
        {cap && capture && (
          <>
            <Badge tone={cap.tone} dot>
              {cap.text}
            </Badge>
            {capture.reason && <span className="u2-muted u2-small">{capture.reason}</span>}
          </>
        )}
      </div>

      <div className="rv-grid">
        <div className="rv-col">
          <Card padding="lg" as="section" className="u2-section" aria-labelledby="rv-client-h">
            <div className="u2-section-head">
              <span className="u2-section-ico">
                <UserRound size={18} aria-hidden="true" />
              </span>
              <div>
                <h2 className="u2-h2" id="rv-client-h">
                  Client and consent
                </h2>
                <p className="u2-muted">The visit is filed under this client’s session for today.</p>
              </div>
            </div>

            {clientsErr != null && <ErrorNotice title="Couldn't load clients" error={clientsErr} onRetry={loadClients} />}
            {!clients && clientsErr == null && <Skeleton height={40} radius={10} />}
            {clients && clients.length === 0 && (
              <p className="u2-note">
                No active clients yet. <a href="#/clients">Add a client</a> first.
              </p>
            )}
            {clients && clients.length > 0 && (
              <Field label="Client" required>
                <Select
                  value={clientRef}
                  disabled={busy || phase === "processing"}
                  onChange={(e) => setClientRef(e.target.value)}
                  options={[
                    { value: "", label: "Choose a client…", disabled: true },
                    ...clients.map((c) => ({
                      value: c.client.clientRef,
                      label: c.client.displayName ? `${c.client.displayName} (${c.client.clientRef})` : c.client.clientRef,
                    })),
                  ]}
                />
              </Field>
            )}

            <label className="rv-consent" data-disabled={busy || undefined}>
              <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} required />
              <span>
                <strong>Everyone present knows this visit is being recorded and transcribed.</strong>
                {deepgram && <small>Audio is sent to Deepgram for transcription.</small>}
                {!deepgram && capture?.transcriber === "simulated" && (
                  <small>In this dev setup the transcript is synthetic; audio is not sent anywhere else.</small>
                )}
              </span>
            </label>
          </Card>

          <BandPanel
            band={band}
            micOn={micOn}
            locked={busy}
            onConnect={connect}
            onDisconnect={() => void disconnect()}
            onFlash={flash}
          />
        </div>

        <div className="rv-col">
          <Card padding="lg" as="section" className="u2-section" glow={phase === "recording"} aria-labelledby="rv-rec-h">
            <div className="u2-section-head">
              <span className="u2-section-ico">
                <Mic size={18} aria-hidden="true" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 className="u2-h2" id="rv-rec-h">
                  Recording
                </h2>
                <p className="u2-muted">
                  {selected
                    ? `For ${selected.client.displayName ?? selected.client.clientRef}.`
                    : "Choose a client, connect the band and confirm consent to start."}
                </p>
              </div>
            </div>

            {(busy || phase === "processing" || state.visit) && (
              <div className="rv-live">
                <span className="rv-timer" aria-label={`Elapsed ${formatElapsed(elapsed)}`}>
                  {formatElapsed(elapsed)}
                </span>
                <span className={micOn ? "rv-mic" : "rv-mic rv-mic-off"} role="status">
                  <span className="rv-mic-dot" aria-hidden="true" />
                  {micOn
                    ? "Mic on"
                    : phase === "starting"
                      ? "Starting…"
                      : band.phase === "reconnecting" && phase === "recording"
                        ? "Band reconnecting…"
                        : "Mic off"}
                </span>
                <span className="rv-counters">
                  <span>
                    <strong>{state.stats?.packets ?? state.sentPackets}</strong> packets
                  </span>
                  <span>
                    <strong>{state.stats?.lostPackets ?? 0}</strong> lost
                  </span>
                  <span>
                    <strong>{state.segments.length}</strong> lines
                  </span>
                </span>
              </div>
            )}

            {state.error && (
              <p className="u2-inline-error" role="alert">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>
                  {state.error.message} <span className="mono">({state.error.code})</span>
                </span>
              </p>
            )}

            {phase === "processing" && (
              <p className="u2-note" role="status">
                <Spinner size={14} /> Processing… preparing the session draft from the transcript.
              </p>
            )}

            <div className="rv-actions">
              {phase === "idle" && (
                <Button
                  variant="primary"
                  icon={<Mic size={16} />}
                  disabled={blockers.length > 0}
                  onClick={() => void start(clientRef)}
                >
                  Start recording
                </Button>
              )}
              {phase === "starting" && (
                <Button variant="primary" loading>
                  Starting…
                </Button>
              )}
              {(phase === "recording" || phase === "stopping" || (phase === "error" && openVisit)) && (
                <Button
                  variant="danger"
                  icon={<Square size={15} />}
                  loading={phase === "stopping"}
                  onClick={() => void onStop()}
                >
                  {phase === "stopping" ? "Stopping…" : phase === "error" ? "Stop and keep transcript" : "Stop visit"}
                </Button>
              )}
              {phase === "error" && !openVisit && (
                <Button variant="primary" icon={<Mic size={16} />} disabled={blockers.length > 0} onClick={() => void start(clientRef)}>
                  Try again
                </Button>
              )}
              {phase === "processing" && state.sessionId && (
                <a className="ds-btn ds-btn-secondary ds-btn-md" href={hrefs.session(state.sessionId)}>
                  <span className="ds-btn-label">Open session now</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </a>
              )}
            </div>
            {phase === "idle" && blockers.length > 0 && <p className="rv-why">To start: {blockers.join(", ")}.</p>}
            {phase === "idle" && blockers.length === 0 && (
              <p className="rv-why">
                <ShieldCheck size={12} aria-hidden="true" /> The band’s light turns solid blue while it records.
              </p>
            )}

            {(busy || state.segments.length > 0 || state.interim) && (
              <LiveTranscript segments={state.segments} interim={state.interim} live={phase === "recording"} />
            )}
          </Card>
        </div>
      </div>

      <Dialog
        open={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        title="Leave while recording?"
        description="Leaving this page turns the band’s microphone off and closes the stream. What was transcribed so far stays on the visit, and you can finish it later from this visit’s link."
        size="sm"
        footer={
          <>
            <Button variant="primary" onClick={() => setPendingNav(null)}>
              Keep recording
            </Button>
            <Button variant="danger" onClick={() => pendingNav && leave(pendingNav)}>
              Leave
            </Button>
          </>
        }
      />
    </>
  );
}
