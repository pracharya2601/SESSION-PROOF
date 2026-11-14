/**
 * Deterministic documentation checks (Agent 12). Pure: no I/O, no clock.
 *
 * These checks confirm that required documentation elements are present and
 * backed by known evidence or explicit provider attestations. They do NOT
 * establish legal, clinical, or payer acceptance. Uncertain claims never
 * satisfy a requirement, and no model confidence value is consulted.
 */
import {
  MAX_CONFIRMED_MINUTES,
  type DocumentationChecks,
  type DocumentationIssue,
  type FactClaim,
  type ProviderAttestation,
  type RequiredField,
  type RulesInput,
  type SessionFacts,
  type ValidateRequirementsFn,
} from "../../contracts";

export const ISSUE_CODES = {
  MISSING_SERVICE_DATE: "MISSING_SERVICE_DATE",
  MISSING_PROVIDER_IDENTITY: "MISSING_PROVIDER_IDENTITY",
  MISSING_CLIENT_REFERENCE: "MISSING_CLIENT_REFERENCE",
  MISSING_SERVICE_DESCRIPTION: "MISSING_SERVICE_DESCRIPTION",
  NO_GOAL_ADDRESSED: "NO_GOAL_ADDRESSED",
  MISSING_PROGRESS: "MISSING_PROGRESS",
  MISSING_CONFIRMED_DURATION: "MISSING_CONFIRMED_DURATION",
  UNSUPPORTED_CLAIM: "UNSUPPORTED_CLAIM",
  UNKNOWN_GOAL_COVERAGE: "UNKNOWN_GOAL_COVERAGE",
  PARTIAL_EVIDENCE: "PARTIAL_EVIDENCE",
} as const;
export type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES];

const PLACEHOLDERS = new Set(["unknown", "n/a", "na", "tbd", "todo", "none", "-", "?", "lorem ipsum"]);

/** Trimmed, non-empty, not a placeholder, and contains at least one letter or digit. */
export function isMeaningfulText(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "") return false;
  if (PLACEHOLDERS.has(s) || PLACEHOLDERS.has(s.replace(/[.!]+$/, ""))) return false;
  return /[\p{L}\p{N}]/u.test(s);
}

function issue(code: IssueCode, field: string, message: string, blocking: boolean): DocumentationIssue {
  return { code, field: field.slice(0, 64), message, blocking };
}

function allClaims(facts: SessionFacts): FactClaim[] {
  return [
    ...facts.activities,
    ...facts.observations,
    ...facts.goals.flatMap((g) => g.claims),
    ...facts.progress,
    ...facts.followUps,
  ];
}

export const validateRequirements: ValidateRequirementsFn = (input: RulesInput): DocumentationChecks => {
  const { appointment, plan, rules, facts, attestations, confirmedMinutes, evidenceCompleteness } = input;
  const known = new Set(input.evidenceIds);
  const issues: DocumentationIssue[] = [];

  const citesKnownEvidence = (c: FactClaim): boolean =>
    c.evidenceIds.length > 0 && c.evidenceIds.every((id) => known.has(id));
  /** A "supported" claim with meaningful text whose every citation is in the evidence set. */
  const isBackedSupported = (c: FactClaim): boolean =>
    c.support === "supported" && isMeaningfulText(c.text) && citesKnownEvidence(c);

  const progressAttestations: ProviderAttestation[] = rules.allowProviderProgressAttestation
    ? attestations.filter((a) => a.field === "progress" && isMeaningfulText(a.text))
    : [];
  const attestationIds = new Set(progressAttestations.map((a) => a.id));
  // Provider goal confirmations count only for goals in this session's plan.
  const planGoalIds = new Set(plan.goals.map((g) => g.goalId));
  const goalAttestationIds = new Set(
    attestations.filter((a) => a.field === "goal_addressed" && planGoalIds.has(a.text.trim())).map((a) => a.id),
  );
  const hasActivitySummary = attestations.some((a) => a.field === "activity_summary" && isMeaningfulText(a.text));

  // Supported claims citing unknown evidence are always blocking.
  const seen = new Set<string>();
  for (const c of allClaims(facts)) {
    if (c.support !== "supported" || seen.has(c.id)) continue;
    const unknownIds = c.evidenceIds.filter((id) => !known.has(id));
    if (unknownIds.length === 0) continue;
    seen.add(c.id);
    issues.push(
      issue(
        ISSUE_CODES.UNSUPPORTED_CLAIM,
        "evidence_reference",
        `The statement "${c.text.slice(0, 120)}" (${c.id}) cites evidence that is not in this session's evidence set (${unknownIds.join(", ")}). Reprocess the session or remove the statement before approving.`,
        true,
      ),
    );
  }

  const checks: Record<RequiredField, () => DocumentationIssue | null> = {
    service_date: () =>
      Number.isNaN(Date.parse(appointment.startAt))
        ? issue(ISSUE_CODES.MISSING_SERVICE_DATE, "service_date", "The service date is missing or unreadable. Check the appointment's start time in the calendar.", true)
        : null,
    provider_identity: () =>
      isMeaningfulText(appointment.providerId)
        ? null
        : issue(ISSUE_CODES.MISSING_PROVIDER_IDENTITY, "provider_identity", "The provider for this session is not identified. Check the appointment's assigned provider.", true),
    client_reference: () =>
      isMeaningfulText(appointment.clientRef)
        ? null
        : issue(ISSUE_CODES.MISSING_CLIENT_REFERENCE, "client_reference", "The client reference is missing. Check the appointment's client reference.", true),
    service_description: () =>
      facts.activities.some(isBackedSupported) || hasActivitySummary
        ? null
        : issue(
            ISSUE_CODES.MISSING_SERVICE_DESCRIPTION,
            "service_description",
            "No service activity is supported by the session evidence. Write an activity summary in your own words, or confirm the evidence is complete and reprocess the session.",
            true,
          ),
    goal_addressed: () =>
      facts.goals.some((g) => g.status === "addressed" && g.claims.some(isBackedSupported)) || goalAttestationIds.size > 0
        ? null
        : issue(
            ISSUE_CODES.NO_GOAL_ADDRESSED,
            "goal_addressed",
            "No plan goal is shown as addressed. At least one goal must be addressed with a supported statement, or confirmed by you as addressed in this visit.",
            true,
          ),
    progress_statement: () => {
      const ok = facts.progress.some(
        (c) =>
          isBackedSupported(c) ||
          (c.support === "provider_confirmed" &&
            isMeaningfulText(c.text) &&
            c.providerAttestationId !== undefined &&
            attestationIds.has(c.providerAttestationId)),
      );
      if (ok || progressAttestations.length > 0) return null;
      const remedy = rules.allowProviderProgressAttestation
        ? "Add a progress confirmation describing the participant's progress in your own words."
        : "This service's rules require progress to be supported by session evidence; provider confirmation is not accepted.";
      return issue(ISSUE_CODES.MISSING_PROGRESS, "progress_statement", `No progress statement is established. ${remedy}`, true);
    },
    confirmed_duration: () =>
      typeof confirmedMinutes === "number" &&
      Number.isInteger(confirmedMinutes) &&
      confirmedMinutes > 0 &&
      confirmedMinutes <= MAX_CONFIRMED_MINUTES
        ? null
        : issue(
            ISSUE_CODES.MISSING_CONFIRMED_DURATION,
            "confirmed_duration",
            "The actual session duration has not been confirmed. Enter the confirmed duration in whole minutes; scheduled time is only an estimate.",
            true,
          ),
  };

  for (const field of new Set(rules.required)) {
    const found = checks[field]();
    if (found) issues.push(found);
  }

  // Nonblocking: goals with unknown coverage (including plan goals absent from facts).
  for (const goal of plan.goals) {
    const fact = facts.goals.find((g) => g.goalId === goal.goalId);
    if (!fact || fact.status === "unknown") {
      issues.push(
        issue(
          ISSUE_CODES.UNKNOWN_GOAL_COVERAGE,
          `goal:${goal.goalId}`,
          `The evidence does not show whether the goal "${goal.objective}" was worked on in this session. Review before approving.`,
          false,
        ),
      );
    }
  }

  if (evidenceCompleteness !== "complete") {
    issues.push(
      issue(
        ISSUE_CODES.PARTIAL_EVIDENCE,
        "evidence",
        evidenceCompleteness === "partial"
          ? "Some session evidence could not be retrieved. Statements may be incomplete; review the excerpts before approving."
          : "It is not known whether all session evidence was retrieved. Review the excerpts before approving.",
        false,
      ),
    );
  }

  return {
    ruleVersion: rules.ruleVersion,
    issues,
    canApprove: !issues.some((i) => i.blocking),
  };
};
