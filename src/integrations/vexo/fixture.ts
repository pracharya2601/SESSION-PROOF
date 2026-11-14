import { getVariant } from "../../../fixtures/variants";
import {
  EvidenceUnavailableError,
  type Appointment,
  type EvidenceResult,
  type EvidenceSource,
} from "../../contracts";
import { evidenceWindow, itemInWindow } from "./window";

/** Synthetic evidence from fixtures/variants.ts. Never used as a live fallback. */
export class FixtureEvidenceSource implements EvidenceSource {
  readonly mode = "fixture" as const;

  constructor(private readonly variant: string = "normal") {}

  async retrieveEvidence(appointment: Appointment): Promise<EvidenceResult> {
    const { evidence } = getVariant(this.variant);
    if (evidence instanceof Error) {
      throw new EvidenceUnavailableError(
        `Fixture evidence source unavailable (variant "${this.variant}"): ${evidence.message}`,
        "transport",
        true,
      );
    }
    const w = evidenceWindow(appointment);
    const items = evidence.items.filter((i) => itemInWindow(i, w));
    const untimed = evidence.items.filter((i) => !i.observedFrom && !i.observedTo).length;
    const warnings = [...evidence.warnings];
    if (untimed > 0) warnings.push(`${untimed} evidence item(s) without timestamps were excluded from the window.`);
    return {
      items,
      completeness: evidence.completeness,
      unavailableSourceIds: [...evidence.unavailableSourceIds],
      warnings,
    };
  }
}
