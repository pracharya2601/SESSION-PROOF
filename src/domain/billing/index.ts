/**
 * Pure billing calculation (Agent 13, spec §10.7 / §14.5).
 *
 * amountCents = round_half_up(hourlyRateCents × confirmedMinutes / 60), integer-only.
 *
 * Half-up proof: for n = rate × minutes ≥ 0,
 *   floor((2n + 60) / 120) = floor(n/60 + 1/2),
 * which is exactly "round half up" for nonnegative values. The division is done
 * with exact integer arithmetic: (x - x % 120) / 120, where x and the result are
 * safe integers, so no floating-point rounding is involved.
 *
 * Design choice: when confirmed, estimateAmountCents is null (the estimate is only
 * meaningful before confirmation; it must never be mistaken for the final amount).
 * Evidence-window duration is never used here; only provider-confirmed minutes.
 * No taxes, discounts, payer units or eligibility inference.
 */
import { BillingDraft, type RateRule } from "../../contracts/schemas";
import type { CalculateBillingFn } from "../../contracts/ports";

function assertSafe(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Billing arithmetic overflow: ${label} (${value}) exceeds safe integer bounds`);
  }
}

/** round_half_up(rateCents × minutes / 60) using exact integer arithmetic. */
export function roundHalfUpCents(hourlyRateCents: number, minutes: number): number {
  const product = hourlyRateCents * minutes;
  assertSafe(product, "rate × minutes");
  const numerator = product * 2 + 60;
  assertSafe(numerator, "2 × rate × minutes + 60");
  const result = (numerator - (numerator % 120)) / 120;
  assertSafe(result, "amount");
  return result;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateRate(rate: RateRule): void {
  if (rate === null || typeof rate !== "object") throw new RangeError("Rate rule is required");
  const r = rate.hourlyRateCents;
  if (!isNumber(r) || !Number.isInteger(r) || r < 0) {
    throw new RangeError(`hourlyRateCents must be a finite nonnegative integer (got ${String(r)})`);
  }
  assertSafe(r, "hourlyRateCents");
  const max = rate.maxMinutes;
  if (!isNumber(max) || !Number.isInteger(max) || max <= 0) {
    throw new RangeError(`rate.maxMinutes must be a finite positive integer (got ${String(max)})`);
  }
  if (typeof rate.rateVersion !== "string" || rate.rateVersion.length === 0) {
    throw new RangeError("rate.rateVersion is required");
  }
}

function formatUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}

export const calculateBilling: CalculateBillingFn = (rate, scheduledMinutes, confirmedMinutes) => {
  validateRate(rate);
  if (!isNumber(scheduledMinutes) || !Number.isInteger(scheduledMinutes) || scheduledMinutes < 0) {
    throw new RangeError(
      `scheduledMinutes must be a finite nonnegative integer (got ${String(scheduledMinutes)})`,
    );
  }
  assertSafe(scheduledMinutes, "scheduledMinutes");
  const rateStr = `${formatUsd(rate.hourlyRateCents)}/hr`;

  if (confirmedMinutes === null) {
    const estimate = roundHalfUpCents(rate.hourlyRateCents, scheduledMinutes);
    return BillingDraft.parse({
      currency: "USD",
      hourlyRateCents: rate.hourlyRateCents,
      scheduledMinutes,
      confirmedMinutes: null,
      amountCents: null,
      estimateAmountCents: estimate,
      isEstimate: true,
      rateVersion: rate.rateVersion,
      rounding: "half_up_to_cent",
      breakdown:
        `ESTIMATE from scheduled ${scheduledMinutes} min × ${rateStr} = ${formatUsd(estimate)} ` +
        `(${rate.rateVersion}) — confirmed duration required`,
    });
  }

  if (!isNumber(confirmedMinutes) || !Number.isInteger(confirmedMinutes) || confirmedMinutes <= 0) {
    throw new RangeError(
      `confirmedMinutes must be a finite positive whole number (got ${String(confirmedMinutes)})`,
    );
  }
  if (confirmedMinutes > rate.maxMinutes) {
    throw new RangeError(
      `confirmedMinutes (${confirmedMinutes}) exceeds declared maximum of ${rate.maxMinutes} minutes`,
    );
  }
  const amount = roundHalfUpCents(rate.hourlyRateCents, confirmedMinutes);
  return BillingDraft.parse({
    currency: "USD",
    hourlyRateCents: rate.hourlyRateCents,
    scheduledMinutes,
    confirmedMinutes,
    amountCents: amount,
    estimateAmountCents: null,
    isEstimate: false,
    rateVersion: rate.rateVersion,
    rounding: "half_up_to_cent",
    breakdown: `${confirmedMinutes} min × ${rateStr} = ${formatUsd(amount)} (${rate.rateVersion})`,
  });
};

/**
 * Whole minutes between two ISO-8601 instants (partial minutes are truncated).
 * Throws RangeError on unparseable input or when end precedes start.
 * Informational only — never a substitute for provider-confirmed minutes.
 */
export function minutesBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start)) throw new RangeError(`Invalid start instant: ${String(startIso)}`);
  if (!Number.isFinite(end)) throw new RangeError(`Invalid end instant: ${String(endIso)}`);
  if (end < start) throw new RangeError(`End instant ${endIso} precedes start ${startIso}`);
  return Math.floor((end - start) / 60_000);
}
