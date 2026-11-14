import type { HealthResponse } from "../../contracts";

/** Three separate mode badges. Never combined into a single "live" badge. */
export function ModeBadges({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return (
      <div className="mode-badges" aria-label="Modes">
        <span className="badge badge-warn">Modes: unknown</span>
      </div>
    );
  }
  return (
    <div className="mode-badges" aria-label="Modes">
      <span className={`badge badge-${health.evidenceMode}`}>
        {health.evidenceMode === "fixture" && <span aria-hidden="true">⚠</span>}
        Evidence: {health.evidenceMode}
      </span>
      <span className={`badge badge-${health.extractionMode}`}>
        {health.extractionMode === "fixture" && <span aria-hidden="true">⚠</span>}
        Extraction: {health.extractionMode}
      </span>
      <span className={`badge badge-${health.runtimeMode}`}>Runtime: {health.runtimeMode}</span>
    </div>
  );
}
