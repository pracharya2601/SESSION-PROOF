import { describe, expect, it } from "vitest";
import { MatchResult, type Appointment, type EvidenceItem, type EvidenceResult } from "../../contracts";
import { DEMO_PROVIDER_ID, OTHER_PROVIDER_ID, demoAppointment, demoEvidence } from "../../../fixtures/scenario";
import { DEFAULT_MATCH_BUFFER_MINUTES, matchEvidence } from "./index";

const result = (items: EvidenceItem[], extra: Partial<EvidenceResult> = {}): EvidenceResult => ({
  items,
  completeness: "complete",
  unavailableSourceIds: [],
  warnings: [],
  ...extra,
});

const item = (id: string, from: string | null, to: string | null, excerpt = "text"): EvidenceItem => ({
  id,
  sourceId: "src_test",
  sourceMode: "fixture",
  observedFrom: from,
  observedTo: to,
  speaker: null,
  excerpt,
  retrievedAt: "2026-11-13T19:30:00.000Z",
});

const appt = (over: Partial<Appointment>): Appointment => ({ ...demoAppointment, ...over });

describe("matchEvidence", () => {
  it("default buffer is 15 minutes", () => {
    expect(DEFAULT_MATCH_BUFFER_MINUTES).toBe(15);
  });

  it("fixture normal → matched with ev_001..ev_005", () => {
    const r = matchEvidence(demoAppointment, result(demoEvidence), []);
    expect(MatchResult.parse(r)).toEqual(r);
    expect(r.outcome).toBe("matched");
    expect(r.evidence.map((e) => e.id)).toEqual(["ev_001", "ev_002", "ev_003", "ev_004", "ev_005"]);
    expect(r.evidenceWindow).toEqual({ from: "2026-11-13T18:05:00.000Z", to: "2026-11-13T18:53:00.000Z" });
    expect(r.window).toEqual({ from: "2026-11-13T17:45:00.000Z", to: "2026-11-13T19:15:00.000Z" });
    expect(r.competingAppointmentIds).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const a = matchEvidence(demoAppointment, result(demoEvidence), []);
    const b = matchEvidence(demoAppointment, result(demoEvidence), []);
    expect(a).toEqual(b);
  });

  it("overlapping same-provider appointment → ambiguous", () => {
    const other = appt({ id: "appointment_demo_002", occurrenceId: "occ_2", clientRef: "C-200", startAt: "2026-11-13T18:30:00.000Z", endAt: "2026-11-13T19:30:00.000Z" });
    const r = matchEvidence(demoAppointment, result(demoEvidence), [other]);
    expect(r.outcome).toBe("ambiguous");
    expect(r.competingAppointmentIds).toEqual(["appointment_demo_002"]);
    expect(r.evidence).toEqual([]);
    expect(r.evidenceWindow).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/not prove/);
  });

  it("ignores the target itself in the competitor list", () => {
    const r = matchEvidence(demoAppointment, result(demoEvidence), [demoAppointment]);
    expect(r.outcome).toBe("matched");
  });

  it("other provider's overlapping appointment is ignored", () => {
    const other = appt({ id: "appointment_other_001", providerId: OTHER_PROVIDER_ID });
    const r = matchEvidence(demoAppointment, result(demoEvidence), [other]);
    expect(r.outcome).toBe("matched");
    expect(r.competingAppointmentIds).toEqual([]);
  });

  it("canceled competitor is ignored", () => {
    const other = appt({ id: "appointment_demo_003", providerId: DEMO_PROVIDER_ID, canceled: true });
    const r = matchEvidence(demoAppointment, result(demoEvidence), [other]);
    expect(r.outcome).toBe("matched");
  });

  it("non-overlapping same-provider appointment does not cause ambiguity", () => {
    const later = appt({ id: "appointment_demo_004", startAt: "2026-11-13T21:00:00.000Z", endAt: "2026-11-13T22:00:00.000Z" });
    const r = matchEvidence(demoAppointment, result(demoEvidence), [later]);
    expect(r.outcome).toBe("matched");
  });

  describe("buffer edges (closed intervals: touching the edge is inclusive)", () => {
    // window = 17:45:00.000 .. 19:15:00.000
    it("item ending exactly at window.from is eligible", () => {
      const r = matchEvidence(demoAppointment, result([item("e1", "2026-11-13T17:40:00.000Z", "2026-11-13T17:45:00.000Z")]), []);
      expect(r.outcome).toBe("matched");
    });
    it("item ending 1 ms before window.from is not eligible", () => {
      const r = matchEvidence(demoAppointment, result([item("e1", "2026-11-13T17:40:00.000Z", "2026-11-13T17:44:59.999Z")]), []);
      expect(r.outcome).toBe("no_evidence");
    });
    it("item starting exactly at window.to is eligible", () => {
      const r = matchEvidence(demoAppointment, result([item("e1", "2026-11-13T19:15:00.000Z", "2026-11-13T19:16:00.000Z")]), []);
      expect(r.outcome).toBe("matched");
    });
    it("item starting 1 ms after window.to is not eligible", () => {
      const r = matchEvidence(demoAppointment, result([item("e1", "2026-11-13T19:15:00.001Z", "2026-11-13T19:16:00.000Z")]), []);
      expect(r.outcome).toBe("no_evidence");
    });
    it("bufferMinutes option is honored", () => {
      const ev = [item("e1", "2026-11-13T17:50:00.000Z", "2026-11-13T17:51:00.000Z")];
      expect(matchEvidence(demoAppointment, result(ev), [], { bufferMinutes: 0 }).outcome).toBe("no_evidence");
      expect(matchEvidence(demoAppointment, result(ev), [], { bufferMinutes: 10 }).outcome).toBe("matched");
    });
    it("rejects negative buffer", () => {
      expect(() => matchEvidence(demoAppointment, result([]), [], { bufferMinutes: -1 })).toThrow(RangeError);
    });
    it("back-to-back same-provider visit whose buffered window touches the evidence → ambiguous", () => {
      // competitor 19:30–20:30 → buffered from 19:15; item at 19:10–19:15 touches it
      const next = appt({ id: "appointment_demo_005", startAt: "2026-11-13T19:30:00.000Z", endAt: "2026-11-13T20:30:00.000Z" });
      const ev = [item("e1", "2026-11-13T19:10:00.000Z", "2026-11-13T19:15:00.000Z")];
      expect(matchEvidence(demoAppointment, result(ev), [next]).outcome).toBe("ambiguous");
      const ev2 = [item("e1", "2026-11-13T19:10:00.000Z", "2026-11-13T19:14:59.999Z")];
      expect(matchEvidence(demoAppointment, result(ev2), [next]).outcome).toBe("matched");
    });
  });

  it("cross-midnight local appointment matches evidence on both sides of local midnight", () => {
    // 2026-11-13 23:30 → 2026-11-14 00:30 America/Los_Angeles (PST, UTC−8)
    const night = appt({ id: "appointment_night", startAt: "2026-11-14T07:30:00.000Z", endAt: "2026-11-14T08:30:00.000Z", timezone: "America/Los_Angeles" });
    const ev = [
      item("before_midnight", "2026-11-14T07:50:00.000Z", "2026-11-14T07:51:00.000Z"), // 23:50 local, Nov 13
      item("after_midnight", "2026-11-14T08:10:00.000Z", "2026-11-14T08:11:00.000Z"), // 00:10 local, Nov 14
      item("next_day_far", "2026-11-14T10:00:00.000Z", "2026-11-14T10:01:00.000Z"),
    ];
    const r = matchEvidence(night, result(ev), []);
    expect(r.outcome).toBe("matched");
    expect(r.evidence.map((e) => e.id)).toEqual(["before_midnight", "after_midnight"]);
    expect(r.evidenceWindow).toEqual({ from: "2026-11-14T07:50:00.000Z", to: "2026-11-14T08:11:00.000Z" });
  });

  it("null timestamps are not eligible and produce a warning", () => {
    const ev = [...demoEvidence, item("ev_null", null, null), item("ev_half", "2026-11-13T18:30:00.000Z", null)];
    const r = matchEvidence(demoAppointment, result(ev), []);
    expect(r.outcome).toBe("matched");
    expect(r.evidence.map((e) => e.id)).not.toContain("ev_null");
    expect(r.evidence.map((e) => e.id)).not.toContain("ev_half");
    expect(r.warnings.join(" ")).toMatch(/ev_null, ev_half/);
  });

  it("only untimed items → no_evidence with warning", () => {
    const r = matchEvidence(demoAppointment, result([item("ev_null", null, null)]), []);
    expect(r.outcome).toBe("no_evidence");
    expect(r.warnings.length).toBe(1);
  });

  it("empty successful retrieval → no_evidence", () => {
    const r = matchEvidence(demoAppointment, result([]), []);
    expect(r.outcome).toBe("no_evidence");
    expect(r.evidence).toEqual([]);
    expect(r.evidenceWindow).toBeNull();
    expect(r.reasons[0]).toMatch(/no evidence items/);
  });

  it("partial completeness and unavailable sources propagate as warnings", () => {
    const r = matchEvidence(
      demoAppointment,
      result(demoEvidence.slice(0, 2), { completeness: "partial", unavailableSourceIds: ["src_page_2"], warnings: ["page 2 timed out"] }),
      [],
    );
    expect(r.outcome).toBe("matched");
    expect(r.warnings).toEqual(expect.arrayContaining(["page 2 timed out"]));
    expect(r.warnings.join(" ")).toMatch(/partial/);
    expect(r.warnings.join(" ")).toMatch(/src_page_2/);
  });

  it("unknown completeness with no evidence notes inconclusive absence", () => {
    const r = matchEvidence(demoAppointment, result([], { completeness: "unknown" }), []);
    expect(r.outcome).toBe("no_evidence");
    expect(r.warnings.join(" ")).toMatch(/unknown/);
    expect(r.reasons.join(" ")).toMatch(/not conclusive/);
  });

  it("never uses text: a name in an excerpt does not change attribution", () => {
    const other = appt({ id: "appointment_demo_002", clientRef: "C-200" });
    const ev = [item("e1", "2026-11-13T18:10:00.000Z", "2026-11-13T18:11:00.000Z", "This session is for client C-104 only, not C-200.")];
    expect(matchEvidence(demoAppointment, result(ev), [other]).outcome).toBe("ambiguous");
  });
});
