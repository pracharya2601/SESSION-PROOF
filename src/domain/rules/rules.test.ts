import { describe, expect, it } from "vitest";
import type { Documents, ProviderAttestation, RulesInput, SessionFacts } from "../../contracts";
import { DocumentationChecks } from "../../contracts";
import { demoAppointment, demoEvidence, demoFacts, demoPlan, demoRules, EXPECTED } from "../../../fixtures/scenario";
import { ISSUE_CODES, isMeaningfulText, validateRequirements } from "./index";

const documents: Documents = {
  sections: [],
  planCoverage: [],
  timeSummary: {
    scheduledFrom: demoAppointment.startAt,
    scheduledTo: demoAppointment.endAt,
    scheduledMinutes: 60,
    evidenceWindowFrom: null,
    evidenceWindowTo: null,
    evidenceWindowMinutes: null,
    confirmedMinutes: null,
    timezone: demoAppointment.timezone,
  },
};

function attestation(text: string, field: "progress" | "duration" = "progress"): ProviderAttestation {
  return {
    id: "att_progress_1",
    field,
    text,
    actorProviderId: demoAppointment.providerId,
    attestedAt: "2026-11-13T19:45:00.000Z",
    bundleRevision: 1,
  };
}

function input(over: Partial<RulesInput> = {}): RulesInput {
  return {
    appointment: demoAppointment,
    plan: demoPlan,
    rules: demoRules,
    facts: demoFacts,
    documents,
    attestations: [],
    evidenceIds: demoEvidence.map((e) => e.id),
    confirmedMinutes: null,
    evidenceCompleteness: "complete",
    ...over,
  };
}

const codes = (r: ReturnType<typeof validateRequirements>, blocking: boolean) =>
  r.issues.filter((i) => i.blocking === blocking).map((i) => i.code).sort();

describe("validateRequirements", () => {
  it("normal fixture without attestations is blocked on progress and duration", () => {
    const r = validateRequirements(input());
    expect(DocumentationChecks.parse(r)).toEqual(r);
    expect(r.ruleVersion).toBe("rules_demo_v1");
    expect(codes(r, true)).toEqual([ISSUE_CODES.MISSING_CONFIRMED_DURATION, ISSUE_CODES.MISSING_PROGRESS].sort());
    const nb = r.issues.filter((i) => !i.blocking);
    expect(nb).toHaveLength(1);
    expect(nb[0]).toMatchObject({ code: ISSUE_CODES.UNKNOWN_GOAL_COVERAGE, field: "goal:goal_community" });
    expect(r.canApprove).toBe(false);
  });

  it("valid progress attestation + 90 minutes allows approval", () => {
    const r = validateRequirements(
      input({ attestations: [attestation(EXPECTED.demoProgressConfirmation)], confirmedMinutes: 90 }),
    );
    expect(codes(r, true)).toEqual([]);
    expect(r.canApprove).toBe(true);
  });

  it.each(["unknown", "  ", "", "N/A", "TBD.", "-", "?", "Lorem Ipsum"])(
    "placeholder attestation text %j does not satisfy progress",
    (text) => {
      const r = validateRequirements(input({ attestations: [attestation(text)], confirmedMinutes: 90 }));
      expect(codes(r, true)).toEqual([ISSUE_CODES.MISSING_PROGRESS]);
      expect(r.canApprove).toBe(false);
    },
  );

  it("duration attestation does not satisfy progress", () => {
    const r = validateRequirements(
      input({ attestations: [attestation(EXPECTED.demoProgressConfirmation, "duration")], confirmedMinutes: 90 }),
    );
    expect(codes(r, true)).toEqual([ISSUE_CODES.MISSING_PROGRESS]);
  });

  it("attestation disallowed by rules stays blocked", () => {
    const r = validateRequirements(
      input({
        rules: { ...demoRules, allowProviderProgressAttestation: false },
        attestations: [attestation(EXPECTED.demoProgressConfirmation)],
        confirmedMinutes: 90,
      }),
    );
    expect(codes(r, true)).toEqual([ISSUE_CODES.MISSING_PROGRESS]);
    expect(r.canApprove).toBe(false);
  });

  it("provider_confirmed claim only counts with a matching attestation", () => {
    const claim = {
      id: "fact_prog_att",
      text: EXPECTED.demoProgressConfirmation,
      evidenceIds: [],
      support: "provider_confirmed" as const,
      providerAttestationId: "att_missing",
    };
    const facts: SessionFacts = { ...demoFacts, progress: [claim] };
    expect(codes(validateRequirements(input({ facts, confirmedMinutes: 60 })), true)).toEqual([
      ISSUE_CODES.MISSING_PROGRESS,
    ]);
  });

  it("supported progress claim citing known evidence satisfies progress", () => {
    const facts: SessionFacts = {
      ...demoFacts,
      progress: [{ id: "fact_prog_1", text: "Participant identified the transfer stop.", evidenceIds: ["ev_002"], support: "supported" }],
    };
    expect(validateRequirements(input({ facts, confirmedMinutes: 60 })).canApprove).toBe(true);
  });

  it("uncertain progress claim never satisfies", () => {
    const facts: SessionFacts = {
      ...demoFacts,
      progress: [{ id: "fact_prog_1", text: "Participant improved.", evidenceIds: ["ev_002"], support: "uncertain" }],
    };
    expect(codes(validateRequirements(input({ facts, confirmedMinutes: 60 })), true)).toEqual([
      ISSUE_CODES.MISSING_PROGRESS,
    ]);
  });

  it("supported claim citing unknown evidence is blocking UNSUPPORTED_CLAIM", () => {
    const facts: SessionFacts = {
      ...demoFacts,
      observations: [{ id: "fact_obs_bad", text: "Participant read the timetable.", evidenceIds: ["ev_999"], support: "supported" }],
    };
    const r = validateRequirements(
      input({ facts, attestations: [attestation(EXPECTED.demoProgressConfirmation)], confirmedMinutes: 90 }),
    );
    expect(codes(r, true)).toEqual([ISSUE_CODES.UNSUPPORTED_CLAIM]);
    expect(r.issues.find((i) => i.code === ISSUE_CODES.UNSUPPORTED_CLAIM)!.message).toContain("ev_999");
    expect(r.canApprove).toBe(false);
  });

  it("activities citing unknown evidence do not satisfy service description", () => {
    const facts: SessionFacts = {
      ...demoFacts,
      activities: [{ id: "fact_act_bad", text: "Practiced routes.", evidenceIds: ["ev_999"], support: "supported" }],
    };
    const r = validateRequirements(input({ facts, attestations: [attestation("Good progress made.")], confirmedMinutes: 60 }));
    expect(codes(r, true)).toEqual([ISSUE_CODES.MISSING_SERVICE_DESCRIPTION, ISSUE_CODES.UNSUPPORTED_CLAIM].sort());
  });

  it("no addressed goal blocks", () => {
    const facts: SessionFacts = { ...demoFacts, goals: demoFacts.goals.filter((g) => g.status !== "addressed") };
    const r = validateRequirements(input({ facts, attestations: [attestation("Good progress made.")], confirmedMinutes: 60 }));
    expect(codes(r, true)).toEqual([ISSUE_CODES.NO_GOAL_ADDRESSED]);
  });

  it.each(["partial", "unknown"] as const)("%s evidence is nonblocking", (evidenceCompleteness) => {
    const r = validateRequirements(
      input({ evidenceCompleteness, attestations: [attestation(EXPECTED.demoProgressConfirmation)], confirmedMinutes: 90 }),
    );
    expect(r.issues.some((i) => i.code === ISSUE_CODES.PARTIAL_EVIDENCE && !i.blocking)).toBe(true);
    expect(r.canApprove).toBe(true);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("confirmed minutes %s is not confirmed", (m) => {
    const r = validateRequirements(input({ attestations: [attestation("Good progress made.")], confirmedMinutes: m }));
    expect(codes(r, true)).toEqual([ISSUE_CODES.MISSING_CONFIRMED_DURATION]);
  });

  it("only checks fields listed as required", () => {
    const r = validateRequirements(input({ rules: { ...demoRules, required: ["service_date"] } }));
    expect(codes(r, true)).toEqual([]);
    expect(r.canApprove).toBe(true);
  });

  it("never uses the word compliance", () => {
    const r = validateRequirements(
      input({ appointment: { ...demoAppointment, clientRef: " ", providerId: "n/a" }, evidenceIds: [], evidenceCompleteness: "partial" }),
    );
    expect(r.issues.length).toBeGreaterThan(5);
    for (const i of r.issues) expect(i.message.toLowerCase()).not.toContain("compliance");
  });

  it("isMeaningfulText", () => {
    expect(isMeaningfulText("Completed the task.")).toBe(true);
    expect(isMeaningfulText(" UNKNOWN ")).toBe(false);
    expect(isMeaningfulText("none")).toBe(false);
    expect(isMeaningfulText("...")).toBe(false);
  });
});
