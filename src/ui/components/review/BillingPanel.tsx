import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";
import { Receipt, Server } from "lucide-react";
import type { BillingDraft } from "../../../contracts";
import { AnimatedNumber } from "../../design";
import { formatCents } from "./format";
import { Section } from "./Section";
import { useMotionOK } from "./motion";

/** Displays server-calculated billing only. Never computes money. */
export function BillingPanel(props: { billing: BillingDraft; revision: number }) {
  const b = props.billing;
  const ok = useMotionOK();
  const shown = b.isEstimate ? b.estimateAmountCents : b.amountCents;
  // Flash a "recalculated by server" shimmer when a new revision changes the amount.
  const prev = useRef<{ rev: number; amount: number | null } | null>(null);
  const controls = useAnimationControls();
  const [recalc, setRecalc] = useState(false);
  useEffect(() => {
    const p = prev.current;
    if (p && p.rev !== props.revision && p.amount !== shown) {
      setRecalc(true);
      if (ok) {
        void controls.start({
          scale: [1, 1.08, 1],
          textShadow: ["0 0 0px rgba(124,92,255,0)", "0 0 28px rgba(124,92,255,0.85)", "0 0 0px rgba(124,92,255,0)"],
          transition: { duration: 1.1, ease: "easeOut" },
        });
      }
    }
    prev.current = { rev: props.revision, amount: shown };
  }, [props.revision, shown, ok, controls]);

  return (
    <Section label="Draft invoice" title="Draft invoice" icon={<Receipt size={18} />} className="rv-billing">
      <div className="rv-amount">
        <motion.span className={`rv-amount-value${recalc ? " is-recalc" : ""}`} animate={controls}>
          {shown === null || shown === undefined ? formatCents(shown) : <AnimatedNumber value={shown} format="cents" />}
        </motion.span>
        {b.isEstimate && <span className="rv-chip rv-estimate">ESTIMATE</span>}
        {recalc && (
          <motion.span
            className="rv-chip rv-chip-accent"
            initial={ok ? { opacity: 0, scale: 0.7 } : false}
            animate={{ opacity: 1, scale: 1 }}
          >
            Recalculated by server
          </motion.span>
        )}
      </div>
      <p className="rv-breakdown">{b.breakdown}</p>
      <p className="rv-muted rv-small rv-server-note">
        <Server size={12} aria-hidden="true" /> Rate {formatCents(b.hourlyRateCents)}/hour · {b.rateVersion} · amount calculated by
        server
      </p>
    </Section>
  );
}
