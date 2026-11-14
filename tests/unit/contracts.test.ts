import { describe, expect, it } from "vitest";
import { Appointment, ApprovalRequest, EvidenceItem, Plan, ReviewEdits, SessionFacts } from "../../src/contracts";
import { demoAppointment, demoEvidence, demoFacts, demoPlan } from "../../fixtures/scenario";

describe("contracts + canonical fixture", () => {
  it("fixture validates against runtime schemas", () => {
    expect(() => Appointment.parse(demoAppointment)).not.toThrow();
    expect(() => Plan.parse(demoPlan)).not.toThrow();
    demoEvidence.forEach((e) => expect(() => EvidenceItem.parse(e)).not.toThrow());
    expect(() => SessionFacts.parse(demoFacts)).not.toThrow();
  });

  it("rejects non-allowlisted edits and bad approvals", () => {
    expect(ReviewEdits.safeParse({ amountCents: 1 }).success).toBe(false);
    expect(ReviewEdits.safeParse({}).success).toBe(false);
    expect(ReviewEdits.safeParse({ confirmedMinutes: 0 }).success).toBe(false);
    expect(ReviewEdits.safeParse({ confirmedMinutes: 90.5 }).success).toBe(false);
    expect(ReviewEdits.safeParse({ confirmedMinutes: 90 }).success).toBe(true);
    expect(
      ApprovalRequest.safeParse({ expectedRevision: 3, idempotencyKey: "demo-session-approval-request-001" }).success,
    ).toBe(true);
    expect(ApprovalRequest.safeParse({ expectedRevision: 3, idempotencyKey: "x", providerId: "p" }).success).toBe(false);
  });
});
