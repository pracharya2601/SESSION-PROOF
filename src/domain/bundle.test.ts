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
