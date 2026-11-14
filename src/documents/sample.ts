/** Synthetic DocModelInput for the template designer (no session chosen). Always fixture-marked. */
import { validReviewedBundle } from "../contracts/examples";
import type { ApprovalRecord, FinalBundle, SessionBundle } from "../contracts/schemas";
import type { ClientSnapshot, DocModelInput, DocumentTemplate } from "../contracts/v3";

const SAMPLE_SESSION_ID = "sess_sample_001";
const SAMPLE_PROVIDER_ID = "provider_sample_001";
const AT = "2026-11-13T19:45:00.000Z";

export function sampleDocModelInput(template: DocumentTemplate): DocModelInput {
  const base = validReviewedBundle;
  const bundle: SessionBundle = {
    ...base,
    sessionId: SAMPLE_SESSION_ID,
    appointment: { ...base.appointment, providerId: SAMPLE_PROVIDER_ID },
    attestations: [
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
    ],
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
    displayName: "Sample Participant",
    preferredName: "Sam",
    hourlyRateCents: bundle.billing.hourlyRateCents,
    fundingSource: "Sample self-direction waiver",
    authorizationNumber: "AUTH-SAMPLE-0001",
    fiscalIntermediary: "Sample Fiscal Services",
    authorizedHours: 40,
    caseManager: "Sample Case Manager",
    customFields: [{ label: "Program", value: "Community living skills (sample)" }],
    active: true,
    rateVersion: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    effectiveHourlyRateCents: bundle.billing.hourlyRateCents,
    capturedAt: "2026-11-13T19:50:00.000Z",
  };
  return { bundle, final, approval, providerIdentity: "Sample Provider", client, template };
}
