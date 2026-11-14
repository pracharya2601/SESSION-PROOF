/**
 * Deterministic SYNTHETIC demo seed (Agent 05). Uses only Repository upserts,
 * so repeated seeding never duplicates providers, config, or appointments.
 * Not mounted on public routes — called from the dev-only seed endpoint.
 */
import type { Repository } from "../db/repository";
import {
  DEMO_PROVIDER_ID,
  DEMO_PROVIDER_IDENTITY,
  OTHER_PROVIDER_ID,
  OTHER_PROVIDER_IDENTITY,
  demoAppointment,
  demoConfig,
} from "../../fixtures/scenario";
import { getVariant } from "../../fixtures/variants";

export async function seedDemoData(repo: Repository, opts?: { variant?: string }): Promise<void> {
  const variant = getVariant(opts?.variant ?? "normal");
  await repo.upsertProvider(DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY);
  await repo.upsertProvider(OTHER_PROVIDER_ID, OTHER_PROVIDER_IDENTITY);
  await repo.upsertServiceConfig(demoConfig.plan.serviceCode, demoConfig);
  await repo.upsertAppointment(demoAppointment);
  for (const appt of variant.extraAppointments) await repo.upsertAppointment(appt);
}
