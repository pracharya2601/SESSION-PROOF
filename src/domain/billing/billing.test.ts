import { describe, expect, it } from "vitest";
import { BillingDraft, type RateRule } from "../../contracts/schemas";
import { calculateBilling, minutesBetween, roundHalfUpCents } from "./index";

const rate: RateRule = { rateVersion: "rate_demo_v1", currency: "USD", hourlyRateCents: 7500, maxMinutes: 720 };

describe("calculateBilling", () => {
  it("confirmed 60 min → 7500", () => {
    const d = calculateBilling(rate, 60, 60);
    expect(d.amountCents).toBe(7500);
    expect(d.estimateAmountCents).toBeNull();
    expect(d.isEstimate).toBe(false);
    expect(d.rounding).toBe("half_up_to_cent");
    expect(d.breakdown).toBe("60 min × $75.00/hr = $75.00 (rate_demo_v1)");
    expect(BillingDraft.parse(d)).toEqual(d);
  });

  it("confirmed 90 min → 11250", () => {
    const d = calculateBilling(rate, 60, 90);
    expect(d.amountCents).toBe(11250);
    expect(d.confirmedMinutes).toBe(90);
    expect(d.breakdown).toBe("90 min × $75.00/hr = $112.50 (rate_demo_v1)");
  });

  it("unconfirmed → estimate 7500, amount null", () => {
    const d = calculateBilling(rate, 60, null);
    expect(d.amountCents).toBeNull();
    expect(d.confirmedMinutes).toBeNull();
    expect(d.estimateAmountCents).toBe(7500);
    expect(d.isEstimate).toBe(true);
    expect(d.breakdown).toContain("ESTIMATE");
    expect(d.breakdown).toContain("confirmed duration required");
    expect(BillingDraft.parse(d)).toEqual(d);
  });

  it("rounds half up: 7001 × 1 min = 116.68 → 117", () => {
    expect(calculateBilling({ ...rate, hourlyRateCents: 7001 }, 60, 1).amountCents).toBe(117);
  });

  it("exact .5 boundary rounds up; just below rounds down", () => {
    expect(roundHalfUpCents(30, 1)).toBe(1); // 0.5 → 1
    expect(roundHalfUpCents(7530, 1)).toBe(126); // 125.5 → 126
    expect(calculateBilling({ ...rate, hourlyRateCents: 7530 }, 60, 1).amountCents).toBe(126);
    expect(roundHalfUpCents(29, 1)).toBe(0); // 0.4833 → 0
    expect(roundHalfUpCents(89, 1)).toBe(1); // 1.4833 → 1
    expect(roundHalfUpCents(90, 1)).toBe(2); // 1.5 → 2
  });

  it("zero rate allowed", () => {
    expect(calculateBilling({ ...rate, hourlyRateCents: 0 }, 60, 60).amountCents).toBe(0);
  });

  it("confirmed at exactly maxMinutes is allowed", () => {
    expect(calculateBilling(rate, 60, 720).amountCents).toBe(90000);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects confirmedMinutes %s",
    (m) => {
      expect(() => calculateBilling(rate, 60, m)).toThrow(RangeError);
    },
  );

  it("rejects confirmed over declared max", () => {
    expect(() => calculateBilling(rate, 60, 721)).toThrow(/exceeds declared maximum/);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects scheduledMinutes %s", (m) => {
    expect(() => calculateBilling(rate, m, 60)).toThrow(RangeError);
    expect(() => calculateBilling(rate, m, null)).toThrow(RangeError);
  });

  it.each([-1, 75.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects hourlyRateCents %s", (r) => {
    expect(() => calculateBilling({ ...rate, hourlyRateCents: r }, 60, 60)).toThrow(RangeError);
  });

  it("rejects string-typed numeric input", () => {
    expect(() => calculateBilling(rate, 60, "60" as unknown as number)).toThrow(RangeError);
  });

  it("rejects safe-integer overflow", () => {
    const huge = { ...rate, hourlyRateCents: Number.MAX_SAFE_INTEGER };
    expect(() => calculateBilling(huge, 60, 2)).toThrow(/safe integer/);
    expect(() => calculateBilling(rate, Number.MAX_SAFE_INTEGER, null)).toThrow(/safe integer/);
  });
});

describe("minutesBetween", () => {
  it("fixture 10:00 → 11:00 = 60", () => {
    expect(minutesBetween("2026-11-13T10:00:00Z", "2026-11-13T11:00:00Z")).toBe(60);
  });
  it("truncates partial minutes and handles offsets", () => {
    expect(minutesBetween("2026-11-13T10:00:00Z", "2026-11-13T10:01:59Z")).toBe(1);
    expect(minutesBetween("2026-11-13T10:00:00-05:00", "2026-11-13T16:00:00+01:00")).toBe(0);
  });
  it("rejects invalid or reversed instants", () => {
    expect(() => minutesBetween("nope", "2026-11-13T11:00:00Z")).toThrow(RangeError);
    expect(() => minutesBetween("2026-11-13T11:00:00Z", "2026-11-13T10:00:00Z")).toThrow(RangeError);
  });
});
