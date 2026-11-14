/**
 * Deterministic SYNTHETIC demo seed (Agent 05). Uses only Repository upserts,
 * so repeated seeding never duplicates providers, config, or appointments.
 * Not mounted on public routes — called from the dev-only seed endpoint.
 */
import type { Repository } from "../db/repository";
import type { ClientInput } from "../contracts";
import {
  FIXTURE_CLOCK_NOW,
  DEMO_PROVIDER_ID,
  DEMO_PROVIDER_IDENTITY,
  OTHER_PROVIDER_ID,
  OTHER_PROVIDER_IDENTITY,
  demoAppointment,
  demoConfig,
} from "../../fixtures/scenario";
import { getVariant } from "../../fixtures/variants";

/**
 * SYNTHETIC v3 client record for the demo appointment's client. hourlyRateCents
 * is null so the agency default rate (7500) applies and the demo invoice stays $112.50.
 */
export const demoClientInput: ClientInput = {
  clientRef: demoAppointment.clientRef,
  displayName: "Sam Rivera (synthetic)",
  preferredName: "Sam",
  hourlyRateCents: null,
  fundingSource: "Self-directed budget (demo)",
  authorizationNumber: "AUTH-DEMO-0001",
  fiscalIntermediary: "Demo FMS Inc.",
  authorizedHours: 40,
  caseManager: "Demo Case Manager",
  customFields: [{ label: "Program", value: "ILS Demo" }],
  templates: { session_note: null, invoice: null, approval_record: null },
  notes: null,
  active: true,
};

export async function seedDemoData(repo: Repository, opts?: { variant?: string; now?: Date }): Promise<void> {
  const variant = getVariant(opts?.variant ?? "normal");
  await repo.upsertProvider(DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY);
  await repo.upsertProvider(OTHER_PROVIDER_ID, OTHER_PROVIDER_IDENTITY);
  await repo.upsertServiceConfig(demoConfig.plan.serviceCode, demoConfig);
  await repo.upsertAppointment(demoAppointment);
  for (const appt of variant.extraAppointments) await repo.upsertAppointment(appt);
  // Insert-only: re-seeding never overwrites the provider's own edits to the client.
  const existing = await repo.getClient(demoAppointment.providerId, demoClientInput.clientRef);
  if (!existing) await repo.upsertClient(demoAppointment.providerId, demoClientInput, opts?.now ?? new Date(FIXTURE_CLOCK_NOW));
}
