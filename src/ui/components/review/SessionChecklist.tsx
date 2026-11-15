/**
 * Server-built session checklist (bundle.checks.checklist), grouped: DDS invoice minimums, plan
 * documentation, consent, EVV, time. Display only — the server decides every status.
 */
import { AlertOctagon, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { CHECKLIST_GROUP_LABELS, type ChecklistGroup, type ChecklistItem, type SessionChecklist as Checklist } from "../../../contracts/schemas";

const ICON = {
  pass: <CheckCircle2 size={15} />,
  warn: <AlertTriangle size={15} />,
  fail: <AlertOctagon size={15} />,
} as const;
const WORD = { pass: "Pass", warn: "Warn", fail: "Fail" } as const;
const SOURCE: Record<NonNullable<ChecklistItem["source"]>, string> = {
  calendar: "calendar",
  drive: "Drive",
  recording: "recording",
  evidence: "evidence",
  provider_attestation: "provider-confirmed (not evidence)",
  configuration: "configuration",
  system: "calculated",
};

export function SessionChecklist(props: { checklist: Checklist }) {
  const cl = props.checklist;
  const groups = (Object.keys(CHECKLIST_GROUP_LABELS) as ChecklistGroup[]).filter((g) => cl.items.some((i) => i.group === g));
  return (
    <div className="rv-cl" aria-label="Session checklist">
      <p className="rv-small rv-cl-summary">
        <span className="rv-cl-count rv-cl-pass">{cl.summary.pass} pass</span>
        <span className="rv-cl-count rv-cl-warn">{cl.summary.warn} warn</span>
        <span className="rv-cl-count rv-cl-fail">{cl.summary.fail} fail</span>
        <span className="rv-muted">
          · SDP {cl.sdpCode ?? "code not recognised"} · EVV {cl.evvRequired ? "required" : "not required"}
        </span>
      </p>
      {cl.rejectedClaims && cl.rejectedClaims.length > 0 && (
        <section className="rv-cl-group">
          <h3 className="rv-block-h">Removed by you ({cl.rejectedClaims.length})</h3>
          <ul className="rv-cl-items">
            {cl.rejectedClaims.map((r) => (
              <li key={r.claimId} className="rv-cl-item rv-cl-removed">
                <span className="rv-cl-icon" aria-hidden="true">
                  <XCircle size={15} />
                </span>
                <span className="rv-cl-body">
                  <span className="rv-sr">Removed: </span>
                  <s className="rv-strike">{r.text}</s>
                  <span className="rv-cl-detail rv-small rv-muted">
                    removed by provider: {r.reason} · not in the note, invoice or goal coverage
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups.map((g) => (
        <section key={g} className="rv-cl-group">
          <h3 className="rv-block-h">{CHECKLIST_GROUP_LABELS[g]}</h3>
          <ul className="rv-cl-items">
            {cl.items
              .filter((i) => i.group === g)
              .map((i) => (
                <li key={i.id} className={`rv-cl-item rv-cl-${i.status}`}>
                  <span className="rv-cl-icon" aria-hidden="true">
                    {ICON[i.status]}
                  </span>
                  <span className="rv-cl-body">
                    <span className="rv-sr">{WORD[i.status]}: </span>
                    <strong>{i.label}</strong>
                    {i.value && <span className="rv-cl-value"> · {i.value}</span>}
                    <span className="rv-cl-detail rv-small rv-muted">
                      {i.detail}
                      {i.source && <> · source: {SOURCE[i.source]}</>}
                      {i.blocksApproval && <strong className="rv-cl-blocks"> · blocks approval</strong>}
                    </span>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
