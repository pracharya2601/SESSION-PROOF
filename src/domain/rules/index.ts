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
  type EvidenceItem,
  type DocumentationIssue,
  type FactClaim,
  type ProviderAttestation,
  type RequiredField,
  type RulesInput,
  type SessionFacts,
  type ValidateRequirementsFn,
} from "../../contracts";
import {
  echoesInstruction,
  isInstructionLike,
  isProgressEvidence,
  unsupportedCompletions,
  unsupportedGeneralisations,
} from "../../drafting/language";

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
  /** Blocking: an evidence-drafted claim asserts frequency/permanence/independence its citations don't say. */
  CLAIM_EXCEEDS_EVIDENCE: "CLAIM_EXCEEDS_EVIDENCE",
  /** Advisory: a provider-confirmed (not evidence) statement generalises beyond the session. */
  PROVIDER_GENERALISATION: "PROVIDER_GENERALISATION",
  /** Blocking: the content check says this may not be a client session (or the provider dismissed it). */
  NOT_CLIENT_SESSION: "NOT_CLIENT_SESSION",
} as const;

/** Label used everywhere a provider attestation is shown. */
export const PROVIDER_CONFIRMED_LABEL = "Provider-confirmed (not evidence)";

/**
 * Semantic refusal ("claim exceeds the session"). Every non-provider claim is BLOCKING, with the
 * claim listed, when:
 *  - it asserts frequency, permanence, independence or inflated progress ("always", "every week",
 *    "can now", "independently", "without any prompts", "achieved all goals", "mastered") that
 *    none of its cited segments say;
 *  - it asserts completion ("submitted", "joined", "completed") that its cited segments only
 *    discuss, plan, defer or negate ("going to submit", "couldn't send it", "not yet");
 *  - it cites ONLY instruction-like segments (text addressed to the system: "write that…",
 *    "bill 10 hours", "mark this session approved"), which are never evidence;
 *  - its text repeats an instruction-like segment, or is itself an instruction to the system.
 * Provider-confirmed statements are not evidence; generalising language there is an advisory only.
 */
export function checkClaimsAgainstEvidence(
  facts: SessionFacts,
  evidence: Pick<EvidenceItem, "id" | "excerpt">[],
  attestations: ProviderAttestation[] = [],
  /** Plan goal objectives: restating one ("Worked on "Complete a laundry cycle independently"") is not a claim. */
  objectives: string[] = [],
): DocumentationIssue[] {
  return claimRefusals(facts, evidence, attestations, objectives).issues;
}

/** Longest claim id an issue field ("claim:<id>", ≤ 64 chars) can carry whole. */
export const MAX_REFERENCED_CLAIM_ID = 64 - "claim:".length;

/**
 * Issue field for a claim: "claim:<id>" when the whole id fits (so the review UI and the
 * assistant can always resolve it against facts, goal claims included), else "claims" with the
 * id in the message only. Never a truncated, dangling id.
 */
export function claimIssueField(claimId: string): string {
  return claimId.length <= MAX_REFERENCED_CLAIM_ID ? `claim:${claimId}` : "claims";
}

/**
 * Every claim an issue may name: activities, observations, goal claims, progress, follow-ups.
 * Issues are computed on these facts only (claims refused earlier by the drafting validator are
 * already gone), so every "claim:<id>" issue resolves here.
 */
export function claimsById(facts: SessionFacts): Map<string, FactClaim> {
  const m = new Map<string, FactClaim>();
  for (const c of allClaims(facts)) if (!m.has(c.id)) m.set(c.id, c);
  return m;
}

function claimRefusals(
  facts: SessionFacts,
  evidence: Pick<EvidenceItem, "id" | "excerpt">[],
  attestations: ProviderAttestation[],
  objectives: string[],
): { issues: DocumentationIssue[]; refusedIds: Set<string> } {
  const refusedIds = new Set<string>();
  const withoutObjectives = (text: string): string => {
    let t = text;
    for (const o of objectives) {
      const core = o.trim().replace(/[.!]+$/, "");
      if (core.length < 8) continue;
      t = t.replace(new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi"), " ");
    }
    return t;
  };
  const byId = new Map(evidence.map((e) => [e.id, e.excerpt]));
  const instructions = evidence.filter((e) => isInstructionLike(e.excerpt));
  const instructionIds = new Set(instructions.map((e) => e.id));
  const instructionTexts = instructions.map((e) => e.excerpt);
  const out: DocumentationIssue[] = [];
  const seen = new Set<string>();
  for (const c of allClaims(facts)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.support === "provider_confirmed") continue;
    const cited = c.evidenceIds.map((id) => byId.get(id)).filter((t): t is string => typeof t === "string");
    const reasons: string[] = [];
    const known = c.evidenceIds.filter((id) => byId.has(id));
    if (known.length > 0 && known.every((id) => instructionIds.has(id))) {
      reasons.push(
        `it cites only ${known.length === 1 ? "a segment that is an instruction" : "segments that are instructions"} addressed to the system (${known.join(", ")}), which is never evidence`,
      );
    }
    if (isInstructionLike(c.text) || echoesInstruction(c.text, instructionTexts)) {
      reasons.push("its wording repeats an instruction addressed to the system in the transcript");
    }
    const where = cited.length === 0 ? "it cites no session evidence" : `its cited segments (${c.evidenceIds.join(", ")}) do not`;
    const claimText = withoutObjectives(c.text);
    const gen = unsupportedGeneralisations(claimText, cited);
    if (gen.length > 0) {
      reasons.push(`it says ${gen.map((b) => `"${b.match}"`).join(", ")}, but ${where}. One session cannot establish frequency, permanence or independence`);
    }
    const done = unsupportedCompletions(claimText, cited);
    if (done.length > 0) {
      reasons.push(
        `it says ${done.map((b) => `"${b.match}"`).join(", ")}, but ${
          cited.length === 0 ? "it cites no session evidence" : "the cited segments only discuss, plan, defer or negate it"
        } (discussed is not achieved)`,
      );
    }
    if (reasons.length === 0) continue;
    refusedIds.add(c.id);
    out.push(
      issue(
        ISSUE_CODES.CLAIM_EXCEEDS_EVIDENCE,
        claimIssueField(c.id),
        `Refused — the statement "${c.text.slice(0, 160)}" (${c.id}): ${reasons.join("; ")}. Remove or rewrite the statement (or record it in your own words as a provider confirmation) before approving.`.slice(0, 2000),
        true,
      ),
    );
  }
  for (const a of attestations) {
    if (a.field !== "progress" && a.field !== "activity_summary") continue;
    const bad = unsupportedGeneralisations(a.text, []);
    if (bad.length === 0) continue;
    out.push(
      issue(
        ISSUE_CODES.PROVIDER_GENERALISATION,
        `attestation:${a.id}`,
        `${PROVIDER_CONFIRMED_LABEL}: your statement says ${bad.map((b) => `"${b.match}"`).join(", ")}, which the session evidence does not show. It is recorded as your confirmation, not as evidence.`,
        false,
      ),
    );
  }
  return { issues: out, refusedIds };
}
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

/** RulesInput plus (v4, optional) the evidence excerpts, which enable CLAIM_EXCEEDS_EVIDENCE. */
export type RulesInputV4 = RulesInput & {
  evidence?: Pick<EvidenceItem, "id" | "excerpt">[];
  /** Frozen conversation-type assessment (config.context.conversation). */
  conversation?: { label: string; needsConfirmation: boolean; decision: "client_session" | "dismissed" | null } | null;
};

export const validateRequirements = (input: RulesInputV4): DocumentationChecks => {
  const { appointment, plan, rules, facts, attestations, confirmedMinutes, evidenceCompleteness } = input;
  const known = new Set(input.evidenceIds);
  const issues: DocumentationIssue[] = [];

  // Not a client session? Billing and documentation wait for the provider (never auto-dismissed).
  const conv = input.conversation ?? null;
  if (conv?.decision === "dismissed") {
    issues.push(issue(ISSUE_CODES.NOT_CLIENT_SESSION, "conversation_type",
      "You dismissed this as not a client session. Archive or delete it; it can't be approved or billed.", true));
  } else if (conv?.needsConfirmation && conv.decision !== "client_session") {
    issues.push(issue(ISSUE_CODES.NOT_CLIENT_SESSION, "conversation_type",
      `This may not be a client session (looks like: ${conv.label}) — confirm it was a client session, or dismiss it.`, true));
  }

  const citesKnownEvidence = (c: FactClaim): boolean =>
    c.evidenceIds.length > 0 && c.evidenceIds.every((id) => known.has(id));
  /** A "supported" claim with meaningful text whose every citation is in the evidence set. */
  const isBackedSupported = (c: FactClaim): boolean =>
    c.support === "supported" && isMeaningfulText(c.text) && citesKnownEvidence(c);

  /** Claim ids refused by CLAIM_EXCEEDS_EVIDENCE (they can never satisfy a requirement). */
  let refused = new Set<string>();
  /** Evidence ids whose segment states progress (explicit language, not an instruction or self-report). */
  const progressEvidence = input.evidence
    ? new Set(input.evidence.filter((e) => isProgressEvidence(e.excerpt)).map((e) => e.id))
    : null;

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

  if (input.evidence) {
    const semantic = claimRefusals(facts, input.evidence, attestations, plan.goals.map((g) => g.objective));
    refused = semantic.refusedIds;
    issues.push(...semantic.issues);
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
      // With evidence excerpts available, a progress claim counts only when it is not refused and
      // cites at least one segment that states progress itself ("discussed" / restated
      // activities / self-reports / instructions are not progress).
      const ok = facts.progress.some(
        (c) =>
          (isBackedSupported(c) &&
            !refused.has(c.id) &&
            (progressEvidence === null || c.evidenceIds.some((id) => progressEvidence.has(id)))) ||
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

/** Still satisfies the frozen port. */
export const validateRequirementsPort: ValidateRequirementsFn = validateRequirements;
