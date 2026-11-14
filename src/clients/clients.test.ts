import { describe, expect, it } from "vitest";
import { ClientSnapshot, type ClientRecord, type RateRule } from "../contracts";
import { clientKnownTerms, effectiveRate, snapshotClient } from "./index";

const rate: RateRule = { rateVersion: "rate_demo_v1", currency: "USD", hourlyRateCents: 7500, maxMinutes: 240 };

const client = (over: Partial<ClientRecord> = {}): ClientRecord => ({
  clientRef: "C-104",
  providerId: "provider_demo_001",
  displayName: "Sam Rivera (synthetic)",
  preferredName: "Sam",
  hourlyRateCents: 9000,
  fundingSource: "Self-directed budget (demo)",
  authorizationNumber: "AUTH-DEMO-0001",
  fiscalIntermediary: "Demo FMS Inc.",
  authorizedHours: 40,
  caseManager: "Demo Case Manager",
  customFields: [{ label: "Program", value: "ILS Demo" }],
  templates: { session_note: "tpl_x", invoice: null, approval_record: null },
  notes: "private note",
  active: true,
  rateVersion: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...over,
});

describe("effectiveRate", () => {
  it("applies an active client's own rate with a client rate version", () => {
    expect(effectiveRate(rate, client())).toEqual({ ...rate, hourlyRateCents: 9000, rateVersion: "client:C-104:v3" });
  });
  it("keeps the default for inactive clients, null client rate, or no client", () => {
    expect(effectiveRate(rate, client({ active: false }))).toEqual(rate);
    expect(effectiveRate(rate, client({ hourlyRateCents: null }))).toEqual(rate);
    expect(effectiveRate(rate, null)).toEqual(rate);
  });
  it("a zero rate is still a client rate", () => {
    expect(effectiveRate(rate, client({ hourlyRateCents: 0 })).hourlyRateCents).toBe(0);
  });
});

describe("snapshotClient", () => {
  it("omits notes/templates, uses the frozen bundle rate, and validates", () => {
    const frozen = { ...rate, hourlyRateCents: 8000 };
    const snap = snapshotClient(client(), frozen, new Date("2026-11-13T20:00:00.000Z"));
    expect(snap).not.toHaveProperty("notes");
    expect(snap).not.toHaveProperty("templates");
    expect(snap.effectiveHourlyRateCents).toBe(8000);
    expect(snap.capturedAt).toBe("2026-11-13T20:00:00.000Z");
    expect(snap.authorizationNumber).toBe("AUTH-DEMO-0001");
    expect(ClientSnapshot.strict().safeParse(snap).success).toBe(true);
  });
  it("is detached from the live record", () => {
    const c = client();
    const snap = snapshotClient(c, rate, new Date());
    c.customFields[0]!.value = "changed";
    expect(snap.customFields[0]!.value).toBe("ILS Demo");
  });
});

describe("clientKnownTerms", () => {
  it("returns full names and name parts >= 3 chars, deduped, without parenthetical qualifiers", () => {
    expect(clientKnownTerms(client())).toEqual([
      { value: "Sam Rivera (synthetic)", type: "NAME" },
      { value: "Sam", type: "NAME" },
      { value: "Rivera", type: "NAME" },
    ]);
  });
  it("skips short parts and empty names", () => {
    expect(clientKnownTerms(client({ displayName: "Jo Ann Li-Wong", preferredName: "  " }))).toEqual([
      { value: "Jo Ann Li-Wong", type: "NAME" },
      { value: "Ann", type: "NAME" },
      { value: "Li-Wong", type: "NAME" },
    ]);
    expect(clientKnownTerms(client({ displayName: null, preferredName: null }))).toEqual([]);
    expect(clientKnownTerms(null)).toEqual([]);
  });
});
