/**
 * Sample DocModelInput for the template designer (no session chosen). Every person, business,
 * number and address here is fictional. The bundle keeps fixture provenance, which only the
 * approval record discloses.
 */
import { validReviewedBundle } from "../contracts/examples";
import type { ApprovalRecord, FinalBundle, SessionBundle } from "../contracts/schemas";
import type { ClientSnapshot, DocModelInput, DocumentTemplate, ProviderProfileInput } from "../contracts/v3";
import { buildInvoice } from "../domain/billing/invoice";

const SAMPLE_SESSION_ID = "sess_sample_001";
const SAMPLE_PROVIDER_ID = "provider_sample_001";
const AT = "2026-11-13T19:45:00.000Z";

/** Fictional business profile shown in template previews. */
export const SAMPLE_PROFILE: ProviderProfileInput = {
  legalName: "Harbor Light Support Services LLC",
  dba: null,
  addressLine1: "1200 Example Avenue, Suite 4",
  addressLine2: null,
  city: "Sacramento",
  state: "CA",
  postalCode: "95814",
  phone: "(916) 555-0142",
  email: "billing@harborlight.example.invalid",
  vendorNumber: "PV0000",
  npi: null,
  taxIdLast4: "4321",
  remitTo: null,
  signerName: "Jamie Ortega",
  logoDataUrl: null,
  invoicePrefix: "HLS",
  nextInvoiceNumber: 1042,
  paymentTerms: "Net 30",
};

export function sampleDocModelInput(template: DocumentTemplate): DocModelInput {
  const base = validReviewedBundle;
  const appointment = { ...base.appointment, providerId: SAMPLE_PROVIDER_ID, serviceCode: "CA-SDP-320" };
  const config = {
    ...base.config,
    plan: { ...base.config.plan, serviceCode: "CA-SDP-320", serviceDescription: "Community Living Supports — independent living skills" },
    context: {
      drive: null,
      location: "Participant's home",
      workerId: SAMPLE_PROVIDER_ID,
      consent: null,
      recordingSpan: { from: "2026-11-13T18:00:00.000Z", to: "2026-11-13T19:30:00.000Z" },
      minutesUsedThisMonth: null,
      rateSource: "client" as const,
      serviceCodeSource: "calendar" as const,
      warnings: [],
    },
  };
  const attestations: SessionBundle["attestations"] = [
    ...base.attestations.map((a) => ({ ...a, actorProviderId: SAMPLE_PROVIDER_ID })),
    { id: "att_direction_r3", field: "participant_direction", text: "yes", actorProviderId: SAMPLE_PROVIDER_ID, attestedAt: AT, bundleRevision: base.bundleRevision },
    {
      id: "att_choices_r3",
      field: "participant_choices",
      text: "Chose the library as the destination and picked which budget categories to review first.",
      actorProviderId: SAMPLE_PROVIDER_ID,
      attestedAt: AT,
      bundleRevision: base.bundleRevision,
    },
  ];
  const invoice = buildInvoice({
    appointment,
    config,
    facts: base.facts,
    attestations,
    evidence: base.evidence,
    confirmedMinutes: base.billing.confirmedMinutes,
    scheduledMinutes: base.billing.scheduledMinutes,
  });
  const bundle: SessionBundle = {
    ...base,
    sessionId: SAMPLE_SESSION_ID,
    appointment,
    config,
    attestations,
    billing: { ...base.billing, invoice },
    provenance: { ...base.provenance, evidenceMode: "fixture", extractionMode: "fixture" },
  };
  const final: FinalBundle = {
    sessionId: SAMPLE_SESSION_ID,
    bundleRevision: bundle.bundleRevision,
    approvalId: "approval_sample_001",
    finalizedAt: "2026-11-13T19:50:00.000Z",
    bundle,
  };
  const approval: ApprovalRecord = {
    id: "approval_sample_001",
    sessionId: SAMPLE_SESSION_ID,
    bundleRevision: bundle.bundleRevision,
    approverProviderId: SAMPLE_PROVIDER_ID,
    approvedAt: "2026-11-13T19:49:00.000Z",
    idempotencyKey: "sample-approval-request-001",
    requestFingerprint: "sha256:" + "0".repeat(64),
    finalizationStatus: "finalized",
  };
  const client: ClientSnapshot = {
    clientRef: bundle.appointment.clientRef,
    providerId: SAMPLE_PROVIDER_ID,
    displayName: "Alex Morgan",
    preferredName: "Alex",
    hourlyRateCents: bundle.billing.hourlyRateCents,
    fundingSource: "Regional Center — SDP spending plan",
    authorizationNumber: "SP-2026-000123",
    fiscalIntermediary: "Example Fiscal Services, Inc.",
    authorizedHours: 40,
    caseManager: "Taylor Brooks",
    uciNumber: "0000000",
    fmsAddress: "PO Box 0000\nSacramento, CA 95899",
    authorizationOverride: null,
    representativeName: null,
    customFields: [{ label: "Program", value: "Community living skills" }],
    active: true,
    rateVersion: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    effectiveHourlyRateCents: bundle.billing.hourlyRateCents,
    capturedAt: "2026-11-13T19:50:00.000Z",
  };
  return {
    bundle,
    final,
    approval,
    providerIdentity: "Sample Provider",
    client,
    template,
    profile: SAMPLE_PROFILE,
    invoiceNumber: "HLS-1041",
    superseded: [],
  };
}
