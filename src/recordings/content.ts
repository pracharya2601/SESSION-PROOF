/**
 * Pass 2 of the partition: CONTENT suggestions for the segments the frozen time rule (pass 1,
 * partition.ts) left unassigned or ambiguous. Pure and deterministic (no I/O): boundary
 * detection, candidate scoring, AI request/validation and how the two are combined. The job
 * that loads data and persists suggestions is content-job.ts; accepting one is content-accept.ts.
 *
 * Nothing here ever ASSIGNS a segment. A suggestion is a proposal the provider confirms.
 *
 *   1. blocks: split the leftover segments at silence gaps (> 90 s, hard), speaker-set changes
 *      (disjoint speaker sets in the 3 segments either side, soft) and lexical topic shifts
 *      (bag-of-words cosine of the 3-segment windows either side < 0.10, soft); merge tiny blocks
 *      (< 2 segments or < 30 s) into a neighbour; after scoring, merge soft-split neighbours that
 *      reached the same outcome.
 *   2. score each candidate client: content = 0.6 · goal-term overlap (3 distinct terms = 1)
 *      + 0.4 · TF-IDF cosine vs the client's Drive plan text (0.25 = 1); score = 0.8 · content
 *      + 0.2 · time proximity to the client's event (1 − gap / 4 h). A candidate is eligible
 *      with content ≥ 0.30 and ≥ 2 distinct matched plan terms; otherwise the block is "none".
 *   3. optional AI pick among the candidate clientRefs (or "none"), strictly validated, then
 *      combined with the rules confidence.
 *
 * Rationales are composed here from plan keywords, segment indexes and minutes only: never
 * transcript text and never names (known name parts are stripped from plan text first).
 */
import type { InferenceRequest } from "../contracts";

// ------------------------------------------------------------------ thresholds
export const CONTENT_RULES = {
  /** Silence between two segments longer than this always starts a new block. */
  SILENCE_GAP_MS: 90_000,
  /** Segments on each side compared for speaker / topic shifts. */
  WINDOW: 3,
  /** Topic shift when the bag-of-words cosine of the two windows is below this. */
  TOPIC_COSINE_MIN: 0.1,
  /** Both windows need at least this many content tokens for a topic decision. */
  TOPIC_MIN_TOKENS: 5,
  /** A block with fewer segments or a shorter span is merged into a neighbour. */
  TINY_MIN_SEGMENTS: 2,
  TINY_MIN_MS: 30_000,
  /** A tiny block isolated by silence merges across at most this gap. */
  TINY_MERGE_MAX_GAP_MS: 10 * 60_000,
  /** Calendar candidates: the provider's events on the block's local day within ± 4 h. */
  CANDIDATE_WINDOW_MS: 4 * 3600_000,
  /** The suggested client's event this close (or overlapping) → kind "event", else "unscheduled". */
  NEAR_EVENT_MS: 60 * 60_000,
  /**
   * Visit tail / early start: a block that ends ≤ 20 min before a candidate's event starts or
   * starts ≤ 20 min after it ends, and names the participant or matches ≥ 2 plan terms, extends
   * THAT event even below the content threshold (goodbyes rarely carry plan terms).
   */
  TAIL_MS: 20 * 60_000,
  TAIL_MIN_TERMS: 2,
  /** Caseload fallback (no calendar candidate, or none matched): at most this many clients. */
  CASELOAD_CAP: 8,
  W_GOAL: 0.6,
  W_TFIDF: 0.4,
  W_CONTENT: 0.8,
  W_TIME: 0.2,
  GOAL_TERMS_FULL: 3,
  TFIDF_FULL: 0.25,
  MIN_CONTENT: 0.3,
  MIN_TERMS: 2,
  /** At most this many blocks per recording go to the AI provider. */
  MAX_AI_BLOCKS: 8,
} as const;

// ------------------------------------------------------------------ text
const STOP = new Set(
  (
    "the and for are but not you your yours yourself all any can had has have her hers him his how its our ours out own she they them " +
    "their theirs this that these those then than there here what when where which who whom why will with would could should shall " +
    "about above after again against also because been before being below between both down during each few from further into more " +
    "most much off once only other over same some such too under until very was were while does did doing done just like yeah yes okay " +
    "ok um uh hmm mhm right well really know think going gonna want wanna got get gets getting let lets now today tomorrow yesterday " +
    "good great nice thank thanks please sure maybe kind sort thing things stuff way lot lots little bit one two three first next last " +
    "time minute minutes hour hours day days week weeks weekly month monthly year say said tell told look looks looking see come came " +
    "make made take took put use used using need needs try tried back still even ever every something anything nothing everything " +
    "someone anyone people person per via etc " +
    // plan / domain boilerplate that every client's documents share
    "synthetic demo document fictional real participant client provider service services plan plans planned goal goals objective " +
    "measure session sessions note notes previous visit visits sdp code coordinator example program self determination individual " +
    "support supports practice practise practiced practised prompt prompts independently independent decreasing fewer simple " +
    "authorization authorized funding regional center valid rate hourly frequency preferences prefers"
  ).split(/\s+/),
);

/** Tiny suffix stemmer (budgeting → budget, receipts → receipt, planning → plan). */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ied")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  // Doubled final consonant after -ing/-ed ("plann" → "plan", "shopp" → "shop").
  if (w !== word && w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Content tokens as [stem, surface] pairs, in order. */
export function tokenPairs(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOP.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 3 || STOP.has(s)) continue;
    out.push([s, raw]);
  }
  return out;
}

export function tokens(text: string): string[] {
  return tokenPairs(text).map((p) => p[0]);
}

type Bag = Map<string, number>;

export function bag(toks: string[]): Bag {
  const b: Bag = new Map();
  for (const t of toks) b.set(t, (b.get(t) ?? 0) + 1);
  return b;
}

export function cosine(a: Bag, b: Bag): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Removes known name parts (client display / participant names) from plan text before scoring. */
export function stripNames(text: string, names: string[]): string {
  let out = text;
  const parts = new Set<string>();
  for (const n of names) {
    for (const p of n.replace(/\([^)]*\)/g, " ").split(/[^\p{L}\p{M}'’-]+/u)) if (p.length >= 3) parts.add(p);
  }
  for (const p of parts) out = out.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  return out;
}

// ------------------------------------------------------------------ blocks
export interface LeftoverSegment {
  index: number;
  observedFrom: string;
  observedTo: string;
  speaker: string | null;
  text: string;
}

export interface Block {
  segments: LeftoverSegment[];
  fromMs: number;
  toMs: number;
  /** Boundary type before this block ("start" for the first). Only soft boundaries are re-merged after scoring. */
  before: "start" | "hard" | "soft";
}

const msOf = (s: string) => Date.parse(s);

function makeBlock(segments: LeftoverSegment[], before: Block["before"]): Block {
  return {
    segments,
    fromMs: Math.min(...segments.map((s) => msOf(s.observedFrom))),
    toMs: Math.max(...segments.map((s) => Math.max(msOf(s.observedTo), msOf(s.observedFrom)))),
    before,
  };
}

function speakerSet(segs: LeftoverSegment[]): Set<string> | null {
  const s = new Set(segs.map((x) => x.speaker?.trim()).filter((x): x is string => !!x));
  return s.size ? s : null;
}

/** Boundary between segs[i-1] and segs[i]: hard (silence), soft (speaker / topic) or none. Pure. */
export function boundaryAt(segs: LeftoverSegment[], i: number): "hard" | "soft" | null {
  const R = CONTENT_RULES;
  const prev = segs[i - 1]!;
  const cur = segs[i]!;
  if (msOf(cur.observedFrom) - Math.max(msOf(prev.observedTo), msOf(prev.observedFrom)) > R.SILENCE_GAP_MS) return "hard";
  const before = segs.slice(Math.max(0, i - R.WINDOW), i);
  const after = segs.slice(i, i + R.WINDOW);
  if (before.length < R.WINDOW || after.length < R.WINDOW) return null;
  const sa = speakerSet(before);
  const sb = speakerSet(after);
  if (sa && sb && ![...sa].some((x) => sb.has(x))) return "soft";
  const ta = tokens(before.map((s) => s.text).join(" "));
  const tb = tokens(after.map((s) => s.text).join(" "));
  if (ta.length >= R.TOPIC_MIN_TOKENS && tb.length >= R.TOPIC_MIN_TOKENS && cosine(bag(ta), bag(tb)) < R.TOPIC_COSINE_MIN) return "soft";
  return null;
}

function isTiny(b: Block): boolean {
  return b.segments.length < CONTENT_RULES.TINY_MIN_SEGMENTS || b.toMs - b.fromMs < CONTENT_RULES.TINY_MIN_MS;
}

function join(a: Block, b: Block): Block {
  return makeBlock([...a.segments, ...b.segments], a.before);
}

/** Merges tiny blocks into the nearer neighbour (across a hard boundary only up to 10 min). Pure. */
export function mergeTiny(blocks: Block[]): Block[] {
  const out = [...blocks];
  const fixed = new Set<Block>();
  for (;;) {
    const i = out.findIndex((b) => isTiny(b) && !fixed.has(b));
    if (i < 0 || out.length < 2) return out;
    const b = out[i]!;
    const prev = i > 0 ? out[i - 1]! : null;
    const next = i + 1 < out.length ? out[i + 1]! : null;
    const gapPrev = prev ? b.fromMs - prev.toMs : Infinity;
    const gapNext = next ? next.fromMs - b.toMs : Infinity;
    const okPrev = !!prev && (b.before === "soft" || gapPrev <= CONTENT_RULES.TINY_MERGE_MAX_GAP_MS);
    const okNext = !!next && (next.before === "soft" || gapNext <= CONTENT_RULES.TINY_MERGE_MAX_GAP_MS);
    // Prefer a soft-connected neighbour, then the smaller gap.
    const softPrev = okPrev && b.before === "soft";
    const softNext = okNext && next!.before === "soft";
    let target: "prev" | "next" | null = null;
    if (softPrev !== softNext) target = softPrev ? "prev" : "next";
    else if (okPrev || okNext) target = okPrev && (!okNext || gapPrev <= gapNext) ? "prev" : "next";
    if (!target) {
      fixed.add(b);
      continue;
    }
    if (target === "prev") out.splice(i - 1, 2, join(prev!, b));
    else out.splice(i, 2, join(b, next!));
  }
}

/** Leftover segments → candidate blocks (before scoring). Pure and deterministic. */
export function detectBlocks(leftover: LeftoverSegment[]): Block[] {
  const segs = [...leftover].sort((a, b) => msOf(a.observedFrom) - msOf(b.observedFrom) || a.index - b.index);
  if (segs.length === 0) return [];
  const blocks: Block[] = [];
  let cur: LeftoverSegment[] = [segs[0]!];
  let before: Block["before"] = "start";
  for (let i = 1; i < segs.length; i++) {
    const kind = boundaryAt(segs, i);
    if (kind) {
      blocks.push(makeBlock(cur, before));
      cur = [];
      before = kind;
    }
    cur.push(segs[i]!);
  }
  blocks.push(makeBlock(cur, before));
  return mergeTiny(blocks);
}

// ------------------------------------------------------------------ candidates + scoring
export interface CandidateEvent {
  eventId: string;
  startMs: number;
  endMs: number;
}

export interface Candidate {
  clientRef: string;
  goals: { goalId: string; objective: string }[];
  /** Drive plan text (service plan + previous notes + assessment), names already stripped. */
  planText: string;
  /** This client's calendar events near the block (empty for caseload candidates). */
  events: CandidateEvent[];
  /**
   * Known name parts of the participant (Drive plan + client record), matched locally only: never
   * sent to the AI provider, stored or written into a rationale.
   */
  nameParts?: string[];
}

export interface CandidateScore {
  clientRef: string;
  goal: number;
  tfidf: number;
  time: number;
  content: number;
  score: number;
  /** Plan-side surface words that matched (for the rationale; never transcript text). */
  matchedTerms: string[];
  eligible: boolean;
  /** The block names the participant (local match on known name parts; the name is never kept). */
  named?: boolean;
  nearestEvent: { eventId: string; gapMs: number; startMs: number; endMs: number } | null;
}

export interface RulesDecision {
  clientRef: string | null;
  eventId: string | null;
  confidence: number;
  scores: CandidateScore[];
  /** Picked by the visit-tail rule (TAIL_MS) rather than the content threshold. */
  tail?: boolean;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function nearest(events: CandidateEvent[], fromMs: number, toMs: number): CandidateScore["nearestEvent"] {
  let best: CandidateScore["nearestEvent"] = null;
  for (const e of events) {
    const gap = Math.max(0, e.startMs - toMs, fromMs - e.endMs);
    if (!best || gap < best.gapMs || (gap === best.gapMs && e.startMs < best.startMs)) best = { eventId: e.eventId, gapMs: gap, startMs: e.startMs, endMs: e.endMs };
  }
  return best;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the text names one of these name parts (≥ 3 letters, whole word, any case). */
export function mentionsName(text: string, nameParts: string[] | undefined): boolean {
  const parts = [...new Set((nameParts ?? []).filter((p) => p.length >= 3))];
  if (parts.length === 0) return false;
  return new RegExp(`\\b(?:${parts.map(escapeRe).join("|")})\\b`, "i").test(text);
}

/** The candidate's event this block is the tail (or early start) of, within TAIL_MS and outside the slot. */
function tailEvent(events: CandidateEvent[], fromMs: number, toMs: number): { eventId: string; gapMs: number } | null {
  let best: { eventId: string; gapMs: number } | null = null;
  for (const e of events) {
    const gap = fromMs >= e.endMs ? fromMs - e.endMs : toMs <= e.startMs ? e.startMs - toMs : -1;
    if (gap < 0 || gap > CONTENT_RULES.TAIL_MS) continue;
    if (!best || gap < best.gapMs) best = { eventId: e.eventId, gapMs: gap };
  }
  return best;
}

/** Scores one block against a candidate set (rules only). Pure. */
export function scoreBlock(block: Pick<Block, "segments" | "fromMs" | "toMs">, candidates: Candidate[]): RulesDecision {
  const R = CONTENT_RULES;
  if (candidates.length === 0) return { clientRef: null, eventId: null, confidence: 0.5, scores: [] };
  const blockText = block.segments.map((s) => s.text).join(" ");
  const blockToks = tokens(blockText);
  const blockSet = new Set(blockToks);
  const models = candidates.map((c) => {
    const goalPairs = tokenPairs(c.goals.map((g) => `${g.goalId.replace(/^goal_/, "").replace(/_/g, " ")} ${g.objective}`).join(" "));
    const planPairs = tokenPairs(c.planText);
    const surface = new Map<string, string>();
    for (const [s, w] of [...goalPairs, ...planPairs]) if (!surface.has(s)) surface.set(s, w);
    return { c, goalTerms: new Set(goalPairs.map((p) => p[0])), doc: bag([...goalPairs, ...planPairs].map((p) => p[0])), surface };
  });
  const N = models.length;
  const df = new Map<string, number>();
  for (const m of models) for (const t of m.doc.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log((N + 1) / (df.get(t) ?? 1));
  const weigh = (b: Bag): Bag => new Map([...b].map(([t, v]) => [t, v * idf(t)]));
  const blockVec = weigh(bag(blockToks));

  const scores: CandidateScore[] = models.map((m) => {
    const goalHits = [...m.goalTerms].filter((t) => blockSet.has(t));
    const discriminative = [...m.doc.keys()].filter((t) => blockSet.has(t) && (N === 1 || (df.get(t) ?? 0) < N));
    const matched = [...new Set([...goalHits, ...discriminative])].sort();
    const goal = Math.min(1, goalHits.length / R.GOAL_TERMS_FULL);
    const tfidf = Math.min(1, cosine(blockVec, weigh(m.doc)) / R.TFIDF_FULL);
    const content = R.W_GOAL * goal + R.W_TFIDF * tfidf;
    const near = nearest(m.c.events, block.fromMs, block.toMs);
    const time = near ? Math.max(0, 1 - near.gapMs / R.CANDIDATE_WINDOW_MS) : 0;
    const score = R.W_CONTENT * content + R.W_TIME * time;
    return {
      clientRef: m.c.clientRef,
      goal: round2(goal),
      tfidf: round2(tfidf),
      time: round2(time),
      content: round2(content),
      score: round2(score),
      matchedTerms: matched.map((t) => m.surface.get(t) ?? t),
      eligible: content >= R.MIN_CONTENT && matched.length >= R.MIN_TERMS,
      named: mentionsName(blockText, m.c.nameParts),
      nearestEvent: near,
    };
  });
  scores.sort((a, b) => b.score - a.score || a.clientRef.localeCompare(b.clientRef));
  const top = scores.find((s) => s.eligible);
  // Visit tail: right after (or before) a candidate's own slot, naming the participant or
  // matching plan terms → extend THAT event, even when the content threshold is not reached.
  const tails = scores
    .map((s) => ({ s, t: tailEvent(models.find((m) => m.c.clientRef === s.clientRef)!.c.events, block.fromMs, block.toMs) }))
    .filter((x) => x.t && (x.s.named || x.s.matchedTerms.length >= R.TAIL_MIN_TERMS))
    .sort((a, b) => Number(!!b.s.named) - Number(!!a.s.named) || a.t!.gapMs - b.t!.gapMs || b.s.score - a.s.score);
  const tail = tails[0];
  if (tail && (!top || top.clientRef === tail.s.clientRef)) {
    const others = tails.filter((x) => x.s.clientRef !== tail.s.clientRef);
    const confidence = 0.55 + (tail.s.named ? 0.1 : 0) + 0.05 * Math.min(2, tail.s.matchedTerms.length) + 0.1 * tail.s.content - (others.length ? 0.15 : 0);
    return { clientRef: tail.s.clientRef, eventId: tail.t!.eventId, confidence: round2(clamp(confidence, 0.3, 0.85)), scores, tail: true };
  }
  if (!top) {
    const best = Math.max(0, ...scores.map((s) => s.content));
    return { clientRef: null, eventId: null, confidence: round2(clamp(0.7 - best, 0.2, 0.7)), scores };
  }
  const second = scores.find((s) => s !== top);
  const margin = top.score - (second?.score ?? 0);
  return {
    clientRef: top.clientRef,
    eventId: eventFor(top),
    confidence: round2(clamp(0.3 + 0.45 * top.score + 0.5 * margin, 0.05, 0.85)),
    scores,
  };
}

/** The candidate's event the block extends (overlapping or within 60 min), else null (unscheduled). */
export function eventFor(s: CandidateScore | undefined): string | null {
  return s?.nearestEvent && s.nearestEvent.gapMs <= CONTENT_RULES.NEAR_EVENT_MS ? s.nearestEvent.eventId : null;
}

/** After scoring: merge soft-split neighbours with the same outcome (rescoring the union). Pure. */
export function mergeSameOutcome<T extends { block: Block; decision: RulesDecision }>(items: T[], rescore: (b: Block) => T): T[] {
  const out = [...items];
  for (let i = 1; i < out.length; ) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const same = b.block.before === "soft" && a.decision.clientRef === b.decision.clientRef && a.decision.eventId === b.decision.eventId;
    if (same) out.splice(i - 1, 2, rescore(join(a.block, b.block)));
    else i++;
  }
  return out;
}

// ------------------------------------------------------------------ AI
export interface AiLine {
  index: number;
  speaker: string | null;
  /** Privacy-scrubbed text. */
  text: string;
}

export interface AiCandidate {
  clientRef: string;
  /** Privacy-scrubbed objectives. */
  goals: { goalId: string; objective: string }[];
}

export const SUGGEST_TOOL = {
  name: "pick_client",
  description: "Pick which candidate client this transcript block is about, or none.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clientRef", "confidence", "rationale", "citedSegmentIndexes"],
    properties: {
      clientRef: { type: "string", description: 'One of the candidate clientRefs, or "none".' },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string", maxLength: 200, description: "Short reason citing segment indexes; no quotes, no names." },
      citedSegmentIndexes: { type: "array", items: { type: "integer" }, maxItems: 50 },
    },
  },
} as const;

const SYSTEM = [
  "You help a home-and-community-services provider file transcript lines that the calendar could not place.",
  "You get one block of transcript lines (already de-identified; [NAME_1]-style tokens replace personal data) and candidate clients, each with the goals of their service plan.",
  'Pick the ONE candidate whose goals the block is clearly working on, or "none" when the block is small talk, travel, admin or matches no candidate.',
  "Only use clientRefs from the candidate list. Cite the segment indexes (the numbers in i) that support your pick.",
  "The rationale must be under 200 characters, cite indexes, and must not quote the transcript or contain any name or token.",
  "Your pick is only a suggestion; the provider decides.",
].join(" ");

/** The structured inference request. Only scrubbed lines and {clientRef, goals} leave the Worker. */
export function buildAiRequest(lines: AiLine[], candidates: AiCandidate[]): InferenceRequest {
  const user = JSON.stringify({
    block: lines.map((l) => ({ i: l.index, speaker: l.speaker, text: l.text.slice(0, 1000) })),
    candidates: candidates.map((c) => ({ clientRef: c.clientRef, goals: c.goals.map((g) => ({ goalId: g.goalId, objective: g.objective.slice(0, 300) })) })),
  });
  return { system: SYSTEM, user, tool: { ...SUGGEST_TOOL, inputSchema: SUGGEST_TOOL.inputSchema as unknown as Record<string, unknown> }, maxTokens: 300 };
}

export interface AiPick {
  clientRef: string | null;
  confidence: number;
  citedSegmentIndexes: number[];
}

/**
 * Strict validation of the model output. null (ignored) unless: an object with exactly the four
 * fields; clientRef a candidate or "none"; confidence in [0, 1]; rationale a string ≤ 200 chars;
 * cited indexes integers inside the block, at least one for a client pick.
 */
export function validateAiOutput(out: unknown, candidateRefs: string[], blockIndexes: number[]): AiPick | null {
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  const o = out as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "citedSegmentIndexes,clientRef,confidence,rationale") return null;
  const { clientRef, confidence, rationale, citedSegmentIndexes } = o;
  if (typeof clientRef !== "string") return null;
  const isNone = clientRef.trim().toLowerCase() === "none";
  if (!isNone && !candidateRefs.includes(clientRef)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (typeof rationale !== "string" || rationale.length > 200) return null;
  if (!Array.isArray(citedSegmentIndexes) || citedSegmentIndexes.length > 50) return null;
  const allowed = new Set(blockIndexes);
  if (!citedSegmentIndexes.every((x) => Number.isInteger(x) && allowed.has(x as number))) return null;
  if (!isNone && citedSegmentIndexes.length === 0) return null;
  return { clientRef: isNone ? null : clientRef, confidence, citedSegmentIndexes: [...new Set(citedSegmentIndexes as number[])].sort((a, b) => a - b) };
}

export interface FinalDecision {
  clientRef: string | null;
  eventId: string | null;
  confidence: number;
  method: "rules" | "ai+rules";
  ai: AiPick | null;
  agreed: boolean | null;
}

/**
 * Rules + AI. Agreement: min(0.95, (rules + ai) / 2 + 0.1). Disagreement: the more confident
 * side wins at half its confidence. No (valid) AI output: the rules decision as is.
 */
export function combine(rules: RulesDecision, ai: AiPick | null): FinalDecision {
  if (!ai) return { clientRef: rules.clientRef, eventId: rules.eventId, confidence: rules.confidence, method: "rules", ai: null, agreed: null };
  if (ai.clientRef === rules.clientRef) {
    return { clientRef: rules.clientRef, eventId: rules.eventId, confidence: round2(Math.min(0.95, (rules.confidence + ai.confidence) / 2 + 0.1)), method: "ai+rules", ai, agreed: true };
  }
  if (rules.tail && rules.clientRef && ai.clientRef === null) {
    // The AI sees de-identified lines without the calendar: "none" on a goodbye next to the
    // client's own slot does not override the tail rule (the provider still decides).
    return { clientRef: rules.clientRef, eventId: rules.eventId, confidence: round2(rules.confidence * 0.85), method: "ai+rules", ai, agreed: false };
  }
  if (ai.confidence > rules.confidence) {
    const s = rules.scores.find((x) => x.clientRef === ai.clientRef);
    return { clientRef: ai.clientRef, eventId: ai.clientRef ? eventFor(s) : null, confidence: round2(ai.confidence / 2), method: "ai+rules", ai, agreed: false };
  }
  return { clientRef: rules.clientRef, eventId: rules.eventId, confidence: round2(rules.confidence / 2), method: "ai+rules", ai, agreed: false };
}

// ------------------------------------------------------------------ rationale
function ranges(idx: number[]): string {
  const s = [...idx].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

/** ≤ 200 chars from plan keywords, indexes and minutes only (no transcript text, no names). */
export function composeRationale(final: FinalDecision, rules: RulesDecision, block: Pick<Block, "segments" | "fromMs" | "toMs">): string {
  const segs = `segs ${ranges(block.segments.map((s) => s.index))}`;
  let text: string;
  if (final.clientRef) {
    const s = rules.scores.find((x) => x.clientRef === final.clientRef);
    const terms = (s?.matchedTerms ?? []).slice(0, 5).join(", ");
    let when = "no event nearby (unscheduled)";
    const n = s?.nearestEvent;
    if (final.eventId && n) {
      if (n.gapMs === 0) when = "overlaps its event";
      else if (block.fromMs >= n.endMs) when = `${Math.round(n.gapMs / 60_000)} min after its event`;
      else when = `${Math.round(n.gapMs / 60_000)} min before its event`;
    }
    const named = s?.named ? "participant named; " : "";
    text = `${terms ? `Plan terms: ${terms}` : "Few plan terms"} (${named}${segs}); ${when}${rules.tail && final.clientRef === rules.clientRef ? " (visit tail)" : ""}.`;
  } else {
    const best = rules.scores[0];
    text = rules.scores.length
      ? `No goal/plan terms of ${rules.scores.length} candidate(s) matched (${segs}; best ${best!.matchedTerms.length} term(s)).`
      : `No candidate clients with Drive context (${segs}).`;
  }
  if (final.ai) {
    const cited = final.ai.citedSegmentIndexes.length ? `, cited ${ranges(final.ai.citedSegmentIndexes)}` : "";
    text += final.agreed ? ` AI agreed (${round2(final.ai.confidence)}${cited}).` : ` AI picked ${final.ai.clientRef ?? "none"} (${round2(final.ai.confidence)}${cited}).`;
  }
  return text.slice(0, 200);
}
