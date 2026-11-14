import { describe, expect, it } from "vitest";
import { ExtractionRejectedError, type ExtractionContext, type ExtractionOutput, type Extractor, type Visit } from "../contracts";
import { demoAppointment, demoEvidence, demoFacts, demoPlan } from "../../fixtures/scenario";
import { SCENARIO_PROMPT_VERSION, TRANSCRIPT_ONLY_NOTICE, TRANSCRIPT_ONLY_PROMPT_VERSION, withScenarioExtraction } from "./scenario-extractor";
import type { ScenarioLookup } from "./scenarios-registry";

const VISIT_APPT = "appt_visit_abc123";

function inner(mode: "fixture" | "live"): Extractor & { calls: number } {
  const x = {
    mode,
    calls: 0,
    async extractFacts(): Promise<ExtractionOutput> {
      x.calls++;
      return { facts: demoFacts, mode, model: null, promptVersion: "inner" };
    },
  };
  return x;
}

function store(visit: Partial<Visit> | null) {
  return {
    async getVisitByAppointment(id: string) {
      return visit && id === VISIT_APPT ? ({ providerId: demoAppointment.providerId, scenario: null, transcriber: "simulated", ...visit } as Visit) : null;
    },
  };
}

const extraction = { ...demoFacts, activities: demoFacts.activities.slice(0, 1), observations: [], progress: [], followUps: [] };
const lookup: ScenarioLookup = (id) => (id === "sd-test" ? { script: [], extraction } : null);
const ctx = (apptId = VISIT_APPT): ExtractionContext => ({
  appointment: { ...demoAppointment, id: apptId },
  plan: demoPlan,
  evidence: demoEvidence,
});

describe("withScenarioExtraction", () => {
  it("uses the scenario extraction for a band visit with a scenario (fixture mode)", async () => {
    const i = inner("fixture");
    const x = withScenarioExtraction(i, store({ scenario: "sd-test" }), () => lookup);
    const out = await x.extractFacts(ctx());
    expect(out).toMatchObject({ mode: "fixture", model: null, promptVersion: SCENARIO_PROMPT_VERSION });
    expect(out.facts.activities.map((a) => a.id)).toEqual(extraction.activities.map((a) => a.id));
    expect(i.calls).toBe(0);
  });

  it("delegates when there is no scenario, an unknown one, no lookup, or not a band visit", async () => {
    const i = inner("fixture");
    await withScenarioExtraction(i, store({ scenario: null }), () => lookup).extractFacts(ctx());
    await withScenarioExtraction(i, store({ scenario: "nope" }), () => lookup).extractFacts(ctx());
    await withScenarioExtraction(i, store({ scenario: "sd-test" }), () => null).extractFacts(ctx());
    await withScenarioExtraction(i, store({ scenario: "sd-test" }), () => lookup).extractFacts(ctx(demoAppointment.id));
    await withScenarioExtraction(i, store(null), () => lookup).extractFacts(ctx());
    expect(i.calls).toBe(5);
  });

  it("a real (non-simulated) band recording with no scenario gets honest transcript-only facts", async () => {
    for (const transcriber of ["deepgram", "device"] as const) {
      const i = inner("fixture");
      const out = await withScenarioExtraction(i, store({ scenario: null, transcriber }), () => lookup).extractFacts(ctx());
      expect(i.calls).toBe(0);
      expect(out).toMatchObject({ mode: "fixture", model: null, promptVersion: TRANSCRIPT_ONLY_PROMPT_VERSION });
      expect(out.facts).toEqual({
        activities: [],
        observations: [],
        goals: demoPlan.goals.map((g) => ({ goalId: g.goalId, status: "unknown", claims: [] })),
        progress: [],
        followUps: [],
        missingInformation: [TRANSCRIPT_ONLY_NOTICE],
      });
      // works without any scenario lookup registered, too
      const j = inner("fixture");
      const out2 = await withScenarioExtraction(j, store({ scenario: null, transcriber }), () => null).extractFacts(ctx());
      expect(out2.promptVersion).toBe(TRANSCRIPT_ONLY_PROMPT_VERSION);
      expect(j.calls).toBe(0);
    }
    // another provider's visit, or not a band appointment: unchanged delegation
    const k = inner("fixture");
    await withScenarioExtraction(k, store({ scenario: null, transcriber: "deepgram", providerId: "someone_else" }), () => lookup).extractFacts(ctx());
    await withScenarioExtraction(k, store({ scenario: null, transcriber: "deepgram" }), () => lookup).extractFacts(ctx(demoAppointment.id));
    expect(k.calls).toBe(2);
    // live mode is never touched
    const l = inner("live");
    expect(withScenarioExtraction(l, store({ scenario: null, transcriber: "deepgram" }), () => lookup)).toBe(l);
  });

  it("ignores a visit owned by another provider", async () => {
    const i = inner("fixture");
    await withScenarioExtraction(i, store({ scenario: "sd-test", providerId: "someone_else" }), () => lookup).extractFacts(ctx());
    expect(i.calls).toBe(1);
  });

  it("never applies in live mode", async () => {
    const i = inner("live");
    const x = withScenarioExtraction(i, store({ scenario: "sd-test" }), () => lookup);
    expect(x).toBe(i);
    expect((await x.extractFacts(ctx())).promptVersion).toBe("inner");
  });

  it("still validates citations", async () => {
    const bad = { ...extraction, activities: [{ ...extraction.activities[0]!, evidenceIds: ["ev_999"] }] };
    const x = withScenarioExtraction(inner("fixture"), store({ scenario: "bad" }), () => (id) => (id === "bad" ? { script: [], extraction: bad } : null));
    await expect(x.extractFacts(ctx())).rejects.toBeInstanceOf(ExtractionRejectedError);
    await expect(x.extractFacts(ctx())).rejects.toMatchObject({ reason: "unknown_evidence" });
  });
});

describe("fixtures/band scenarios", () => {
  it("every scenario's extraction validates against evidence from its own script", async () => {
    const { BAND_SCENARIOS } = await import("../../fixtures/band");
    const { validateExtraction } = await import("../ai");
    expect(BAND_SCENARIOS.length).toBeGreaterThan(0);
    for (const s of BAND_SCENARIOS) {
      const evidence = s.script.map((_, i) => ({ ...demoEvidence[0]!, id: `ev_${String(i + 1).padStart(3, "0")}` }));
      expect(() => validateExtraction(s.extraction, { appointment: demoAppointment, plan: s.plan, evidence }), s.id).not.toThrow();
    }
  });
});
