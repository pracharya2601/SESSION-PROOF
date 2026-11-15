/**
 * Server-built invoice lines (bundle.billing.invoice). Display only: every number is the server's.
 */
import type { InvoiceDraft, InvoiceLine } from "../../../contracts";
import { formatCents } from "./format";

const SOURCE: Record<InvoiceLine["source"], string> = {
  evidence: "From evidence",
  provider_attestation: "Provider-confirmed (not evidence)",
  unallocated: "Not linked to a task",
  configuration: "No task in evidence",
};

export function InvoiceLines(props: { invoice: InvoiceDraft }) {
  const inv = props.invoice;
  const auth = inv.authorization;
  return (
    <div className="rv-inv">
      <p className="rv-small rv-muted" style={{ margin: "8px 0" }}>
        SDP {inv.sdpCode ?? inv.serviceCode} ({inv.serviceCodeSource === "drive" ? "Drive" : "calendar"}) · {formatCents(inv.hourlyRateCents)}/hr (
        {inv.rateSource === "drive_authorization" ? "Drive authorization" : inv.rateSource === "client" ? "client record" : "service config"}) · minutes{" "}
        {inv.rounding.rule}
      </p>
      <table className="rv-inv-table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col" className="rv-num">
              Min
            </th>
            <th scope="col" className="rv-num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.taskDescription}
                <span className={`rv-tag ${l.source === "evidence" ? "rv-tag-evidence" : l.source === "provider_attestation" ? "rv-tag-provider" : "rv-tag-system"}`}>
                  {SOURCE[l.source]}
                </span>
                {l.evidenceIds.length > 0 && <span className="rv-small rv-muted"> {l.evidenceIds.join(", ")}</span>}
              </td>
              <td className="rv-num">{l.billedMinutes === null ? `~${l.estimatedMinutes}` : l.billedMinutes}</td>
              <td className="rv-num">{formatCents(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="rv-num">{inv.rounding.billedMinutes ?? "—"}</td>
            <td className="rv-num">
              <strong>{formatCents(inv.totalCents)}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
      {auth && (
        <p className="rv-small" style={{ margin: "8px 0 0" }}>
          Authorization {auth.number} · {auth.fundingSource} · {auth.validFrom} to {auth.validTo}
          {auth.remainingMinutesAfterSession !== null && (
            <>
              {" "}
              ·{" "}
              <strong className={auth.remainingMinutesAfterSession < 0 ? "rv-warn" : undefined}>
                {auth.remainingMinutesAfterSession} of {auth.authorizedMinutesPerMonth} min left this month
              </strong>
            </>
          )}
        </p>
      )}
      <p className="rv-small rv-muted" style={{ margin: "6px 0 0" }}>
        “{inv.attestationStatement}” — {inv.attestationLabel}.
      </p>
      {inv.notes.map((n) => (
        <p key={n} className="rv-small rv-muted" style={{ margin: "4px 0 0" }}>
          {n}
        </p>
      ))}
    </div>
  );
}
