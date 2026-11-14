import { Cpu, Database, FlaskConical, Server, Sparkles } from "lucide-react";
import type { HealthResponse } from "../../contracts";
import { Badge } from "../design/Badge";

/** Three separate mode badges (Evidence / Extraction / Runtime). Never combined into a single "live" badge. */
export function ModeBadges({ health, compact }: { health: HealthResponse | null; compact?: boolean }) {
  if (!health) {
    return (
      <div className="mode-badges" role="group" aria-label="Modes">
        <Badge tone="warning">Modes: unknown</Badge>
      </div>
    );
  }
  const ev = health.evidenceMode;
  const ex = health.extractionMode;
  return (
    <div className={compact ? "mode-badges mode-badges-compact" : "mode-badges"} role="group" aria-label="Modes">
      <Badge tone={ev === "fixture" ? "fixture" : "success"} icon={ev === "fixture" ? <FlaskConical size={12} /> : <Database size={12} />} title={`Evidence source: ${ev}`}>
        Evidence: {ev}
      </Badge>
      <Badge tone={ex === "fixture" ? "fixture" : "success"} icon={ex === "fixture" ? <FlaskConical size={12} /> : <Sparkles size={12} />} title={`Extraction: ${ex}`}>
        Extraction: {ex}
      </Badge>
      <Badge tone={health.runtimeMode === "local" ? "info" : "neutral"} icon={health.runtimeMode === "local" ? <Cpu size={12} /> : <Server size={12} />} title={`Runtime: ${health.runtimeMode}`}>
        Runtime: {health.runtimeMode}
      </Badge>
    </div>
  );
}
