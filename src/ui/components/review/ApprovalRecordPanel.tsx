import { FileJson, Printer, Stamp } from "lucide-react";
import type { ApprovalRecord } from "../../../contracts";
import { exportUrl } from "../../api";
import { formatInstant } from "./format";
import { Section } from "./Section";

export function ApprovalRecordPanel(props: { approval: ApprovalRecord; timezone: string; completed: boolean }) {
  const a = props.approval;
  return (
    <Section label="Approval record" title="Approval record" icon={<Stamp size={18} />} className="rv-approval">
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
        <div className="rv-row rv-exports">
          <a className="ds-btn ds-btn-ghost ds-btn-sm" href={exportUrl(a.sessionId, "json")} download>
            <FileJson size={14} aria-hidden="true" /> Download JSON
          </a>
          <a className="ds-btn ds-btn-ghost ds-btn-sm" href={exportUrl(a.sessionId, "html")} target="_blank" rel="noopener noreferrer">
            <Printer size={14} aria-hidden="true" /> Open printable bundle
          </a>
        </div>
      )}
    </Section>
  );
}
