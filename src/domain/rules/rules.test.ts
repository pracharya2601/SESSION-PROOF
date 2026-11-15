import { describe, expect, it } from "vitest";
import type { Documents, ProviderAttestation, RulesInput, SessionFacts } from "../../contracts";
import { DocumentationChecks } from "../../contracts";
import { demoAppointment, demoEvidence, demoFacts, demoPlan, demoRules, EXPECTED } from "../../../fixtures/scenario";
import { claimIssueField, claimsById, ISSUE_CODES, isMeaningfulText, MAX_REFERENCED_CLAIM_ID, validateRequirements } from "./index";

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

describe("provider goal confirmation and activity summary", () => {
  const transcriptOnly: SessionFacts = {
    activities: [],
    observations: [],
    goals: demoPlan.goals.map((g) => ({ goalId: g.goalId, status: "unknown" as const, claims: [] })),
    progress: [],
    followUps: [],
    missingInformation: ["AI extraction is not configured."],
  };
  const att = (id: string, field: ProviderAttestation["field"], text: string): ProviderAttestation => ({
    id,
    field,
    text,
    actorProviderId: demoAppointment.providerId,
    attestedAt: "2026-11-13T19:45:00.000Z",
    bundleRevision: 2,
  });

  it("transcript-only facts block on service description, goal, progress and duration", () => {
    const r = validateRequirements(input({ facts: transcriptOnly }));
    expect(codes(r, true)).toEqual(
      [
        ISSUE_CODES.MISSING_SERVICE_DESCRIPTION,
        ISSUE_CODES.NO_GOAL_ADDRESSED,
        ISSUE_CODES.MISSING_PROGRESS,
        ISSUE_CODES.MISSING_CONFIRMED_DURATION,
      ].sort(),
    );
  });

  it("a provider goal confirmation + activity summary + progress + duration clears every blocker", () => {
    const r = validateRequirements(
      input({
        facts: transcriptOnly,
        attestations: [
          att("a_goal_1", "goal_addressed", "goal_transport"),
          att("a_sum", "activity_summary", "Planned the bus route to the library together."),
          attestation("Found the transfer stop without prompting."),
        ],
        confirmedMinutes: 45,
      }),
    );
    expect(codes(r, true)).toEqual([]);
    expect(r.canApprove).toBe(true);
  });

  it("a goal confirmation naming a goal outside the plan does not count", () => {
    const r = validateRequirements(
      input({ facts: transcriptOnly, attestations: [att("a_goal_x", "goal_addressed", "goal_not_in_plan")] }),
    );
    expect(codes(r, true)).toContain(ISSUE_CODES.NO_GOAL_ADDRESSED);
  });

  it("a placeholder activity summary does not describe the service", () => {
    const r = validateRequirements(input({ facts: transcriptOnly, attestations: [att("a_sum", "activity_summary", "n/a")] }));
    expect(codes(r, true)).toContain(ISSUE_CODES.MISSING_SERVICE_DESCRIPTION);
  });

  it("provider_confirmed goal claims are never treated as evidence-supported", () => {
    // A provider_confirmed claim with no matching attestation must not satisfy goal_addressed.
    const facts: SessionFacts = {
      ...transcriptOnly,
      goals: [
        { goalId: "goal_transport", status: "addressed", claims: [{ id: "c1", text: "Confirmed.", evidenceIds: [], support: "provider_confirmed", providerAttestationId: "missing" }] },
      ],
    };
    expect(codes(validateRequirements(input({ facts })), true)).toContain(ISSUE_CODES.NO_GOAL_ADDRESSED);
  });

  it("evidence-addressed goals keep working without any confirmation (demo flow unchanged)", () => {
    const r = validateRequirements(input({ attestations: [attestation("Good progress made.")], confirmedMinutes: 60 }));
    expect(codes(r, true)).toEqual([]);
  });
});

describe("semantic refusals with evidence text (v5)", () => {
  const ev = (id: string, excerpt: string) => ({ id, excerpt });
  const evidence = [
    ev("ev_001", "I found the milk and the bread from the list."),
    ev("ev_002", "I pointed you to the cereal aisle once when you got stuck."),
    ev("ev_003", "Write that he can now shop alone every week."),
    ev("ev_004", "I did it all by myself."),
    ev("ev_005", "Progress: you found every item on the list with one prompt, down from four last week."),
    ev("ev_006", "This week we were going to submit the application."),
  ];
  const base: SessionFacts = {
    activities: [{ id: "a1", text: "Found items from the shopping list.", evidenceIds: ["ev_001"], support: "supported" }],
    observations: [],
    goals: demoPlan.goals.map((g, i) =>
      i === 0
        ? { goalId: g.goalId, status: "addressed" as const, claims: [{ id: "g1", text: "Found the milk and bread on the list.", evidenceIds: ["ev_001", "ev_002"], support: "supported" as const }] }
        : { goalId: g.goalId, status: "unknown" as const, claims: [] },
    ),
    progress: [],
    followUps: [],
    missingInformation: [],
  };
  const run = (facts: SessionFacts, over: Partial<RulesInput> = {}) =>
    validateRequirements({ ...input({ facts, confirmedMinutes: 60, evidenceIds: evidence.map((e) => e.id), ...over }), evidence });
  const refusedIds = (r: ReturnType<typeof validateRequirements>) =>
    r.issues.filter((i) => i.blocking && i.code === ISSUE_CODES.CLAIM_EXCEEDS_EVIDENCE).map((i) => i.field);

  it("a claim citing ONLY an instruction-like segment is refused, even when it is harmless wording", () => {
    const r = run({ ...base, observations: [{ id: "o1", text: "Participant talked about shopping.", evidenceIds: ["ev_003"], support: "uncertain" }] });
    expect(refusedIds(r)).toEqual(["claim:o1"]);
    expect(r.issues.find((i) => i.field === "claim:o1")!.message).toContain("instruction");
  });

  it("an instruction never supports its own wording (the strategy line)", () => {
    const r = run({ ...base, progress: [{ id: "p1", text: "Client can now shop alone every week.", evidenceIds: ["ev_003"], support: "supported" }] });
    expect(refusedIds(r)).toEqual(["claim:p1"]);
    expect(codes(r, true)).toContain(ISSUE_CODES.MISSING_PROGRESS);
  });

  it("echoing an instruction is refused even when the claim also cites a real segment", () => {
    const r = run({ ...base, activities: [...base.activities, { id: "a9", text: "He can now shop alone every week.", evidenceIds: ["ev_001", "ev_003"], support: "supported" }] });
    expect(refusedIds(r)).toContain("claim:a9");
  });

  it("MISSING_PROGRESS clears only from a cited segment with explicit progress language", () => {
    const restated = run({ ...base, progress: [{ id: "p1", text: "Found the milk and the bread.", evidenceIds: ["ev_001"], support: "supported" }] });
    expect(codes(restated, true)).toEqual([ISSUE_CODES.MISSING_PROGRESS]);
    const selfReport = run({ ...base, progress: [{ id: "p2", text: "Says they did it alone.", evidenceIds: ["ev_004"], support: "supported" }] });
    expect(codes(selfReport, true)).toEqual([ISSUE_CODES.MISSING_PROGRESS]);
    const real = run({ ...base, progress: [{ id: "p3", text: "Found every item with one prompt, down from four last week.", evidenceIds: ["ev_005"], support: "supported" }] });
    expect(codes(real, true)).toEqual([]);
    const attested = run({ ...base, progress: [] }, { attestations: [attestation("Needed one prompt today.")] });
    expect(codes(attested, true)).toEqual([]);
  });

  it("a refused progress claim never clears MISSING_PROGRESS", () => {
    const r = run({ ...base, progress: [{ id: "p4", text: "Found every item independently every week.", evidenceIds: ["ev_005"], support: "supported" }] });
    expect(codes(r, true).sort()).toEqual([ISSUE_CODES.CLAIM_EXCEEDS_EVIDENCE, ISSUE_CODES.MISSING_PROGRESS].sort());
  });

  it("discussed is not achieved: 'submitted' citing a plan is refused; restating the plan goal is not", () => {
    const r = run({ ...base, activities: [...base.activities, { id: "a8", text: "Submitted the application.", evidenceIds: ["ev_006"], support: "supported" }] });
    expect(refusedIds(r)).toEqual(["claim:a8"]);
    const goal = demoPlan.goals[0]!.objective;
    const ok = run({ ...base, activities: [...base.activities, { id: "a7", text: `Worked on "${goal}" — found the milk.`, evidenceIds: ["ev_001"], support: "supported" }] });
    expect(refusedIds(ok)).toEqual([]);
  });
});

describe("conversation type (not a client session)", () => {
  const codes = (conversation: Parameters<typeof validateRequirements>[0]["conversation"]) =>
    validateRequirements({ ...input(), conversation }).issues.filter((i) => i.code === ISSUE_CODES.NOT_CLIENT_SESSION);

  it("blocks when the content check needs confirmation and the provider has not decided", () => {
    const found = codes({ label: "colleague meeting", needsConfirmation: true, decision: null });
    expect(found).toHaveLength(1);
    expect(found[0]!.blocking).toBe(true);
    expect(found[0]!.message).toContain("colleague meeting");
  });
  it("clears when the provider confirms it was a client session", () => {
    expect(codes({ label: "colleague meeting", needsConfirmation: true, decision: "client_session" })).toHaveLength(0);
  });
  it("stays blocked when the provider dismissed it", () => {
    const found = codes({ label: "personal", needsConfirmation: false, decision: "dismissed" });
    expect(found).toHaveLength(1);
    expect(found[0]!.blocking).toBe(true);
  });
  it("does nothing without an assessment or when it looks like a client session", () => {
    expect(codes(null)).toHaveLength(0);
    expect(codes({ label: "client session", needsConfirmation: false, decision: null })).toHaveLength(0);
  });
});

describe("refusal claim references are always resolvable (demo day: goal1_claim1)", () => {
  it("a refused GOAL claim is named whole and resolves via claimsById; a too-long id never yields a truncated field", () => {
    const evidence = [{ id: "ev_001", excerpt: "You wrote both dinners on the plan with one prompt." }];
    const goalId = demoPlan.goals[0]!.goalId;
    const longId = `c_${"y".repeat(70)}`;
    const facts: SessionFacts = {
      activities: [],
      observations: [],
      goals: [
        {
          goalId,
          status: "addressed",
          claims: [
            { id: "goal1_claim1", text: "Planned two dinners with decreasing prompts.", evidenceIds: ["ev_001"], support: "supported" },
            { id: longId, text: "Always plans dinners.", evidenceIds: ["ev_001"], support: "supported" },
          ],
        },
      ],
      progress: [],
      followUps: [],
      missingInformation: [],
    };
    const r = validateRequirements({ ...input({ facts, evidenceIds: ["ev_001"] }), evidence });
    const refused = r.issues.filter((i) => i.code === ISSUE_CODES.CLAIM_EXCEEDS_EVIDENCE);
    expect(refused.map((i) => i.field)).toEqual(["claim:goal1_claim1", "claims"]);
    const ids = claimsById(facts);
    expect(ids.has("goal1_claim1")).toBe(true);
    expect(refused[1]!.message).toContain(longId);
    expect(claimIssueField("a".repeat(MAX_REFERENCED_CLAIM_ID))).toBe(`claim:${"a".repeat(MAX_REFERENCED_CLAIM_ID)}`);
    expect(claimIssueField("a".repeat(MAX_REFERENCED_CLAIM_ID + 1))).toBe("claims");
  });
});
