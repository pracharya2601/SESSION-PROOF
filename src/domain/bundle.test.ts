import { describe, expect, it } from "vitest";
import type { AssembleBundleInput, ProviderAttestation } from "../contracts";
import { demoAppointment, demoConfig, demoEvidence, demoFacts, EXPECTED, FIXTURE_CLOCK_NOW } from "../../fixtures/scenario";
import { assembleBundle, parseConfirmedMinutes } from "./bundle";

function input(attestations: ProviderAttestation[] = [], facts = demoFacts): AssembleBundleInput {
  return {
    sessionId: "sess_demo",
    bundleRevision: 1,
    processingRevision: 1,
    appointment: demoAppointment,
    config: demoConfig,
    evidence: demoEvidence,
    evidenceWindow: { from: "2026-11-13T18:05:00.000Z", to: "2026-11-13T18:53:00.000Z" },
    facts,
    attestations,
    provenance: {
      evidenceMode: "fixture",
      extractionMode: "fixture",
      runtimeMode: "local",
      schemaVersion: "1",
      promptVersion: "fixture-1",
      model: null,
      evidenceCompleteness: "complete",
      evidenceWarnings: [],
    },
    createdAt: FIXTURE_CLOCK_NOW,
  };
}
const att = (id: string, field: "progress" | "duration", text: string, at: string): ProviderAttestation => ({
  id, field, text, actorProviderId: "provider_demo_001", attestedAt: at, bundleRevision: 1,
});
const confirmed = [
  att("att_p", "progress", EXPECTED.demoProgressConfirmation, "2026-11-13T19:40:00.000Z"),
  att("att_d", "duration", "90", "2026-11-13T19:41:00.000Z"),
];

describe("assembleBundle", () => {
  it("blocks approval with no attestations; estimate only", () => {
    const b = assembleBundle(input());
    expect(b.checks.canApprove).toBe(false);
    const blocking = b.checks.issues.filter((i) => i.blocking).map((i) => i.code);
    expect(blocking).toContain("MISSING_PROGRESS");
    expect(blocking).toContain("MISSING_CONFIRMED_DURATION");
    expect(b.billing.estimateAmountCents).toBe(EXPECTED.estimateCents60);
    expect(b.billing.amountCents).toBeNull();
    expect(b.billing.scheduledMinutes).toBe(60);
  });

  it("approvable with progress attestation + 90 minutes; community goal still unknown", () => {
    const b = assembleBundle(input(confirmed));
    expect(b.checks.issues.filter((i) => i.blocking)).toEqual([]);
    expect(b.checks.canApprove).toBe(true);
    expect(b.billing.amountCents).toBe(EXPECTED.amountCents90);
    expect(b.billing.confirmedMinutes).toBe(90);
    expect(b.documents.timeSummary.confirmedMinutes).toBe(90);
    expect(b.documents.planCoverage.find((g) => g.goalId === "goal_community")!.status).toBe("unknown");
    const claim = b.facts.progress.find((c) => c.providerAttestationId === "att_p")!;
    expect(claim).toMatchObject({ support: "provider_confirmed", evidenceIds: [], text: EXPECTED.demoProgressConfirmation });
  });

  it("uses the latest duration attestation and parses strictly", () => {
    const b = assembleBundle(input([
      att("d2", "duration", "60", "2026-11-13T19:50:00.000Z"),
      att("d1", "duration", "90", "2026-11-13T19:41:00.000Z"),
    ]));
    expect(b.billing.confirmedMinutes).toBe(60);
    expect(b.billing.amountCents).toBe(EXPECTED.amountCents60);
    for (const bad of ["0", "-5", "90.5", "1e2", "abc", ""]) expect(parseConfirmedMinutes(bad)).toBeNull();
    expect(parseConfirmedMinutes("90")).toBe(90);
  });

  it("leaves extractedFacts unchanged and re-assembly does not duplicate claims", () => {
    const before = structuredClone(demoFacts);
    const b1 = assembleBundle(input(confirmed));
    expect(demoFacts).toEqual(before);
    expect(b1.extractedFacts).toEqual(before);
    const b2 = assembleBundle({ ...input(confirmed), facts: b1.extractedFacts });
    expect(b2.extractedFacts).toEqual(before);
    expect(b2.facts.progress).toHaveLength(1);
    expect(b2).toEqual(b1);
  });
});

describe("provider goal confirmation (assembly + documents)", () => {
  const transcriptOnly = {
    activities: [],
    observations: [],
    goals: demoConfig.plan.goals.map((g) => ({ goalId: g.goalId, status: "unknown" as const, claims: [] })),
    progress: [],
    followUps: [],
    missingInformation: ["AI extraction is not configured."],
  };
  const a = (id: string, field: ProviderAttestation["field"], text: string): ProviderAttestation => ({
    id, field, text, actorProviderId: "provider_demo_001", attestedAt: "2026-11-13T19:40:00.000Z", bundleRevision: 1,
  });

  it("renders confirmed goals as provider_confirmed (never evidence) and the summary as provider written", () => {
    const b = assembleBundle(
      input(
        [
          ...confirmed,
          a("att_g1", "goal_addressed", "goal_budget"),
          a("att_gx", "goal_addressed", "goal_unknown"),
          a("att_s", "activity_summary", "Reviewed the weekly food budget."),
        ],
        transcriptOnly,
      ),
    );
    expect(b.checks.issues.filter((i) => i.blocking)).toEqual([]);
    const cov = b.documents.planCoverage.find((g) => g.goalId === "goal_budget")!;
    expect(cov).toMatchObject({ status: "addressed", support: "provider_confirmed" });
    expect(b.documents.planCoverage.find((g) => g.goalId === "goal_transport")).toMatchObject({ status: "unknown" });
    expect(b.documents.planCoverage.find((g) => g.goalId === "goal_transport")!.support).toBeUndefined();
    // unknown plan goal ids are ignored in facts
    expect(b.facts.goals.some((g) => g.goalId === "goal_unknown")).toBe(false);
    const goalClaim = b.facts.goals.find((g) => g.goalId === "goal_budget")!.claims[0]!;
    expect(goalClaim).toMatchObject({ support: "provider_confirmed", evidenceIds: [], providerAttestationId: "att_g1" });
    // extracted facts stay untouched
    expect(b.extractedFacts.goals.every((g) => g.status === "unknown")).toBe(true);

    const coverage = b.documents.sections.find((s) => s.key === "plan_coverage")!.lines;
    const line = coverage.find((l) => l.text.startsWith("Practice budgeting."))!;
    expect(line).toMatchObject({ text: "Practice budgeting. — Addressed (provider-confirmed, not evidence)", origin: "provider_attestation", attestationIds: ["att_g1"], evidenceIds: [] });
    const note = b.documents.sections.find((s) => s.key === "session_note")!.lines;
    expect(note).toContainEqual(expect.objectContaining({ text: "Goal addressed (provider-confirmed, not evidence): Practice budgeting.", origin: "provider_attestation", attestationIds: ["att_g1"] }));
    expect(note).toContainEqual(expect.objectContaining({ text: "Activity summary (provider-written, not evidence): Reviewed the weekly food budget.", origin: "provider_attestation" }));
    expect(note.some((l) => l.text.startsWith("No supported activities"))).toBe(false);
  });

  it("an evidence-addressed goal that is also confirmed stays labelled as evidence", () => {
    const b = assembleBundle(input([...confirmed, a("att_g1", "goal_addressed", "goal_transport")]));
    expect(b.documents.planCoverage.find((g) => g.goalId === "goal_transport")).toMatchObject({ status: "addressed", support: "evidence" });
  });
});
