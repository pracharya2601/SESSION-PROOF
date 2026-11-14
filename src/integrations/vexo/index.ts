/**
 * Vexo evidence adapter (Agent 07). One EvidenceSource contract, two explicit
 * modes. Live mode never falls back to fixtures.
 */
import { EvidenceUnavailableError, type EvidenceSource } from "../../contracts";
import type { Env } from "../../env";
import { FixtureEvidenceSource } from "./fixture";
import { LiveEvidenceSource, type LiveEvidenceOptions, type VexoMcpClient } from "./live";

export { FixtureEvidenceSource } from "./fixture";
export { LiveEvidenceSource, VEXO_TOOL_CONFIG, normalizeItem, parsePage } from "./live";
export type { VexoMcpClient, LiveEvidenceOptions } from "./live";

class NotConfiguredEvidenceSource implements EvidenceSource {
  readonly mode = "live" as const;
  async retrieveEvidence(): Promise<never> {
    throw new EvidenceUnavailableError("Live evidence mode selected but no Vexo MCP client is configured", "not_configured", false);
  }
}

export function createEvidenceSource(
  env: Env,
  opts?: { mcpClient?: VexoMcpClient } & LiveEvidenceOptions,
): EvidenceSource {
  if (env.EVIDENCE_MODE === "fixture") return new FixtureEvidenceSource(env.FIXTURE_VARIANT ?? "normal");
  if (env.EVIDENCE_MODE !== "live") {
    throw new EvidenceUnavailableError(`Unknown EVIDENCE_MODE: ${String(env.EVIDENCE_MODE)}`, "not_configured", false);
  }
  if (!opts?.mcpClient) return new NotConfiguredEvidenceSource();
  return new LiveEvidenceSource(opts.mcpClient, opts);
}
