/**
 * Pure helpers for the review summary + assistant chat (no React, no DOM; unit-tested).
 * Everything here is computed locally from the bundle — no model call.
 */
import type { ReviewEdits, SessionBundle } from "../../../contracts";
import type { AssistantMessage, AssistantProposal, ProposedEdits } from "../../../assistant/types";

// ------------------------------------------------------------------ summary

/** What needs attention, in plain words, from the server's blocking checks. */
const ATTENTION_TEXT: Record<string, string> = {
  confirmed_duration: "How long did the visit actually run? (confirmed minutes)",
  goal_addressed: "Which plan goals were worked on?",
  progress_statement: "A short progress statement",
  service_description: "A summary of what you did in the visit",
  client_reference: "The client reference is missing",
  service_date: "The service date is missing",
  provider_identity: "The provider identity is missing",
};

export interface AttentionItem {
  key: string;
  field: string;
  text: string;
  blocking: boolean;
}

export const CLAIM_EXCEEDS_EVIDENCE = "CLAIM_EXCEEDS_EVIDENCE";

/** Claim id named by a CLAIM_EXCEEDS_EVIDENCE issue (field "claim:<id>"). */
export function refusedClaimId(issue: { code: string; field: string }): string | null {
  return issue.code === CLAIM_EXCEEDS_EVIDENCE && issue.field.startsWith("claim:") ? issue.field.slice(6) : null;
}

export function attentionItems(bundle: SessionBundle): AttentionItem[] {
  const out: AttentionItem[] = [];
  const seen = new Set<string>();
  const claimText = new Map(allExtractedClaims(bundle).map((c) => [c.id, c.text]));
  for (const i of bundle.checks.issues) {
    if (!i.blocking) continue;
    const k = `${i.code}:${i.field}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const refused = refusedClaimId(i);
    const text = refused
      ? `A draft statement goes beyond the evidence and was refused: “${(claimText.get(refused) ?? refused).slice(0, 120)}” — remove or rewrite it`
      : i.code === CLAIM_EXCEEDS_EVIDENCE
        ? i.message.slice(0, 240)
        : (ATTENTION_TEXT[i.field] ?? i.message);
    out.push({ key: k, field: refused ? "claim" : i.field, text, blocking: true });
  }
  for (const item of bundle.checks.checklist?.items ?? []) {
    if (item.status !== "fail" || !item.blocksApproval) continue;
    const k = `checklist:${item.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, field: item.group, text: `${item.label}: ${item.detail}`.slice(0, 240), blocking: true });
  }
  return out;
}

export interface ClaimRow {
  id: string;
  text: string;
  support: "supported" | "uncertain" | "provider_confirmed";
  evidenceIds: string[];
}

/** Claims the drafter extracted (the ones a provider can remove). */
export function allExtractedClaims(bundle: SessionBundle): ClaimRow[] {
  const f = bundle.extractedFacts ?? bundle.facts;
  const seen = new Set<string>();
  return [...f.activities, ...f.observations, ...f.progress, ...f.followUps, ...f.goals.flatMap((g) => g.claims)].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

/** Removals the provider already made (claim_rejected attestations: "<claimId>\n<reason>"). Local parse: keeps zod out of the UI bundle. */
export function existingRejections(bundle: SessionBundle): { claimId: string; reason: string }[] {
  const out = new Map<string, string>();
  for (const a of bundle.attestations) {
    if ((a.field as string) !== "claim_rejected") continue;
    const i = a.text.indexOf("\n");
    if (i <= 0) continue;
    out.set(a.text.slice(0, i), a.text.slice(i + 1).trim());
  }
  return [...out].map(([claimId, reason]) => ({ claimId, reason }));
}

/** Edits for removing one claim manually: keeps earlier removals (the server replaces the list). */
export function removeClaimEdits(bundle: SessionBundle, claimId: string, reason: string): ReviewEdits | null {
  const r = reason.trim();
  if (r.length < 3 || r.length > 500) return null;
  const rest = existingRejections(bundle).filter((x) => x.claimId !== claimId);
  return { rejectedClaims: [...rest, { claimId, reason: r }].slice(0, 50) } as ReviewEdits;
}

/** Draft claims the drafter itself was unsure about (worth a look). */
export function uncertainClaims(bundle: SessionBundle): { id: string; text: string }[] {
  const f = bundle.facts;
  return [...f.activities, ...f.observations, ...f.progress, ...f.followUps, ...f.goals.flatMap((g) => g.claims)]
    .filter((c) => c.support === "uncertain")
    .map((c) => ({ id: c.id, text: c.text }));
}

function latest(bundle: SessionBundle, field: string): string | null {
  let best: { text: string; at: string } | null = null;
  for (const a of bundle.attestations) {
    if (a.field !== field) continue;
    if (!best || a.attestedAt >= best.at) best = { text: a.text, at: a.attestedAt };
  }
  return best?.text ?? null;
}

/** 3–4 short lines: the provider's own summary if any, else extracted activities, else note lines. */
export function whatHappened(bundle: SessionBundle, max = 4): { lines: string[]; source: "provider" | "evidence" | "note" | "none" } {
  const own = latest(bundle, "activity_summary");
  if (own) return { lines: splitSentences(own).slice(0, max), source: "provider" };
  const acts = bundle.facts.activities.map((c) => c.text.trim()).filter(Boolean);
  if (acts.length > 0) return { lines: acts.slice(0, max), source: "evidence" };
  const note = bundle.documents.sections.find((s) => s.key === "session_note");
  const lines = (note?.lines ?? []).filter((l) => l.origin === "extracted" || l.origin === "provider_attestation").map((l) => l.text);
  if (lines.length > 0) return { lines: lines.slice(0, max), source: "note" };
  return { lines: [], source: "none" };
}

function splitSentences(s: string): string[] {
  return s
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export interface GoalChip {
  goalId: string;
  label: string;
  status: "addressed" | "partially_addressed" | "unknown";
  providerConfirmed: boolean;
}

export function goalChips(bundle: SessionBundle): GoalChip[] {
  const confirmed = new Set(bundle.attestations.filter((a) => a.field === "goal_addressed").map((a) => a.text.trim()));
  const cov = new Map(bundle.documents.planCoverage.map((p) => [p.goalId, p]));
  return bundle.config.plan.goals.map((g) => {
    const c = cov.get(g.goalId);
    return {
      goalId: g.goalId,
      label: g.objective,
      status: c?.status ?? "unknown",
      providerConfirmed: confirmed.has(g.goalId) || c?.support === "provider_confirmed",
    };
  });
}

export function invoiceTotal(bundle: SessionBundle): { cents: number | null; estimate: boolean } {
  const b = bundle.billing;
  if (b.invoice && b.invoice.totalCents !== null) return { cents: b.invoice.totalCents, estimate: b.invoice.isEstimate };
  if (b.amountCents !== null) return { cents: b.amountCents, estimate: false };
  return { cents: b.estimateAmountCents, estimate: true };
}

export function minutesLine(bundle: SessionBundle): { recorded: number | null; confirmed: number | null; scheduled: number } {
  const t = bundle.documents.timeSummary;
  return { recorded: t.evidenceWindowMinutes, confirmed: t.confirmedMinutes, scheduled: t.scheduledMinutes };
}

// ------------------------------------------------------------------ page sections

/** Accordion order on the review page (right column). */
export const SECTION_ORDER = ["note", "checklist", "invoice", "evidence", "coverage", "runs", "files", "amend"] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

/** Blocking issues that each accordion is where you would look (the checklist shows them all). */
export function sectionBlockers(bundle: SessionBundle | null): Record<SectionKey, number> {
  const out: Record<SectionKey, number> = { note: 0, checklist: 0, invoice: 0, evidence: 0, coverage: 0, runs: 0, files: 0, amend: 0 };
  for (const i of bundle?.checks.issues ?? []) {
    if (!i.blocking) continue;
    out.checklist++;
    if (refusedClaimId(i) || i.field === "progress_statement" || i.field === "service_description") out.note++;
    else if (i.field === "confirmed_duration") out.invoice++;
    else if (i.field === "goal_addressed") out.coverage++;
  }
  return out;
}

/** Closed by default except the first accordion with blockers. */
export function initialOpen(bundle: SessionBundle | null): Record<string, boolean> {
  const b = sectionBlockers(bundle);
  const first = SECTION_ORDER.find((k) => b[k] > 0);
  return first ? { [first]: true } : {};
}

// ------------------------------------------------------------------ chat

export interface ProposalState extends AssistantProposal {
  status: "pending" | "applying" | "applied" | "dismissed" | "conflict" | "failed";
  note?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
  proposals?: ProposalState[];
  refusals?: string[];
  /** Generated in the browser (opening message, notes) — never sent to the model. */
  local?: boolean;
  error?: boolean;
}

export function openingMessage(bundle: SessionBundle): ChatMessage {
  const items = attentionItems(bundle);
  const unsure = uncertainClaims(bundle);
  let content: string;
  if (items.length === 0) {
    content =
      "Everything required is in place. Ask me anything about the visit, or tell me if something in the draft is wrong — I'll suggest a fix you can apply.";
  } else {
    content =
      `To approve, ${items.length} thing${items.length === 1 ? " needs" : "s need"} your input:\n` +
      items.map((i) => `• ${i.text}`).join("\n") +
      "\nTell me in your own words (for example “It ran 45 minutes”) and I'll prepare the change for you to apply.";
  }
  if (unsure.length > 0) content += `\nThe draft also has ${unsure.length} claim${unsure.length === 1 ? "" : "s"} marked uncertain — ask me to check ${unsure.length === 1 ? "it" : "them"}.`;
  return { id: `open-r${bundle.bundleRevision}`, role: "assistant", content, local: true };
}

export interface QuickReply {
  id: string;
  label: string;
  /** "send" sends `text` right away; "fill" puts it in the input (with the cursor at `cursor`). */
  mode: "send" | "fill";
  text: string;
  cursor?: number;
}

export function quickReplies(bundle: SessionBundle): QuickReply[] {
  const fields = new Set(attentionItems(bundle).map((i) => i.field));
  const out: QuickReply[] = [];
  if (fields.has("confirmed_duration") || bundle.documents.timeSummary.confirmedMinutes === null) {
    out.push({ id: "minutes", label: "It ran __ min", mode: "fill", text: "It ran  minutes.", cursor: 7 });
  }
  const chips = goalChips(bundle).filter((g) => !g.providerConfirmed);
  for (const g of chips.slice(0, 2)) {
    const short = g.label.length > 32 ? `${g.label.slice(0, 30)}…` : g.label;
    out.push({ id: `goal:${g.goalId}`, label: `Mark “${short}” addressed`, mode: "send", text: `We worked on the goal "${g.label}" (${g.goalId}) in this visit. Mark it addressed.` });
  }
  if (fields.has("service_description") || !latest(bundle, "activity_summary")) {
    out.push({ id: "summary", label: "Summarise the visit", mode: "send", text: "Summarise the visit from the transcript for the activity summary." });
  }
  if (fields.has("claim")) {
    out.push({ id: "refused", label: "Fix the refused statement", mode: "send", text: "Which draft statement was refused, and what should I do about it? Propose removing it if it's not supported." });
  }
  if (fields.has("progress_statement")) {
    out.push({ id: "progress", label: "Draft a progress statement", mode: "send", text: "Draft a short progress statement from what the transcript shows." });
  }
  out.push({ id: "misleading", label: "Anything misleading?", mode: "send", text: "Is anything in the draft unsupported or misleading?" });
  return out;
}

export type TextPart = { kind: "text"; text: string } | { kind: "cite"; id: string };

/** Splits text into plain parts and citation chips for known evidence ids ("[ev_002]" or "ev_002"). */
export function splitCitations(text: string, evidenceIds: readonly string[]): TextPart[] {
  if (!text) return [];
  const ids = [...evidenceIds].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (ids.length === 0) return [{ kind: "text", text }];
  const re = new RegExp(`\\[(${ids.join("|")})\\]|(?<![A-Za-z0-9_-])(${ids.join("|")})(?![A-Za-z0-9_-])`, "g");
  const out: TextPart[] = [];
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > pos) out.push({ kind: "text", text: text.slice(pos, m.index) });
    out.push({ kind: "cite", id: (m[1] ?? m[2])! });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

/** Messages sent to the server: user/assistant text only, no local notes, last 20. */
export function toApiMessages(history: ChatMessage[]): AssistantMessage[] {
  return history
    .filter((m) => !m.local && !m.error && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

/** Maps a (possibly provider-edited) proposal to the PATCH review edits. Drops empty values. */
export function toReviewEdits(e: ProposedEdits): ReviewEdits | null {
  const out: Record<string, unknown> = {};
  if (e.confirmedMinutes !== undefined && Number.isInteger(e.confirmedMinutes) && e.confirmedMinutes > 0) out.confirmedMinutes = e.confirmedMinutes;
  const text = (k: "progressConfirmation" | "activitySummary" | "participantChoices") => {
    const v = e[k]?.trim();
    if (v) out[k] = v;
  };
  text("progressConfirmation");
  text("activitySummary");
  text("participantChoices");
  if (e.participantDirected !== undefined) out.participantDirected = e.participantDirected;
  if (e.goalsAddressed !== undefined) out.goalsAddressed = [...new Set(e.goalsAddressed)];
  const rejected = (e.rejectedClaims ?? []).filter((r) => r.claimId && r.reason.trim()).map((r) => ({ claimId: r.claimId, reason: r.reason.trim() }));
  if (rejected.length > 0) out.rejectedClaims = rejected;
  return Object.keys(out).length > 0 ? (out as ReviewEdits) : null;
}

// ------------------------------------------------------------------ history (sessionStorage, best effort)

const MAX_STORED = 40;

export function historyKey(sessionId: string, revision: number): string {
  return `rv-chat:${sessionId}:r${revision}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadHistory(storage: StorageLike | null | undefined, key: string): ChatMessage[] | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    return v.filter(
      (m): m is ChatMessage =>
        !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && typeof m.id === "string",
    );
  } catch {
    return null;
  }
}

export function saveHistory(storage: StorageLike | null | undefined, key: string, history: ChatMessage[]): void {
  try {
    storage?.setItem(key, JSON.stringify(history.slice(-MAX_STORED)));
  } catch {
    /* storage full or blocked — chat still works in memory */
  }
}

export function safeSessionStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
