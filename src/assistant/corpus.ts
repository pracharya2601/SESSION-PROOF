/**
 * Scrubbed view of one session for the assistant. EVERY text the model can see
 * (transcript, claims, note lines, goals, attestations, the chat itself) is
 * tokenized in ONE privacy pass so tokens are consistent across tool results,
 * and `restore` maps tokens back in the model's output.
 */
import { parseClaimRejection, type EvidenceItem, type FactClaim, type PrivacyContext, type SessionBundle } from "../contracts";
import { createPrivacyController } from "../privacy";
import type { AssistantMessage } from "./types";

export interface CorpusSegment {
  id: string;
  speaker: string | null;
  at: string | null;
  text: string;
}

export interface CorpusClaim {
  id: string;
  kind: "activity" | "observation" | "progress" | "follow_up" | "goal";
  goalId: string | null;
  text: string;
  support: FactClaim["support"];
  evidenceIds: string[];
  /** Reason when the provider already removed this claim (it no longer appears in the documents). */
  removed: string | null;
}

export interface SessionCorpus {
  clientRef: string;
  serviceCode: string;
  serviceDescription: string;
  segments: CorpusSegment[];
  claims: CorpusClaim[];
  noteLines: { section: string; text: string }[];
  goals: { goalId: string; objective: string }[];
  attestations: { field: string; text: string }[];
  missing: string[];
  messages: AssistantMessage[];
  restore: (s: string) => string;
  /** Counts only (never values): what the scrubber replaced. */
  findings: Record<string, number>;
}

/** Extracted claims (the ones a provider can remove), with any existing removal. */
export function existingRejections(bundle: SessionBundle): { claimId: string; reason: string }[] {
  const out = new Map<string, string>();
  for (const a of bundle.attestations) {
    const r = parseClaimRejection(a);
    if (r) out.set(r.claimId, r.reason);
  }
  return [...out].map(([claimId, reason]) => ({ claimId, reason }));
}

function allClaims(bundle: SessionBundle): (Omit<CorpusClaim, "text"> & { raw: string })[] {
  const f = bundle.extractedFacts;
  const removed = new Map(existingRejections(bundle).map((r) => [r.claimId, r.reason]));
  const out: (Omit<CorpusClaim, "text"> & { raw: string })[] = [];
  const add = (kind: CorpusClaim["kind"], c: FactClaim, goalId: string | null = null) =>
    out.push({ id: c.id, kind, goalId, raw: c.text, support: c.support, evidenceIds: [...c.evidenceIds], removed: removed.get(c.id) ?? null });
  f.activities.forEach((c) => add("activity", c));
  f.observations.forEach((c) => add("observation", c));
  f.progress.forEach((c) => add("progress", c));
  f.followUps.forEach((c) => add("follow_up", c));
  f.goals.forEach((g) => g.claims.forEach((c) => add("goal", c, g.goalId)));
  return out;
}

const pseudo = (excerpt: string, i: number): EvidenceItem => ({
  id: `x_${i}`,
  sourceId: null,
  sourceMode: "live",
  observedFrom: null,
  observedTo: null,
  speaker: null,
  excerpt: excerpt.slice(0, 4000),
  retrievedAt: "1970-01-01T00:00:00.000Z",
});

export function buildCorpus(bundle: SessionBundle, messages: AssistantMessage[], ctx: PrivacyContext): SessionCorpus {
  const claims = allClaims(bundle);
  const noteLines = bundle.documents.sections
    .filter((s) => s.key !== "time_summary")
    .flatMap((s) => s.lines.filter((l) => l.origin !== "configuration").map((l) => ({ section: s.title, raw: l.text })))
    .slice(0, 80);
  const goals = bundle.config.plan.goals;
  const atts = bundle.attestations.filter((a) => a.field !== "goal_addressed" && a.field !== "claim_rejected");

  // One flat list of texts after the real evidence; indexes map back below.
  const texts: string[] = [
    bundle.appointment.clientRef,
    bundle.config.plan.serviceDescription,
    ...claims.map((c) => c.raw),
    ...noteLines.map((l) => l.raw),
    ...goals.map((g) => g.objective),
    ...atts.map((a) => a.text),
    ...bundle.facts.missingInformation,
    ...messages.map((m) => m.content),
  ];
  const prepared = createPrivacyController().prepare(
    [...bundle.evidence, ...texts.map(pseudo)],
    ctx,
  );
  const n = bundle.evidence.length;
  let k = n;
  const next = (fallback: string) => prepared.evidence[k++]?.excerpt ?? fallback;

  // The client ref is a known term (CLIENT_REF) → tokenized by the same vault.
  const clientRef = next(bundle.appointment.clientRef);
  const serviceDescription = next("");
  const outClaims: CorpusClaim[] = claims.map(({ raw, ...c }) => ({ ...c, text: next(raw) }));
  const outLines = noteLines.map((l) => ({ section: l.section, text: next(l.raw) }));
  const outGoals = goals.map((g) => ({ goalId: g.goalId, objective: next(g.objective) }));
  const outAtts = atts.map((a) => ({ field: a.field, text: next(a.text) }));
  const missing = bundle.facts.missingInformation.map((m) => next(m));
  const outMsgs = messages.map((m) => ({ role: m.role, content: next(m.content) }));

  return {
    clientRef,
    serviceCode: bundle.appointment.serviceCode,
    serviceDescription,
    segments: prepared.evidence.slice(0, n).map((e) => ({
      id: e.id,
      speaker: e.speaker ?? null,
      at: e.observedFrom,
      text: e.excerpt,
    })),
    claims: outClaims,
    noteLines: outLines,
    goals: outGoals,
    attestations: outAtts,
    missing,
    messages: outMsgs,
    restore: prepared.restoreText,
    findings: Object.fromEntries(Object.entries(prepared.report.findings).map(([t, c]) => [t, c ?? 0])),
  };
}
