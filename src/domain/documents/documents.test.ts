import { describe, expect, it } from "vitest";
import { Documents, type DocumentInput, type ProviderAttestation } from "../../contracts";
import { demoAppointment, demoEvidence, demoFacts, demoPlan, EXPECTED } from "../../../fixtures/scenario";
import { generateDocuments } from "./index";

function input(over: Partial<DocumentInput> = {}): DocumentInput {
  return {
    appointment: demoAppointment,
    plan: demoPlan,
    facts: demoFacts,
    attestations: [],
    evidence: demoEvidence,
    evidenceWindow: { from: "2026-11-13T18:05:00.000Z", to: "2026-11-13T18:53:00.000Z" },
    evidenceCompleteness: "complete",
    evidenceWarnings: [],
    confirmedMinutes: null,
    ...over,
  };
}
const progressAtt: ProviderAttestation = {
  id: "att_progress_1",
  field: "progress",
  text: EXPECTED.demoProgressConfirmation,
  actorProviderId: "provider_demo_001",
  attestedAt: "2026-11-13T19:45:00.000Z",
  bundleRevision: 1,
};
const section = (d: Documents, key: string) => d.sections.find((s) => s.key === key)!;

describe("generateDocuments", () => {
  it("renders the normal fixture deterministically with ordered sections and provenance", () => {
    const d = generateDocuments(input());
    expect(() => Documents.parse(d)).not.toThrow();
    expect(d.sections.map((s) => s.key)).toEqual([
      "session_note",
      "progress_record",
      "plan_coverage",
      "follow_ups",
      "missing_information",
      "time_summary",
    ]);
    expect(generateDocuments(input())).toEqual(d);
    const note = section(d, "session_note");
    expect(note.lines[0]!.text).toContain(demoPlan.serviceDescription);
    expect(note.lines.some((l) => l.text.includes("2026-11-13"))).toBe(true);
    const act = note.lines.find((l) => l.claimIds.includes("fact_act_1"))!;
    expect(act.origin).toBe("extracted");
    expect(act.evidenceIds).toEqual(["ev_001", "ev_002"]);
    expect(note.lines.some((l) => l.claimIds.includes("fact_obs_1"))).toBe(true);
    const fu = section(d, "follow_ups").lines[0]!;
    expect(fu.text).toBe("Recorded only — not sent: Provider to bring another route-planning worksheet next session.");
    expect(fu.claimIds).toEqual(["fact_fu_1"]);
    for (const s of d.sections) for (const l of s.lines) {
      expect(l.text).not.toMatch(/<[a-z]/i);
      expect(Array.isArray(l.claimIds) && Array.isArray(l.evidenceIds) && Array.isArray(l.attestationIds)).toBe(true);
    }
    // time summary: never substitutes evidence window or schedule for confirmation
    expect(d.timeSummary.scheduledMinutes).toBe(60);
    expect(d.timeSummary.evidenceWindowMinutes).toBe(48);
    expect(d.timeSummary.confirmedMinutes).toBeNull();
    const time = section(d, "time_summary").lines.map((l) => l.text);
    expect(time[0]).toContain("10:00–11:00");
    expect(time.some((t) => t.includes("Not yet confirmed by provider"))).toBe(true);
    // missing info from facts
    expect(section(d, "missing_information").lines.map((l) => l.text)).toEqual(demoFacts.missingInformation);
  });

  it("shows a missing-progress notice when no supported progress exists", () => {
    const lines = section(generateDocuments(input()), "progress_record").lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: "No supported progress statement — provider confirmation required.",
      origin: "system_notice",
    });
  });

  it("keeps provider attestation provenance and never relabels it as extracted", () => {
    const merged = {
      ...demoFacts,
      progress: [{ id: "claim_att_progress_1", text: progressAtt.text, evidenceIds: [], support: "provider_confirmed" as const, providerAttestationId: progressAtt.id }],
    };
    const d = generateDocuments(input({ facts: merged, attestations: [progressAtt], confirmedMinutes: 90 }));
    const lines = section(d, "progress_record").lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      text: `Provider-confirmed (not evidence): ${EXPECTED.demoProgressConfirmation}`,
      claimIds: [],
      evidenceIds: [],
      attestationIds: ["att_progress_1"],
      origin: "provider_attestation",
    });
    const conf = section(d, "time_summary").lines.at(-1)!;
    expect(conf.text).toBe("Confirmed duration: 90 minutes (provider-confirmed, not evidence)");
    expect(conf.origin).toBe("provider_attestation");
  });

  it("keeps the unknown community goal visible and separate from progress", () => {
    const d = generateDocuments(input());
    const community = d.planCoverage.find((e) => e.goalId === "goal_community")!;
    expect(community.status).toBe("unknown");
    expect(community.claimIds).toEqual([]);
    const cov = section(d, "plan_coverage").lines;
    expect(cov).toHaveLength(3);
    expect(cov[2]!.text).toBe("Practice community interaction. — Unknown — no supporting evidence");
    expect(cov[0]!.text).toMatch(/Addressed/);
    expect(cov[1]!.text).toMatch(/Partially addressed/);
    expect(d.planCoverage.map((e) => e.status)).toEqual(["addressed", "partially_addressed", "unknown"]);
    expect(section(d, "progress_record").lines.some((l) => l.text.includes("community"))).toBe(false);
  });

  it("surfaces partial retrieval as system notices", () => {
    const d = generateDocuments(input({ evidenceCompleteness: "partial", evidenceWarnings: ["Source src_2 unavailable"] }));
    const notices = section(d, "missing_information").lines.filter((l) => l.origin === "system_notice").map((l) => l.text);
    expect(notices).toContain("Evidence retrieval was partial — some sources may be missing.");
    expect(notices.some((t) => t.includes("Source src_2 unavailable"))).toBe(true);
  });
});
