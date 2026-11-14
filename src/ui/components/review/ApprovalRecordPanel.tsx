import type { ApprovalRecord } from "../../../contracts";
import { exportUrl } from "../../api";
import { formatInstant } from "./format";

export function ApprovalRecordPanel(props: { approval: ApprovalRecord; timezone: string; completed: boolean }) {
  const a = props.approval;
  return (
    <section className="card rv-approval" aria-label="Approval record">
      <h2>Approval record</h2>
      <dl className="rv-dl">
        <dt>Approver</dt>
        <dd>{a.approverProviderId}</dd>
        <dt>Approved revision</dt>
        <dd>{a.bundleRevision}</dd>
        <dt>Approved at</dt>
        <dd>{formatInstant(a.approvedAt, props.timezone)}</dd>
        <dt>Idempotency key</dt>
        <dd>
          <code>{a.idempotencyKey}</code>
        </dd>
        <dt>Finalization</dt>
        <dd>{a.finalizationStatus}</dd>
      </dl>
      {props.completed && (
        <div className="row">
          <a className="btn" href={exportUrl(a.sessionId, "json")} download>
            Download JSON
          </a>
          <a className="btn" href={exportUrl(a.sessionId, "html")} target="_blank" rel="noopener noreferrer">
            Open printable bundle
          </a>
        </div>
      )}
    </section>
  );
}
