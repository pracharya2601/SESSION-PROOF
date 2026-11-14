/**
 * Fixture-mode extraction for synthetic band scenarios (dev only). When the extractor
 * is in fixture mode and the appointment is a band visit playing a scenario, the
 * scenario's own extraction is used instead of the global fixture variant. It still goes
 * through validateExtraction, so citations and goal ids are checked against the real
 * evidence. Live extraction is never touched.
 *
 * A REAL band recording (transcriber other than "simulated", e.g. a Deepgram transcript)
 * with no scenario never gets the canned demo facts in fixture mode: those describe a
 * synthetic visit and cite ev_001..ev_005. It gets an honest transcript-only result instead
 * (no claims, every goal unknown) and the provider summarises and confirms goals in review.
 * The simulated default script keeps the canned facts (they were written for exactly it).
 */
import type { ExtractionContext, ExtractionOutput, Extractor, SessionFacts } from "../contracts";
import { validateExtraction } from "../ai";
import { isVisitAppointment } from "./evidence";
import { scenarioLookupReady, type ScenarioLookup } from "./scenarios-registry";
import type { VisitStore } from "./store";

export const SCENARIO_PROMPT_VERSION = "fixture-scenario-v1";
export const TRANSCRIPT_ONLY_PROMPT_VERSION = "transcript-only-v1";
export const TRANSCRIPT_ONLY_NOTICE =
  "AI extraction is not configured: the provider must summarise the visit and confirm goals from the transcript.";

/** No claims at all: every plan goal unknown, one missing-information notice. */
export function transcriptOnlyFacts(ctx: Pick<ExtractionContext, "plan">): SessionFacts {
  return {
    activities: [],
    observations: [],
    goals: ctx.plan.goals.slice(0, 20).map((g) => ({ goalId: g.goalId, status: "unknown" as const, claims: [] })),
    progress: [],
    followUps: [],
    missingInformation: [TRANSCRIPT_ONLY_NOTICE],
  };
}

export function withScenarioExtraction(
  inner: Extractor,
  store: Pick<VisitStore, "getVisitByAppointment">,
  lookup: () => ScenarioLookup | null,
): Extractor {
  if (inner.mode !== "fixture") return inner;
  return {
    mode: inner.mode,
    async extractFacts(ctx: ExtractionContext): Promise<ExtractionOutput> {
      if (!isVisitAppointment(ctx.appointment)) return inner.extractFacts(ctx);
      await scenarioLookupReady();
      const find = lookup();
      const visit = await store.getVisitByAppointment(ctx.appointment.id);
      const own = visit && visit.providerId === ctx.appointment.providerId ? visit : null;
      if (own && !own.scenario && own.transcriber !== "simulated") {
        return {
          facts: validateExtraction(transcriptOnlyFacts(ctx), ctx),
          mode: "fixture",
          model: null,
          promptVersion: TRANSCRIPT_ONLY_PROMPT_VERSION,
        };
      }
      if (find) {
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
