import type { BillingDraft } from "../../../contracts";
import { formatCents } from "./format";

/** Displays server-calculated billing only. Never computes money. */
export function BillingPanel(props: { billing: BillingDraft }) {
  const b = props.billing;
  const shown = b.isEstimate ? b.estimateAmountCents : b.amountCents;
  return (
    <section className="card rv-billing" aria-label="Draft invoice">
      <h2>Draft invoice</h2>
      <div className="rv-amount">
        <span className="rv-amount-value">{formatCents(shown)}</span>
        {b.isEstimate && <span className="badge rv-estimate">ESTIMATE</span>}
      </div>
      <p className="rv-breakdown">{b.breakdown}</p>
      <p className="muted rv-small">
        Rate {formatCents(b.hourlyRateCents)}/hour · {b.rateVersion} · amount calculated by server
      </p>
    </section>
  );
}
