import { motion } from "framer-motion";
import { AlertTriangle, ArrowLeft, CalendarClock } from "lucide-react";
import type { Appointment, BundleProvenance, SessionRecord } from "../../../contracts";
import { Badge, Button, StatusPill } from "../../design";
import { formatInstant } from "./format";
import { RevisionBadge } from "./RevisionBadge";
import { rvItem, rvItemReduced, useMotionOK } from "./motion";

export function SessionHeader(props: {
  appointment: Appointment;
  session: SessionRecord;
  revision: number | null;
  provenance: BundleProvenance | null;
  serviceDescription?: string;
  onBack: () => void;
}) {
  const { appointment: a, session, revision, provenance } = props;
  const ok = useMotionOK();
  return (
    <motion.header className="rv-hero" variants={ok ? rvItem : rvItemReduced}>
      <div className="rv-hero-glow" aria-hidden="true" />
      <div className="rv-hero-top">
        <Button variant="ghost" size="sm" onClick={props.onBack} icon={<ArrowLeft size={16} />}>
          Back to sessions
        </Button>
      </div>
      <div className="rv-hero-main">
        <div className="rv-hero-text">
          <p className="rv-eyebrow">Session review</p>
          <h1 className="rv-title">Client {a.clientRef}</h1>
          <p className="rv-hero-sub">
            {a.serviceCode}
            {props.serviceDescription ? ` — ${props.serviceDescription}` : ""}
          </p>
          <p className="rv-hero-when">
            <CalendarClock size={15} aria-hidden="true" />
            Scheduled {formatInstant(a.startAt, a.timezone)} – {formatInstant(a.endAt, a.timezone, false)}{" "}
            <span className="rv-muted">({a.timezone})</span>
          </p>
        </div>
        <div className="rv-hero-meta">
          <StatusPill status={session.status} layoutId="rv-status-pill" />
          {revision !== null && <RevisionBadge revision={revision} />}
        </div>
      </div>
      {provenance && (
        <div className="rv-hero-modes">
          <Badge tone={provenance.evidenceMode === "fixture" ? "fixture" : "info"} title="Evidence source mode">
            Evidence: {provenance.evidenceMode}
          </Badge>
          <Badge tone={provenance.extractionMode === "fixture" ? "fixture" : "info"} title="Extraction mode">
            Extraction: {provenance.extractionMode}
          </Badge>
          <Badge tone="neutral" title="Runtime mode">
            Runtime: {provenance.runtimeMode}
          </Badge>
        </div>
      )}
      {session.statusReason && <p className="rv-muted rv-status-reason">{session.statusReason}</p>}
      {provenance && (provenance.evidenceCompleteness !== "complete" || provenance.evidenceWarnings.length > 0) && (
        <div className="rv-warn-box">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            {provenance.evidenceCompleteness !== "complete" && (
              <p className="rv-warn">Evidence completeness: {provenance.evidenceCompleteness}</p>
            )}
            {provenance.evidenceWarnings.length > 0 && (
              <ul className="rv-warn-list">
                {provenance.evidenceWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </motion.header>
  );
}
