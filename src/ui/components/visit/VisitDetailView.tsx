import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, FileText, Mic, Square } from "lucide-react";
import type { VisitDetail } from "../../../contracts";
import { api } from "../../api";
import { Badge, Button, Card, ErrorNotice, Skeleton, Spinner, useToast } from "../../design";
import { hrefs } from "../../shell/routes";
import { LiveTranscript } from "./LiveTranscript";
import { waitForProcessing } from "./useVisitRecorder";

/**
 * A visit opened by link (#/visit/:id), e.g. after a reload mid-recording. This tab has no band
 * connection for it, so it can only show what was captured and finish (process) an open visit.
 */
export function VisitDetailView({ visitId }: { visitId: string }) {
  const toast = useToast();
  const [detail, setDetail] = useState<VisitDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [finishing, setFinishing] = useState<"idle" | "stopping" | "processing">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setErr(null);
    api
      .getVisit(visitId)
      .then((d) => mounted.current && setDetail(d))
      .catch((e) => mounted.current && setErr(e));
  }, [visitId]);
  useEffect(load, [load]);

  async function finish() {
    setFinishing("stopping");
    try {
      const res = await api.stopVisit(visitId);
      if (!mounted.current) return;
      setFinishing("processing");
      await waitForProcessing(res.sessionId, { isCancelled: () => !mounted.current });
      if (!mounted.current) return;
      toast.success("Visit sent for review", `${res.visit.segmentCount} transcript segment(s) captured.`);
      window.location.hash = hrefs.session(res.sessionId);
    } catch (e) {
      if (!mounted.current) return;
      setFinishing("idle");
      toast.error("Could not finish the visit", e instanceof Error ? e.message : undefined);
    }
  }

  if (err != null) return <ErrorNotice title="Couldn't load this visit" error={err} onRetry={load} />;
  if (!detail) {
    return (
      <Card padding="lg" aria-busy="true">
        <Skeleton width="40%" height={18} />
        <Skeleton lines={4} />
      </Card>
    );
  }

  const v = detail.visit;
  const open = v.status === "recording";
  return (
    <Card padding="lg" as="section" className="u2-section" aria-labelledby="rv-detail-h">
      <div className="u2-section-head">
        <span className="u2-section-ico">
          <FileText size={18} aria-hidden="true" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-between">
            <h2 className="u2-h2" id="rv-detail-h">
              Visit for {v.clientRef}
            </h2>
            <Badge tone={open ? "warning" : "success"} dot>
              {open ? "Still open" : "Stopped"}
            </Badge>
          </div>
          <p className="u2-muted">
            Started {new Date(v.startedAt).toLocaleString()} · {v.segmentCount} segment(s) · {v.packets} packets
            {v.lostPackets ? `, ${v.lostPackets} lost` : ""} ·{" "}
            {v.transcriber === "deepgram" ? "Deepgram" : "Simulated transcript"}
          </p>
        </div>
      </div>

      {open && (
        <p className="u2-note u2-note-warn">
          This visit was not finished: the page that recorded it was closed or reloaded. The band is not connected from here.
          Finish it to process what was transcribed, or record a new visit.
        </p>
      )}

      <LiveTranscript segments={detail.segments} interim="" live={false} />

      <div className="rv-actions">
        {open && (
          <Button
            variant="primary"
            icon={<Square size={15} />}
            loading={finishing !== "idle"}
            onClick={() => void finish()}
          >
            {finishing === "processing" ? "Processing…" : "Finish and process"}
          </Button>
        )}
        {!open && v.sessionId && (
          <a className="ds-btn ds-btn-primary ds-btn-md" href={hrefs.session(v.sessionId)}>
            <span className="ds-btn-label">Open session</span>
            <ArrowRight size={15} aria-hidden="true" />
          </a>
        )}
        <a className="ds-btn ds-btn-secondary ds-btn-md" href={hrefs.visit()}>
          <Mic size={15} aria-hidden="true" />
          <span className="ds-btn-label">Record a new visit</span>
        </a>
        {finishing === "processing" && <Spinner label="Processing" />}
      </div>
    </Card>
  );
}
