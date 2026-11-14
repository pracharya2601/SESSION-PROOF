/**
 * Pure bundle assembly (Agent 11). Used by the workflow (initial draft) and
 * the review service (after edits); both rebuild documents/checks/billing
 * identically from extracted facts + attestations.
 */
import { SessionBundle } from "../contracts";
import type { AssembleBundleFn, FactClaim, ProviderAttestation, SessionFacts } from "../contracts";
import { generateDocuments, latestDurationAttestation } from "./documents";
import { validateRequirements } from "./rules";
import { calculateBilling } from "./billing";

/** Strict positive integer parse ("90" ok; "90.5", "1e2", " 9 0", "0", "-5" -> null). */
export function parseConfirmedMinutes(text: string): number | null {
  const t = text.trim();
  if (!/^[1-9]\d*$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export function confirmedMinutesFrom(attestations: ProviderAttestation[]): number | null {
  const latest = latestDurationAttestation(attestations);
  return latest ? parseConfirmedMinutes(latest.text) : null;
}

export function attestationClaimId(attestationId: string): string {
  return `claim_${attestationId}`.slice(0, 128);
}

export const PROVIDER_GOAL_CLAIM_TEXT = "The provider confirmed this goal was addressed in the visit.";

/**
 * Display view: extracted facts (deep-copied) + progress attestations as provider_confirmed
 * claims + goal_addressed attestations as a provider_confirmed claim on that goal (status
 * "addressed"). Goal attestations naming a goal outside `planGoalIds` (when given) are ignored.
 */
export function mergeAttestations(
  extracted: SessionFacts,
  attestations: ProviderAttestation[],
  planGoalIds?: ReadonlySet<string>,
): SessionFacts {
  const copy: SessionFacts = structuredClone(extracted);
  const attested: FactClaim[] = attestations
    .filter((a) => a.field === "progress")
    .map((a) => ({
      id: attestationClaimId(a.id),
      text: a.text,
      evidenceIds: [],
      support: "provider_confirmed" as const,
      providerAttestationId: a.id,
    }));
  copy.progress = [...copy.progress, ...attested];
  for (const a of attestations) {
    if (a.field !== "goal_addressed") continue;
    const goalId = a.text.trim();
    if (!goalId || (planGoalIds && !planGoalIds.has(goalId))) continue;
    const claim: FactClaim = {
      id: attestationClaimId(a.id),
      text: PROVIDER_GOAL_CLAIM_TEXT,
      evidenceIds: [],
      support: "provider_confirmed",
      providerAttestationId: a.id,
    };
    const goal = copy.goals.find((g) => g.goalId === goalId);
    if (goal) {
      if (goal.claims.some((c) => c.id === claim.id)) continue;
      goal.status = "addressed";
      goal.claims = [...goal.claims, claim].slice(0, 50);
    } else if (copy.goals.length < 20) {
      copy.goals.push({ goalId, status: "addressed", claims: [claim] });
    }
  }
  return copy;
}

export const assembleBundle: AssembleBundleFn = (input) => {
  const { appointment, config, attestations } = input;
  const extractedFacts: SessionFacts = structuredClone(input.facts);
  const facts = mergeAttestations(extractedFacts, attestations, new Set(config.plan.goals.map((g) => g.goalId)));
  const confirmedMinutes = confirmedMinutesFrom(attestations);
  const scheduledMs = new Date(appointment.endAt).getTime() - new Date(appointment.startAt).getTime();
  const scheduledMinutes = Number.isFinite(scheduledMs) ? Math.max(0, Math.round(scheduledMs / 60_000)) : 0;

  const documents = generateDocuments({
    appointment,
    plan: config.plan,
    facts,
    attestations,
    evidence: input.evidence,
    evidenceWindow: input.evidenceWindow,
    evidenceCompleteness: input.provenance.evidenceCompleteness,
    evidenceWarnings: input.provenance.evidenceWarnings,
    confirmedMinutes,
  });

  const checks = validateRequirements({
    appointment,
    plan: config.plan,
    rules: config.rules,
    facts,
    documents,
    attestations,
    evidenceIds: input.evidence.map((e) => e.id),
    confirmedMinutes,
    evidenceCompleteness: input.provenance.evidenceCompleteness,
  });

  const billing = calculateBilling(config.rate, scheduledMinutes, confirmedMinutes);

  return SessionBundle.parse({
    sessionId: input.sessionId,
    bundleRevision: input.bundleRevision,
    processingRevision: input.processingRevision,
    appointment,
    config,
    evidence: input.evidence,
    evidenceWindow: input.evidenceWindow,
    extractedFacts,
    facts,
    attestations,
    documents,
    checks,
    billing,
    provenance: input.provenance,
    createdAt: input.createdAt,
  });
};
