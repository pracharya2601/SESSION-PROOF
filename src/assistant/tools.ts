/**
 * Assistant tools. Pure functions over the scrubbed corpus + the bundle (for ids,
 * limits and current state). propose_edit validates and RETURNS a proposal; it
 * never writes anything.
 */
import { MAX_CONFIRMED_MINUTES, type SessionBundle } from "../contracts";
import { existingRejections, type SessionCorpus } from "./corpus";
import { PROPOSABLE_FIELDS, type AssistantProposal, type ProposedEdits, type RejectedClaim } from "./types";

export const TOOL_NAMES = ["get_summary", "search_transcript", "get_claim", "propose_edit"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const MAX_TEXT = { progressConfirmation: 2000, activitySummary: 2000, participantChoices: 1000, reason: 500 } as const;

export const BILLING_REFUSAL =
  "I can't change rates, amounts or service codes. The hourly rate comes from the authorization on file, and the server recalculates the amount from the confirmed minutes.";

/** Keys a model might try that touch billing. Refused, never mapped. */
const BILLING_KEY_RE = /rate|amount|cents|price|bill|invoice|total|charge|fee|unit|service_?code|servicecode|currency|round/i;

/** Plain-language billing/rate change requests in the provider's message. */
export function isBillingChangeRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (/\$\s?\d+(\.\d+)?\s*(\/|per|an?)\s*(h|hr|hour)/.test(t)) return true;
  return /\b(change|raise|increase|lower|reduce|set|bump|adjust|update|make|edit|fix)\b[^.?!]{0,40}\b(hourly rate|rate|price|amount|total|invoice total|billing|charge|fee|service code|units?)\b/.test(
    t,
  );
}

export function knownGoalIds(bundle: SessionBundle): string[] {
  return bundle.config.plan.goals.map((g) => g.goalId);
}

export function confirmedGoalIds(bundle: SessionBundle): string[] {
  const ids = new Set(bundle.attestations.filter((a) => a.field === "goal_addressed").map((a) => a.text.trim()));
  return knownGoalIds(bundle).filter((id) => ids.has(id));
}

// ------------------------------------------------------------------ read tools

export function getSummary(bundle: SessionBundle, corpus: SessionCorpus) {
  const t = bundle.documents.timeSummary;
  const confirmed = new Set(confirmedGoalIds(bundle));
  const coverage = new Map(bundle.documents.planCoverage.map((p) => [p.goalId, p]));
  return {
    client: corpus.clientRef,
    serviceCode: corpus.serviceCode,
    serviceDescription: corpus.serviceDescription,
    revision: bundle.bundleRevision,
    minutes: {
      scheduled: t.scheduledMinutes,
      recorded: t.evidenceWindowMinutes,
      confirmedByProvider: t.confirmedMinutes,
      maxAllowed: Math.min(MAX_CONFIRMED_MINUTES, bundle.config.rate.maxMinutes),
    },
    goals: corpus.goals.map((g) => ({
      goalId: g.goalId,
      objective: g.objective,
      status: coverage.get(g.goalId)?.status ?? "unknown",
      providerConfirmed: confirmed.has(g.goalId),
    })),
    blockers: bundle.checks.issues.filter((i) => i.blocking).map((i) => ({ code: i.code, field: i.field, message: i.message })),
    warnings: bundle.checks.issues.filter((i) => !i.blocking).map((i) => ({ field: i.field, message: i.message })).slice(0, 12),
    claims: corpus.claims.slice(0, 40).map((c) => ({
      id: c.id,
      kind: c.kind,
      goalId: c.goalId,
      text: c.text,
      support: c.support,
      evidenceIds: c.evidenceIds,
      ...(c.removed !== null ? { removedByProvider: c.removed } : {}),
    })),
    providerStatements: corpus.attestations,
    missingInformation: corpus.missing.slice(0, 12),
    transcriptSegments: corpus.segments.length,
    billing: {
      note: "Read-only. Rate comes from the authorization; amount is recalculated from confirmed minutes.",
      isEstimate: bundle.billing.isEstimate,
    },
  };
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "was", "were", "did", "she", "her", "his", "him", "they", "them", "you", "what", "when", "how", "who", "about", "from", "have", "has", "had", "are", "is", "it", "of", "to", "in", "on", "a", "an"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_\[\]-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export function searchTranscript(corpus: SessionCorpus, query: string, limit = 8) {
  const q = (query ?? "").trim().slice(0, 200);
  const byId = corpus.segments.filter((s) => q.split(/[\s,]+/).includes(s.id));
  if (byId.length > 0) return { query: q, matches: byId.slice(0, limit).map(segOut), totalSegments: corpus.segments.length };
  const terms = words(q);
  const scored = corpus.segments
    .map((s, i) => {
      const text = s.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += 2;
        else if (t.length > 4 && text.includes(t.slice(0, t.length - 2))) score += 1; // crude stem
      }
      return { s, i, score };
    })
    .filter((x) => terms.length === 0 || x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i);
  return {
    query: q,
    matches: scored.map((x) => segOut(x.s)),
    totalSegments: corpus.segments.length,
    ...(scored.length === 0 ? { note: "No segment matched. Try other words, or say the transcript does not mention it." } : {}),
  };
}

function segOut(s: SessionCorpus["segments"][number]) {
  return { id: s.id, speaker: s.speaker, at: s.at, text: s.text.slice(0, 600) };
}

export function getClaim(corpus: SessionCorpus, claimId: string) {
  const c = corpus.claims.find((x) => x.id === claimId);
  if (!c) return { error: `No claim with id ${String(claimId).slice(0, 64)}. Claim ids are listed in get_summary.` };
  const segs = corpus.segments.filter((s) => c.evidenceIds.includes(s.id)).map(segOut);
  return { claim: c, citedSegments: segs, missingCitations: c.evidenceIds.filter((id) => !segs.some((s) => s.id === id)) };
}

// ------------------------------------------------------------------ propose_edit

export type ProposalCheck =
  | { ok: true; proposal: AssistantProposal }
  | { ok: false; errors: string[]; refusal?: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanText(raw: unknown, restore: (s: string) => string, max: number, label: string, errors: string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    errors.push(`${label} must be text.`);
    return undefined;
  }
  const t = restore(raw).trim();
  if (!t) return undefined;
  if (t.length > max) {
    errors.push(`${label} must be at most ${max} characters.`);
    return undefined;
  }
  return t;
}

/**
 * Validates a model-proposed edit against the allowlist and this session's state.
 * Text is restored (privacy tokens → originals) so the provider sees real wording.
 */
export function validateProposal(
  input: { edit?: unknown; rationale?: unknown; citations?: unknown },
  bundle: SessionBundle,
  corpus: SessionCorpus,
  id: string,
): ProposalCheck {
  const errors: string[] = [];
  const edit = isObj(input.edit) ? input.edit : null;
  if (!edit) return { ok: false, errors: ["edit must be an object with at least one allowed field."] };

  const allowed = new Set<string>(PROPOSABLE_FIELDS);
  const billingKeys = Object.keys(edit).filter((k) => !allowed.has(k) && BILLING_KEY_RE.test(k));
  if (billingKeys.length > 0) return { ok: false, errors: [BILLING_REFUSAL], refusal: BILLING_REFUSAL };
  const unknown = Object.keys(edit).filter((k) => !allowed.has(k));
  if (unknown.length > 0) errors.push(`Unknown field(s): ${unknown.slice(0, 5).join(", ")}. Allowed: ${PROPOSABLE_FIELDS.join(", ")}.`);

  const out: ProposedEdits = {};
  const restore = corpus.restore;

  if (edit.confirmedMinutes !== undefined && edit.confirmedMinutes !== null) {
    const n = typeof edit.confirmedMinutes === "string" ? Number(edit.confirmedMinutes) : edit.confirmedMinutes;
    const max = Math.min(MAX_CONFIRMED_MINUTES, bundle.config.rate.maxMinutes);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) errors.push(`confirmedMinutes must be a whole number from 1 to ${max}.`);
    else out.confirmedMinutes = n;
  }
  const progress = cleanText(edit.progressConfirmation, restore, MAX_TEXT.progressConfirmation, "progressConfirmation", errors);
  if (progress) out.progressConfirmation = progress;
  const summary = cleanText(edit.activitySummary, restore, MAX_TEXT.activitySummary, "activitySummary", errors);
  if (summary) out.activitySummary = summary;
  const choices = cleanText(edit.participantChoices, restore, MAX_TEXT.participantChoices, "participantChoices", errors);
  if (choices) out.participantChoices = choices;
  if (edit.participantDirected !== undefined && edit.participantDirected !== null) {
    if (typeof edit.participantDirected !== "boolean") errors.push("participantDirected must be true or false.");
    else out.participantDirected = edit.participantDirected;
  }
  if (edit.goalsAddressed !== undefined && edit.goalsAddressed !== null) {
    const goals = knownGoalIds(bundle);
    if (!Array.isArray(edit.goalsAddressed) || edit.goalsAddressed.some((g) => typeof g !== "string")) {
      errors.push("goalsAddressed must be a list of goal ids.");
    } else {
      const ids = [...new Set((edit.goalsAddressed as string[]).map((g) => g.trim()))];
      const bad = ids.filter((g) => !goals.includes(g));
      if (bad.length > 0) errors.push(`Unknown goal id(s): ${bad.slice(0, 5).join(", ")}. Valid goal ids: ${goals.join(", ")}.`);
      else out.goalsAddressed = goals.filter((g) => ids.includes(g)); // plan order
    }
  }
  if (edit.rejectedClaims !== undefined && edit.rejectedClaims !== null) {
    const claimIds = new Set(corpus.claims.map((c) => c.id));
    if (!Array.isArray(edit.rejectedClaims)) errors.push("rejectedClaims must be a list of {claimId, reason}.");
    else {
      const seen = new Set<string>();
      const list: RejectedClaim[] = [];
      for (const r of edit.rejectedClaims.slice(0, 20)) {
        if (!isObj(r) || typeof r.claimId !== "string") {
          errors.push("Each rejected claim needs a claimId and a reason.");
          continue;
        }
        const cid = r.claimId.trim();
        if (!claimIds.has(cid)) {
          errors.push(`Unknown claim id ${cid.slice(0, 64)}. Use ids from get_summary.`);
          continue;
        }
        const reason = cleanText(r.reason, restore, MAX_TEXT.reason, "reason", errors);
        if (!reason || reason.length < 3) {
          errors.push(`Claim ${cid} needs a short reason.`);
          continue;
        }
        if (!seen.has(cid)) {
          seen.add(cid);
          list.push({ claimId: cid, reason });
        }
      }
      // The server replaces the whole list, so keep removals the provider already made.
      if (list.length > 0) {
        const merged = existingRejections(bundle).filter((r) => !seen.has(r.claimId));
        out.rejectedClaims = [...merged, ...list].slice(0, 50);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(out).length === 0) return { ok: false, errors: ["The edit has no allowed field with a value."] };

  const evidenceIds = new Set(bundle.evidence.map((e) => e.id));
  const citations = Array.isArray(input.citations)
    ? [...new Set(input.citations.filter((c): c is string => typeof c === "string" && evidenceIds.has(c)))].slice(0, 12)
    : [];
  const rationale = typeof input.rationale === "string" ? restore(input.rationale).trim().slice(0, 500) : "";
  return { ok: true, proposal: { id, edits: out, summary: describeEdits(out, bundle), rationale, citations } };
}

export function describeEdits(e: ProposedEdits, bundle: SessionBundle): string[] {
  const goalName = new Map(bundle.config.plan.goals.map((g) => [g.goalId, g.objective]));
  const lines: string[] = [];
  if (e.confirmedMinutes !== undefined) lines.push(`Confirmed minutes → ${e.confirmedMinutes} (provider-confirmed)`);
  if (e.goalsAddressed !== undefined)
    lines.push(
      e.goalsAddressed.length === 0
        ? "Goals addressed → none"
        : `Goals addressed → ${e.goalsAddressed.map((g) => goalName.get(g) ?? g).join("; ")} (provider-confirmed)`,
    );
  if (e.activitySummary !== undefined) lines.push(`Activity summary → "${e.activitySummary}"`);
  if (e.progressConfirmation !== undefined) lines.push(`Progress → "${e.progressConfirmation}" (provider-confirmed)`);
  if (e.participantDirected !== undefined) lines.push(`Participant directed → ${e.participantDirected ? "yes" : "no"}`);
  if (e.participantChoices !== undefined) lines.push(`Participant choices → "${e.participantChoices}"`);
  const already = new Map(existingRejections(bundle).map((r) => [r.claimId, r.reason]));
  for (const r of e.rejectedClaims ?? []) if (already.get(r.claimId) !== r.reason) lines.push(`Remove claim ${r.claimId}: ${r.reason}`);
  return lines;
}

/** Known evidence ids mentioned in text, in order of first mention. */
export function citedIds(text: string, evidenceIds: string[]): string[] {
  const hits: { id: string; at: number }[] = [];
  for (const id of evidenceIds) {
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
    const m = re.exec(text);
    if (m) hits.push({ id, at: m.index });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id);
}
