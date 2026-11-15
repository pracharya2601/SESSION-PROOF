/**
 * Pure bundle assembly (Agent 11). Used by the workflow (initial draft) and
 * the review service (after edits); both rebuild documents/checks/billing
 * identically from extracted facts + attestations.
 */
import { SessionBundle, parseClaimRejection } from "../contracts";
import type { AssembleBundleFn, FactClaim, ProviderAttestation, SessionFacts } from "../contracts";
import { generateDocuments, latestDurationAttestation } from "./documents";
import { validateRequirements } from "./rules";
import { buildChecklist } from "./rules/checklist";
import { calculateBilling, roundHalfUpCents } from "./billing";
import { applyMinuteRounding, buildInvoice } from "./billing/invoice";

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

/** Claims the provider removed (latest claim_rejected attestations), by claim id. */
export function rejectedClaimsFrom(attestations: ProviderAttestation[]): Map<string, { reason: string; attestationId: string }> {
  const out = new Map<string, { reason: string; attestationId: string }>();
  for (const a of attestations) {
    const r = parseClaimRejection(a);
    if (r) out.set(r.claimId, { reason: r.reason, attestationId: a.id });
  }
  return out;
}

/**
 * Removes provider-rejected claims from facts: they leave the note, the invoice task lines and goal
 * coverage (a goal left with no claims becomes "unknown"). extractedFacts keeps them for audit.
 */
export function removeRejectedClaims(facts: SessionFacts, attestations: ProviderAttestation[]): SessionFacts {
  const rejected = rejectedClaimsFrom(attestations);
  if (rejected.size === 0) return facts;
  const keep = (l: FactClaim[]) => l.filter((c) => !rejected.has(c.id));
  return {
    ...facts,
    activities: keep(facts.activities),
    observations: keep(facts.observations),
    progress: keep(facts.progress),
    followUps: keep(facts.followUps),
    goals: facts.goals.map((g) => {
      const claims = keep(g.claims);
      return claims.length === g.claims.length ? g : { ...g, claims, status: claims.length === 0 ? "unknown" : g.status };
    }),
  };
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
  const copy: SessionFacts = removeRejectedClaims(structuredClone(extracted), attestations);
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
    evidence: input.evidence,
    confirmedMinutes,
    evidenceCompleteness: input.provenance.evidenceCompleteness,
    conversation: config.context?.conversation ?? null,
  });

  let billing = calculateBilling(config.rate, scheduledMinutes, confirmedMinutes);
  const rule = config.rate.minuteRounding ?? "exact";
  if (rule !== "exact" && confirmedMinutes !== null) {
    // Configured minute rounding: the confirmed minutes stay as confirmed; the amount uses billed minutes.
    const billedMinutes = applyMinuteRounding(confirmedMinutes, rule);
    const amountCents = roundHalfUpCents(config.rate.hourlyRateCents, billedMinutes);
    const usd = `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`;
    billing = {
      ...billing,
      amountCents,
      breakdown: `${billing.breakdown} - billed ${billedMinutes} min under rounding rule ${rule}: USD ${usd}`.slice(0, 500),
    };
  }
  const invoice = buildInvoice({
    appointment,
    config,
    facts,
    attestations,
    evidence: input.evidence,
    confirmedMinutes,
    scheduledMinutes,
  });
  billing = { ...billing, invoice };
  const rejectedById = rejectedClaimsFrom(attestations);
  const extractedById = new Map(
    [...extractedFacts.activities, ...extractedFacts.observations, ...extractedFacts.progress, ...extractedFacts.followUps, ...extractedFacts.goals.flatMap((g) => g.claims)].map((c) => [c.id, c]),
  );
  const rejectedClaims = [...rejectedById.entries()]
    .filter(([id]) => extractedById.has(id))
    .map(([claimId, r]) => ({ claimId, text: extractedById.get(claimId)!.text.slice(0, 2000), reason: r.reason.slice(0, 500), attestationId: r.attestationId }));
  const checklist = buildChecklist({
    rejectedClaims,
    appointment,
    config,
    facts,
    attestations,
    issues: checks.issues,
    invoice,
    evidenceWindow: input.evidenceWindow,
    confirmedMinutes,
  });

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
    checks: { ...checks, checklist },
    billing,
    provenance: input.provenance,
    createdAt: input.createdAt,
  });
};
