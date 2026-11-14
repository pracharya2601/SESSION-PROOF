import type { Appointment, BundleProvenance, SessionRecord } from "../../../contracts";
import { formatInstant } from "./format";

export function SessionHeader(props: {
  appointment: Appointment;
  session: SessionRecord;
  revision: number | null;
  provenance: BundleProvenance | null;
  serviceDescription?: string;
}) {
  const { appointment: a, session, revision, provenance } = props;
  return (
    <header className="card rv-header">
      <div className="rv-header-main">
        <h1 className="rv-title">Client {a.clientRef}</h1>
        <div className="muted">
          {a.serviceCode}
          {props.serviceDescription ? ` — ${props.serviceDescription}` : ""}
        </div>
        <div>
          Scheduled {formatInstant(a.startAt, a.timezone)} – {formatInstant(a.endAt, a.timezone, false)}{" "}
          <span className="muted">({a.timezone})</span>
        </div>
      </div>
      <div className="rv-header-meta row">
        <span className={`badge chip-${session.status}`}>{session.status.replace(/_/g, " ")}</span>
        {revision !== null && <span className="badge">Revision {revision}</span>}
        {provenance && (
          <>
            <span className="badge rv-mode" title="Evidence source mode">Evidence: {provenance.evidenceMode}</span>
            <span className="badge rv-mode" title="Extraction mode">Extraction: {provenance.extractionMode}</span>
            <span className="badge rv-mode" title="Runtime mode">Runtime: {provenance.runtimeMode}</span>
          </>
        )}
      </div>
      {session.statusReason && <p className="muted rv-status-reason">{session.statusReason}</p>}
      {provenance && provenance.evidenceCompleteness !== "complete" && (
        <p className="rv-warn">Evidence completeness: {provenance.evidenceCompleteness}</p>
      )}
      {provenance && provenance.evidenceWarnings.length > 0 && (
        <ul className="rv-warn-list">
          {provenance.evidenceWarnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </header>
  );
}
