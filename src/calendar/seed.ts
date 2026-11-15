/**
 * Deterministic SYNTHETIC demo seed (Agent 05). Uses only Repository upserts,
 * so repeated seeding never duplicates providers, config, or appointments.
 * Not mounted on public routes — called from the dev-only seed endpoint.
 */
import type { Repository } from "../db/repository";
import type { ClientInput, ProviderProfileInput } from "../contracts";
import { DEMO_LOGO_DATA_URL } from "./seed-logo";
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
 * Demo v3 client record for the demo appointment's client (fictional person — all fixture
 * people, businesses and numbers are made up). hourlyRateCents
 * is null so the agency default rate (7500) applies and the demo invoice stays $112.50.
 */
export const demoClientInput: ClientInput = {
  clientRef: demoAppointment.clientRef,
  displayName: "Sam Rivera",
  preferredName: "Sam",
  hourlyRateCents: null,
  fundingSource: "Regional Center — SDP spending plan",
  authorizationNumber: "SP-2026-0104",
  fiscalIntermediary: "Golden State Fiscal Services",
  authorizedHours: 40,
  caseManager: "Dana Whitfield",
  uciNumber: "7654321",
  fmsAddress: "PO Box 2210\nSacramento, CA 95812",
  authorizationOverride: null,
  representativeName: null,
  customFields: [{ label: "Program", value: "Independent living skills" }],
  templates: { session_note: null, invoice: null, approval_record: null },
  notes: null,
  active: true,
};

/**
 * Fictional business profile for the demo provider (dev seed only — production starts with an
 * empty profile until the provider fills Settings → Business profile). Vendor #, phone (555),
 * address and email (example.invalid) are made up.
 */
export const demoProviderProfile: ProviderProfileInput = {
  legalName: "Valley Oak Support Services LLC",
  dba: null,
  addressLine1: "2400 Example Way, Suite 210",
  addressLine2: null,
  city: "Sacramento",
  state: "CA",
  postalCode: "95815",
  phone: "(916) 555-0100",
  email: "billing@valleyoak.example.invalid",
  vendorNumber: "PV1234",
  npi: null,
  taxIdLast4: "0420",
  remitTo: null,
  signerName: "Alex Kim",
  logoDataUrl: DEMO_LOGO_DATA_URL,
  invoicePrefix: "VOS",
  nextInvoiceNumber: 1001,
  paymentTerms: "Net 30",
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
  // Insert-only: never overwrite a profile the provider edited.
  if (typeof repo.getProviderProfile === "function" && !(await repo.getProviderProfile(DEMO_PROVIDER_ID))) {
    await repo.saveProviderProfile(DEMO_PROVIDER_ID, demoProviderProfile, opts?.now ?? new Date(FIXTURE_CLOCK_NOW));
  }
}
