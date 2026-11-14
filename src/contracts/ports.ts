/**
 * Frozen module signatures (handoff §9.1). Implementations live in their
 * owned directories; consumers depend on these types only.
 */
import type {
  Appointment,
  BillingDraft,
  DocumentationChecks,
  Documents,
  EvidenceItem,
  EvidenceResult,
  MatchResult,
  Plan,
  ProviderAttestation,
  RateRule,
  RuleSet,
  SessionFacts,
  SourceMode,
} from "./schemas";

/** Injectable clock — never read Date.now() directly in domain/job code. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

// ----------------------------------------------------------- evidence (07)
export interface EvidenceSource {
  readonly mode: SourceMode;
  /**
   * Retrieve evidence relevant to one appointment window.
   * MUST reject (throw EvidenceUnavailableError) on auth/transport/tool errors;
   * an empty `items` array means retrieval succeeded and found nothing.
   */
  retrieveEvidence(appointment: Appointment): Promise<EvidenceResult>;
}

export class EvidenceUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "transport" | "tool" | "not_configured" | "rate_limited",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EvidenceUnavailableError";
  }
}

// ----------------------------------------------------------- matching (08)
export type MatchEvidenceFn = (
  appointment: Appointment,
  evidence: EvidenceResult,
  competingAppointments: Appointment[],
  options?: { bufferMinutes?: number },
) => MatchResult;

// ----------------------------------------------------------- extraction (10)
export interface ExtractionContext {
  appointment: Appointment;
  plan: Plan;
  evidence: EvidenceItem[];
}
export interface ExtractionOutput {
  facts: SessionFacts;
  mode: SourceMode;
  model: string | null;
  promptVersion: string;
}
export interface Extractor {
  readonly mode: SourceMode;
  /** MUST throw ExtractionRejectedError on malformed/invalid/uncited output. */
  extractFacts(ctx: ExtractionContext): Promise<ExtractionOutput>;
}
export class ExtractionRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: "malformed" | "schema" | "unknown_evidence" | "unknown_goal" | "provider_error",
  ) {
    super(message);
    this.name = "ExtractionRejectedError";
  }
}

// ----------------------------------------------------------- documents (11)
export interface DocumentInput {
  appointment: Appointment;
  plan: Plan;
  facts: SessionFacts;
  attestations: ProviderAttestation[];
  evidence: EvidenceItem[];
  evidenceWindow: { from: string; to: string } | null;
  evidenceCompleteness: "complete" | "partial" | "unknown";
  evidenceWarnings: string[];
  confirmedMinutes: number | null;
}
export type GenerateDocumentsFn = (input: DocumentInput) => Documents;

// ----------------------------------------------------------- rules (12)
export interface RulesInput {
  appointment: Appointment;
  plan: Plan;
  rules: RuleSet;
  facts: SessionFacts;
  documents: Documents;
  attestations: ProviderAttestation[];
  evidenceIds: string[];
  confirmedMinutes: number | null;
  evidenceCompleteness: "complete" | "partial" | "unknown";
}
export type ValidateRequirementsFn = (input: RulesInput) => DocumentationChecks;

// ----------------------------------------------------------- billing (13)
export type CalculateBillingFn = (
  rate: RateRule,
  scheduledMinutes: number,
  confirmedMinutes: number | null,
) => BillingDraft;
