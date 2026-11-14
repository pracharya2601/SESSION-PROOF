/**
 * Bundle assembly contract. Implemented in src/domain/bundle.ts (pure).
 * Used by the Workflow (initial draft) and the review service (after edits)
 * so both paths rebuild documents/checks/billing identically.
 */
import type {
  Appointment,
  BundleProvenance,
  EvidenceItem,
  ProviderAttestation,
  ServiceConfig,
  SessionBundle,
  SessionFacts,
} from "./schemas";

export interface AssembleBundleInput {
  sessionId: string;
  bundleRevision: number;
  processingRevision: number;
  appointment: Appointment;
  config: ServiceConfig;
  evidence: EvidenceItem[];
  evidenceWindow: { from: string; to: string } | null;
  /** Extracted facts WITHOUT provider attestations merged in. */
  facts: SessionFacts;
  attestations: ProviderAttestation[];
  provenance: BundleProvenance;
  createdAt: string;
}

/**
 * Pure: merges attestations into facts (as provider_confirmed claims, never
 * rewritten as transcript-derived), derives confirmedMinutes from the latest
 * duration attestation, then runs documents -> rules -> billing.
 */
export type AssembleBundleFn = (input: AssembleBundleInput) => SessionBundle;
