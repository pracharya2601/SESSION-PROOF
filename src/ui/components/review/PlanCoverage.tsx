import type { PlanCoverageEntry } from "../../../contracts";
import { coverageLabel } from "./format";

export function PlanCoverage(props: { entries: PlanCoverageEntry[] }) {
  return (
    <section className="card rv-coverage" aria-label="Plan coverage">
      <h2>Plan coverage</h2>
      <p className="muted rv-small">Goal coverage reflects the evidence; it is not a documentation check.</p>
      <ul className="rv-cov-list">
        {props.entries.map((g) => (
          <li key={g.goalId} className={`rv-cov rv-cov-${g.status}`}>
            <span className={`rv-cov-status rv-cov-status-${g.status}`}>{coverageLabel(g.status)}</span>
            <span>{g.objective}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
