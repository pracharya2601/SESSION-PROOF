/**
 * Idempotent seed for the SYNTHETIC band scenarios (dev/test only).
 *
 * For each scenario: upsert its ServiceConfig, insert its client (insert-only, like
 * src/calendar/seed.ts, so a provider's edits survive re-seeding) and upsert ONE template
 * appointment for the demo provider. A band visit copies the plan/rule/rate versions of the
 * client's latest appointment (src/band/store.ts latestAppointmentForClient), so the template
 * is what links a visit to the scenario's config. It is dated 2026-01-05, far outside
 * discovery's 7-day lookback, so it never becomes a session on its own.
 */
import type { Appointment } from "../../src/contracts";
import type { Repository } from "../../src/db/repository";
import { DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY, FIXTURE_CLOCK_NOW } from "../scenario";
import { BAND_SCENARIOS } from "./scenarios";
import type { BandScenario } from "./types";

export const BAND_TEMPLATE_START = "2026-01-05T17:00:00.000Z"; // 09:00 America/Los_Angeles
export const BAND_TEMPLATE_END = "2026-01-05T18:00:00.000Z";

function slug(clientRef: string): string {
  return clientRef.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** Deterministic template appointment for a scenario (never prefixed appt_visit_). */
export function bandTemplateAppointment(s: BandScenario): Appointment {
  return {
    id: `appt_band_tpl_${slug(s.client.clientRef)}`,
    occurrenceId: `occ_band_tpl_${slug(s.client.clientRef)}`,
    providerId: DEMO_PROVIDER_ID,
    clientRef: s.client.clientRef,
    startAt: BAND_TEMPLATE_START,
    endAt: BAND_TEMPLATE_END,
    timezone: "America/Los_Angeles",
    serviceCode: s.plan.serviceCode,
    planVersion: s.plan.planVersion,
    ruleVersion: s.rules.ruleVersion,
    rateVersion: s.rate.rateVersion,
    canceled: false,
  };
}

export async function seedBandScenarios(repo: Repository, opts?: { now?: Date }): Promise<void> {
  const now = opts?.now ?? new Date(FIXTURE_CLOCK_NOW);
  await repo.upsertProvider(DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY);
  for (const s of BAND_SCENARIOS) {
    await repo.upsertServiceConfig(s.plan.serviceCode, { plan: s.plan, rules: s.rules, rate: s.rate });
    const existing = await repo.getClient(DEMO_PROVIDER_ID, s.client.clientRef);
    if (!existing) await repo.upsertClient(DEMO_PROVIDER_ID, s.client, now);
    await repo.upsertAppointment(bandTemplateAppointment(s));
  }
}
