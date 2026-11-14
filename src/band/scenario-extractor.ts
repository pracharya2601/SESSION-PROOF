/**
 * Fixture-mode extraction for synthetic band scenarios (dev only). When the extractor
 * is in fixture mode and the appointment is a band visit playing a scenario, the
 * scenario's own extraction is used instead of the global fixture variant. It still goes
 * through validateExtraction, so citations and goal ids are checked against the real
 * evidence. Live extraction is never touched.
 */
import type { ExtractionContext, ExtractionOutput, Extractor } from "../contracts";
import { validateExtraction } from "../ai";
import { isVisitAppointment } from "./evidence";
import { scenarioLookupReady, type ScenarioLookup } from "./scenarios-registry";
import type { VisitStore } from "./store";

export const SCENARIO_PROMPT_VERSION = "fixture-scenario-v1";

export function withScenarioExtraction(
  inner: Extractor,
  store: Pick<VisitStore, "getVisitByAppointment">,
  lookup: () => ScenarioLookup | null,
): Extractor {
  if (inner.mode !== "fixture") return inner;
  return {
    mode: inner.mode,
    async extractFacts(ctx: ExtractionContext): Promise<ExtractionOutput> {
      if (isVisitAppointment(ctx.appointment)) await scenarioLookupReady();
      const find = lookup();
      if (find && isVisitAppointment(ctx.appointment)) {
        const visit = await store.getVisitByAppointment(ctx.appointment.id);
        const own = visit && visit.providerId === ctx.appointment.providerId ? visit : null;
        const scenario = own?.scenario ? find(own.scenario) : null;
        if (scenario?.extraction) {
          return {
            facts: validateExtraction(scenario.extraction, ctx),
            mode: "fixture",
            model: null,
            promptVersion: SCENARIO_PROMPT_VERSION,
          };
        }
      }
      return inner.extractFacts(ctx);
    },
  };
}
