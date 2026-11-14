import { motion, LayoutGroup } from "framer-motion";
import { CheckCircle2, CircleDashed, CircleDot, Target } from "lucide-react";
import type { PlanCoverageEntry } from "../../../contracts";
import { coverageLabel } from "./format";
import { Section } from "./Section";
import { rvSpring, useMotionOK } from "./motion";

const ICON = {
  addressed: CheckCircle2,
  partially_addressed: CircleDot,
  unknown: CircleDashed,
} as const;

export function PlanCoverage(props: { entries: PlanCoverageEntry[] }) {
  const ok = useMotionOK();
  const addressed = props.entries.filter((e) => e.status === "addressed").length;
  return (
    <Section
      label="Plan coverage"
      title="Plan coverage"
      icon={<Target size={18} />}
      className="rv-coverage"
      aside={
        <span className="rv-count" aria-label={`${addressed} of ${props.entries.length} goals addressed`}>
          {addressed}/{props.entries.length}
        </span>
      }
    >
      <p className="rv-muted rv-small">
        Goal coverage reflects the evidence (or your confirmation, labelled provider confirmed); it is not a documentation check.
      </p>
      <LayoutGroup id="rv-coverage">
        <ul className="rv-cov-list">
          {props.entries.map((g) => {
            const Icon = ICON[g.status];
            return (
              <motion.li key={g.goalId} layout={ok} transition={rvSpring} className={`rv-cov rv-cov-${g.status}`}>
                <motion.span
                  layout={ok}
                  key={g.status}
                  initial={ok ? { scale: 0.6, opacity: 0 } : false}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={rvSpring}
                  className={`rv-cov-status rv-cov-status-${g.status}`}
                >
                  <Icon size={13} aria-hidden="true" />
                  {coverageLabel(g.status)}
                  {g.support === "provider_confirmed" ? " (provider confirmed)" : ""}
                </motion.span>
                <motion.span layout={ok ? "position" : false} className="rv-cov-text">
                  {g.objective}
                </motion.span>
              </motion.li>
            );
          })}
        </ul>
      </LayoutGroup>
    </Section>
  );
}
