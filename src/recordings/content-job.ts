/**
 * Pass 2 job (runs right after pass 1 in the partition job, partition.ts): content suggestions
 * for leftover segments + the conversation type of every session block and suggestion block.
 * Best effort: it never fails the partition, and it never assigns a segment.
 *
 * Privacy: the AI provider (optional) receives ONLY privacy-scrubbed block lines
 * (src/privacy, tokenize; nothing is restored) and candidates as {clientRef, goals}. Logs
 * carry ids and counts only.
 */
import type { CalendarEvent, CalendarSource, Clock, DriveClientContext, DriveSource, EvidenceItem, InferenceProvider, PiiType, PrivacyOptions } from "../contracts";
import type { AiSettings } from "../contracts";
import type { Env } from "../env";
import { envDefaultAiSettings } from "../ai/index";
import { apiKeyFor, createInferenceProvider } from "../ai/providers";
import { createPrivacyController } from "../privacy";
import { parseParticipantName } from "../schedule/drive-parse";
import { log } from "../security";
import {
  CONTENT_RULES,
  buildAiRequest,
  combine,
  composeRationale,
  detectBlocks,
  mergeSameOutcome,
  scoreBlock,
  stripNames,
  validateAiOutput,
  type AiLine,
  type Block,
  type Candidate,
  type LeftoverSegment,
  type RulesDecision,
} from "./content";
import { buildConversationRequest, classifyConversation, combineConversation, validateConversationOutput, type ConversationResult } from "./content-conversation";
import type { RecordingRow, RecordingStore, SuggestionRow } from "./store";

export interface ContentAi {
  provider: InferenceProvider;
  privacy: PrivacyOptions;
}

export interface ContentDeps {
  store: RecordingStore;
  clock: Clock;
  calendar?: CalendarSource;
  drive?: DriveSource;
  /** The provider's active client refs (caseload fallback). */
  listClientRefs?: (providerId: string) => Promise<string[]>;
  /** Known PII terms (client names on file) for these clients; always scrubbed before inference. */
  knownTerms?: (providerId: string, clientRefs: string[]) => Promise<{ value: string; type: PiiType }[]>;
  /** The provider's AI (EXTRACTION_MODE live + key present), else null → rules only. */
  resolveAi?: (providerId: string) => Promise<ContentAi | null>;
}

const DAY_MS = 86_400_000;
const PLAN_KINDS = new Set(["service_plan", "previous_note", "assessment"]);

function localDate(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function suggestionIdFor(recordingId: string, indexes: number[]): Promise<string> {
  return `sug_${(await sha(`${recordingId}|${[...indexes].sort((a, b) => a - b).join(",")}`)).slice(0, 24)}`;
}

/** Name parts ≥ 3 letters ("Jordan", "Mendez"), without parenthetical qualifiers like "(synthetic)". */
export function nameParts(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) for (const p of n.replace(/\([^)]*\)/g, " ").split(/[^\p{L}\p{M}'’-]+/u)) if (p.length >= 3) out.add(p);
  return [...out];
}

/** Per-run caches: Drive contexts, candidates, known names. */
export function candidateFactory(deps: ContentDeps, providerId: string) {
  const ctxs = new Map<string, Promise<DriveClientContext | null>>();
  const ctxFor = (clientRef: string) => {
    if (!ctxs.has(clientRef)) ctxs.set(clientRef, deps.drive ? deps.drive.getClientContext(providerId, clientRef).catch(() => null) : Promise.resolve(null));
    return ctxs.get(clientRef)!;
  };
  const names = new Map<string, Promise<string[]>>();
  const namesFor = (clientRef: string, ctx: DriveClientContext) => {
    if (!names.has(clientRef)) {
      names.set(
        clientRef,
        (async () => {
          const out: string[] = [];
          const plan = ctx.documents.find((d) => d.kind === "service_plan");
          const parsed = plan ? parseParticipantName(plan.text) : null;
          if (parsed) out.push(parsed);
          const terms = (await deps.knownTerms?.(providerId, [clientRef]).catch(() => [])) ?? [];
          for (const t of terms) if (t.type === "NAME") out.push(t.value);
          return out;
        })(),
      );
    }
    return names.get(clientRef)!;
  };
  const candidateFor = async (clientRef: string, events: CalendarEvent[]): Promise<Candidate | null> => {
    const ctx = await ctxFor(clientRef);
    if (!ctx) return null;
    const n = await namesFor(clientRef, ctx);
    const text = ctx.documents.filter((d) => PLAN_KINDS.has(d.kind)).map((d) => d.text).join("\n");
    return {
      clientRef,
      goals: ctx.goals.map((g) => ({ goalId: g.goalId, objective: stripNames(g.objective, n) })),
      planText: stripNames(text, n),
      events: events.map((e) => ({ eventId: e.eventId, startMs: Date.parse(e.startAt), endMs: Date.parse(e.endAt) })),
      nameParts: nameParts(n),
    };
  };
  return { ctxFor, candidateFor, namesFor };
}

/** Scrubs block lines + goals in ONE privacy pass (consistent tokens). Nothing is ever restored. */
export async function scrubForAi(
  deps: ContentDeps,
  providerId: string,
  ai: ContentAi,
  lines: LeftoverSegment[],
  candidates: { clientRef: string; goals: { goalId: string; objective: string }[] }[],
): Promise<{ lines: AiLine[]; candidates: { clientRef: string; goals: { goalId: string; objective: string }[] }[] }> {
  const refs = candidates.map((c) => c.clientRef);
  const terms = (await deps.knownTerms?.(providerId, refs)) ?? []; // throws → caller skips the AI (fail closed)
  // Participant names parsed from Drive plans are known terms too.
  const f = candidateFactory(deps, providerId);
  for (const r of refs) {
    const ctx = await f.ctxFor(r);
    if (!ctx) continue;
    for (const n of await f.namesFor(r, ctx)) {
      terms.push({ value: n, type: "NAME" });
      // Name parts too ("Jordan" alone), without parenthetical qualifiers like "(synthetic)".
      for (const p of n.replace(/\([^)]*\)/g, " ").split(/[^\p{L}\p{M}'’-]+/u)) if (p.length >= 3) terms.push({ value: p, type: "NAME" });
    }
  }
  const now = deps.clock.now().toISOString();
  const items: EvidenceItem[] = [
    ...lines.map((l) => ({ id: `seg_${l.index}`, sourceId: null, sourceMode: "live" as const, observedFrom: null, observedTo: null, speaker: l.speaker, excerpt: l.text.slice(0, 4000), retrievedAt: now })),
    ...candidates.flatMap((c, ci) =>
      c.goals.map((g, gi) => ({ id: `goal_${ci}_${gi}`, sourceId: null, sourceMode: "live" as const, observedFrom: null, observedTo: null, speaker: null, excerpt: g.objective.slice(0, 500), retrievedAt: now })),
    ),
  ];
  const prepared = createPrivacyController().prepare(items, { options: { ...ai.privacy, redactNames: true }, knownTerms: terms.filter((t) => t.value.trim()) });
  const byId = new Map(prepared.evidence.map((e) => [e.id, e]));
  return {
    lines: lines.map((l) => ({ index: l.index, speaker: byId.get(`seg_${l.index}`)?.speaker ?? null, text: byId.get(`seg_${l.index}`)?.excerpt ?? "" })),
    candidates: candidates.map((c, ci) => ({ clientRef: c.clientRef, goals: c.goals.map((g, gi) => ({ goalId: g.goalId, objective: byId.get(`goal_${ci}_${gi}`)?.excerpt ?? "" })) })),
  };
}

async function aiConversation(deps: ContentDeps, providerId: string, ai: ContentAi | null, lines: LeftoverSegment[], client: Candidate | null, rules: ConversationResult): Promise<ConversationResult> {
  if (!ai) return rules;
  try {
    const s = await scrubForAi(deps, providerId, ai, lines, client ? [{ clientRef: client.clientRef, goals: client.goals }] : []);
    const res = await ai.provider.generateStructured(buildConversationRequest(s.lines, s.candidates[0]?.goals ?? []));
    return combineConversation(rules, validateConversationOutput(res.output));
  } catch (err) {
    log("warn", "recording.conversation_ai_failed", { errorName: err instanceof Error ? err.name : "unknown" });
    return rules;
  }
}

/** Classifies one (recording, event) session block and stores it. Used by pass 2 and by accept. */
export async function classifyEventBlock(
  deps: ContentDeps,
  o: { row: RecordingRow; eventId: string; appointmentId: string; clientRef: string; eventTitle: string | null; ai?: ContentAi | null },
): Promise<void> {
  const id = o.row.recording.id;
  const providerId = o.row.recording.providerId;
  const [segments, assignments] = await Promise.all([deps.store.capture.listSegments(id), deps.store.listAssignments(id)]);
  const mine = new Set(assignments.filter((a) => a.status === "assigned" && a.eventId === o.eventId).map((a) => a.index));
  const lines = segments.filter((s) => mine.has(s.index) && s.text).map((s) => ({ index: s.index, observedFrom: s.observedFrom, observedTo: s.observedTo, speaker: s.speaker, text: s.text }));
  if (lines.length === 0) return;
  const client = await candidateFactory(deps, providerId).candidateFor(o.clientRef, []);
  const rules = classifyConversation({ lines, client, eventTitle: o.eventTitle });
  const final = await aiConversation(deps, providerId, o.ai ?? null, lines, client, rules);
  await deps.store.saveConversation({
    recordingId: id,
    scopeKey: `event:${o.eventId}`,
    providerId,
    appointmentId: o.appointmentId,
    segmentCount: lines.length,
    conversationType: final.conversationType,
    confidence: final.confidence,
    method: final.method,
    signals: final.signals,
    updatedAt: deps.clock.now().toISOString(),
  });
}

export interface SessionBlockRef {
  eventId: string;
  appointmentId: string;
  clientRef: string;
  eventTitle: string | null;
}

/**
 * Conversation type of EVERY pass 1 session block, stored (recording_conversations, scope
 * event:<id>) BEFORE the sessions are handed off, so the drafter's visit context always reads it
 * (never a race with the content pass). Rules always; the AI refines within its block budget.
 * Never throws for data problems.
 */
export async function classifySessionBlocks(
  deps: ContentDeps,
  recordingId: string,
  providerId: string,
  blocks: SessionBlockRef[],
): Promise<{ classified: number; aiCalls: number }> {
  const row = await deps.store.get(providerId, recordingId);
  if (!row || blocks.length === 0) return { classified: 0, aiCalls: 0 };
  let ai: ContentAi | null = null;
  try {
    ai = (await deps.resolveAi?.(providerId)) ?? null;
  } catch {
    ai = null;
  }
  let aiCalls = 0;
  let classified = 0;
  for (const b of blocks) {
    const a = ai && aiCalls < CONTENT_RULES.MAX_AI_BLOCKS ? ai : null;
    if (a) aiCalls++;
    try {
      await classifyEventBlock(deps, { row, ...b, ai: a });
      classified++;
    } catch (err) {
      log("warn", "recording.session_conversation_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { classified, aiCalls };
}

interface Scored {
  block: Block;
  decision: RulesDecision;
  candidates: Candidate[];
}

/**
 * Pass 2 for one partitioned recording: suggestions + conversation types of the suggestion
 * blocks. Session blocks are classified by classifySessionBlocks before the hand-off (pass the
 * result as `sessions`); without it, they are classified here. Never throws for data problems.
 */
export async function runContentPass(
  deps: ContentDeps,
  recordingId: string,
  providerId: string,
  opts: { sessions?: { classified: number; aiCalls: number } } = {},
): Promise<{ suggestions: number; aiCalls: number; sessionsClassified: number }> {
  const R = CONTENT_RULES;
  const row = await deps.store.get(providerId, recordingId);
  if (!row) return { suggestions: 0, aiCalls: 0, sessionsClassified: 0 };
  const [segments, assignments, existing, handoffs] = await Promise.all([
    deps.store.capture.listSegments(recordingId),
    deps.store.listAssignments(recordingId),
    deps.store.listSuggestions(recordingId),
    deps.store.listHandoffs(recordingId),
  ]);
  if (segments.length === 0) return { suggestions: 0, aiCalls: 0, sessionsClassified: 0 };
  const now = deps.clock.now();
  const fromMs = Math.min(...segments.map((s) => Date.parse(s.observedFrom)));
  const toMs = Math.max(...segments.map((s) => Date.parse(s.observedTo)));

  let events: CalendarEvent[] = [];
  if (deps.calendar) {
    try {
      events = (await deps.calendar.listEvents(providerId, new Date(fromMs - R.CANDIDATE_WINDOW_MS), new Date(toMs + R.CANDIDATE_WINDOW_MS))).filter(
        (e) => e.providerId === providerId && e.status !== "cancelled",
      );
    } catch (err) {
      log("warn", "recording.content_calendar_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" });
    }
  }
  const tz = row.timezone ?? events[0]?.timezone ?? "UTC";
  let ai: ContentAi | null = null;
  try {
    ai = (await deps.resolveAi?.(providerId)) ?? null;
  } catch {
    ai = null;
  }
  let aiCalls = opts.sessions?.aiCalls ?? 0;
  const aiBudget = () => (ai && aiCalls < R.MAX_AI_BLOCKS ? ai : null);
  const f = candidateFactory(deps, providerId);

  // ---- conversation type of each pass 1 (or accepted) session block
  let sessionsClassified = opts.sessions?.classified ?? 0;
  const titles = new Map(events.map((e) => [e.eventId, e.title]));
  for (const h of opts.sessions ? [] : handoffs) {
    const a = aiBudget();
    if (a) aiCalls++;
    await classifyEventBlock(deps, { row, eventId: h.eventId, appointmentId: h.appointmentId, clientRef: h.clientRef, eventTitle: titles.get(h.eventId) ?? null, ai: a });
    sessionsClassified++;
  }

  // ---- leftover → blocks
  const covered = new Set(existing.flatMap((s) => s.segmentIndexes));
  const leftoverIdx = new Set(assignments.filter((a) => (a.status === "unassigned" || a.status === "ambiguous") && !covered.has(a.index)).map((a) => a.index));
  const leftover: LeftoverSegment[] = segments
    .filter((s) => leftoverIdx.has(s.index) && s.text.trim())
    .map((s) => ({ index: s.index, observedFrom: s.observedFrom, observedTo: s.observedTo, speaker: s.speaker, text: s.text }));
  if (leftover.length === 0) return { suggestions: 0, aiCalls, sessionsClassified };

  // Caseload fallback: active clients ∪ calendar clients of ± 7 days, with Drive context, cap 8.
  let caseload: string[] | null = null;
  const caseloadRefs = async (): Promise<string[]> => {
    if (caseload) return caseload;
    const refs = new Set<string>((await deps.listClientRefs?.(providerId).catch(() => [])) ?? []);
    if (deps.calendar) {
      const around = await deps.calendar.listEvents(providerId, new Date(fromMs - 7 * DAY_MS), new Date(toMs + 7 * DAY_MS)).catch(() => []);
      for (const e of around) if (e.providerId === providerId) refs.add(e.clientRef);
    }
    const ok: string[] = [];
    for (const r of [...refs].sort()) if (await f.ctxFor(r)) ok.push(r);
    caseload = ok.slice(0, R.CASELOAD_CAP);
    return caseload;
  };

  const decide = async (block: Block): Promise<Scored> => {
    const day = localDate(block.fromMs, tz);
    const near = events.filter(
      (e) => Date.parse(e.startAt) < block.toMs + R.CANDIDATE_WINDOW_MS && Date.parse(e.endAt) > block.fromMs - R.CANDIDATE_WINDOW_MS && (localDate(Date.parse(e.startAt), tz) === day || localDate(Date.parse(e.endAt) - 1, tz) === day),
    );
    const byClient = new Map<string, CalendarEvent[]>();
    for (const e of near) byClient.set(e.clientRef, [...(byClient.get(e.clientRef) ?? []), e]);
    const cal: Candidate[] = [];
    for (const [ref, evs] of [...byClient].sort((a, b) => a[0].localeCompare(b[0]))) {
      const c = await f.candidateFor(ref, evs);
      if (c) cal.push(c);
    }
    let candidates = cal;
    let decision = scoreBlock(block, cal);
    if (!decision.clientRef) {
      // No calendar candidate matched (or none exist): widen to the caseload (calendar ones keep their events).
      const extra: Candidate[] = [];
      for (const ref of await caseloadRefs()) {
        if (cal.some((c) => c.clientRef === ref)) continue;
        const c = await f.candidateFor(ref, []);
        if (c) extra.push(c);
      }
      if (extra.length) {
        const wide = [...cal, ...extra].slice(0, Math.max(R.CASELOAD_CAP, cal.length));
        const d2 = scoreBlock(block, wide);
        if (d2.clientRef || cal.length === 0) {
          decision = d2;
          candidates = wide;
        }
      }
    }
    return { block, decision, candidates };
  };

  const firstPass: Scored[] = [];
  for (const b of detectBlocks(leftover)) firstPass.push(await decide(b));
  // Re-merge soft-split neighbours with the same outcome (rescored synchronously from their candidates).
  const merged = mergeSameOutcome(firstPass, (b) => {
    const pool = new Map<string, Candidate>();
    for (const x of firstPass) for (const c of x.candidates) if (!pool.has(c.clientRef)) pool.set(c.clientRef, c);
    const cands = [...pool.values()];
    return { block: b, decision: scoreBlock(b, cands), candidates: cands };
  });

  const rows: SuggestionRow[] = [];
  const conversations: { id: string; result: ConversationResult; count: number }[] = [];
  for (const s of merged) {
    const idx = s.block.segments.map((x) => x.index).sort((a, b) => a - b);
    let aiPick = null;
    const a = aiBudget();
    if (a && s.candidates.length > 0) {
      aiCalls++;
      try {
        const scrubbed = await scrubForAi(deps, providerId, a, s.block.segments, s.candidates.map((c) => ({ clientRef: c.clientRef, goals: c.goals })));
        const res = await a.provider.generateStructured(buildAiRequest(scrubbed.lines, scrubbed.candidates));
        aiPick = validateAiOutput(res.output, s.candidates.map((c) => c.clientRef), idx);
        if (!aiPick) log("warn", "recording.suggestion_ai_invalid", { recordingId, segments: idx.length });
      } catch (err) {
        log("warn", "recording.suggestion_ai_failed", { recordingId, errorName: err instanceof Error ? err.name : "unknown" });
      }
    }
    const final = combine(s.decision, aiPick);
    const id = await suggestionIdFor(recordingId, idx);
    rows.push({
      id,
      recordingId,
      providerId,
      segmentIndexes: idx,
      from: new Date(s.block.fromMs).toISOString(),
      to: new Date(s.block.toMs).toISOString(),
      suggestedClientRef: final.clientRef,
      eventId: final.clientRef ? final.eventId : null,
      kind: final.clientRef && final.eventId ? "event" : "unscheduled",
      confidence: final.confidence,
      method: final.method,
      rationale: composeRationale(final, s.decision, s.block),
      candidateClientRefs: s.candidates.map((c) => c.clientRef).slice(0, 20),
      status: "pending",
      createdAt: now.toISOString(),
      decidedAt: null,
      acceptedClientRef: null,
      appointmentId: null,
      sessionId: null,
    });
    const client = final.clientRef ? (s.candidates.find((c) => c.clientRef === final.clientRef) ?? null) : null;
    const rules = classifyConversation({ lines: s.block.segments, client, eventTitle: final.eventId ? (titles.get(final.eventId) ?? null) : null });
    const ca = aiBudget();
    if (ca) aiCalls++;
    conversations.push({ id, result: await aiConversation(deps, providerId, ca, s.block.segments, client, rules), count: idx.length });
  }
  await deps.store.insertSuggestions(rows);
  for (const c of conversations) {
    await deps.store.saveConversation({
      recordingId,
      scopeKey: `suggestion:${c.id}`,
      providerId,
      appointmentId: null,
      segmentCount: c.count,
      conversationType: c.result.conversationType,
      confidence: c.result.confidence,
      method: c.result.method,
      signals: c.result.signals,
      updatedAt: now.toISOString(),
    });
  }
  log("info", "recording.content_pass", {
    recordingId,
    suggestions: rows.length,
    withClient: rows.filter((r) => r.suggestedClientRef).length,
    aiCalls,
    sessionsClassified,
  });
  return { suggestions: rows.length, aiCalls, sessionsClassified };
}

/**
 * The provider's AI for pass 2: only with EXTRACTION_MODE=live and a key for the vendor (the
 * provider's saved settings when that vendor has a key, else the env default). Else null.
 */
export function contentAiResolver(
  env: Env,
  repo: { getAiSettings(providerId: string): Promise<AiSettings | null> },
  opts: { fetch?: typeof fetch } = {},
): (providerId: string) => Promise<ContentAi | null> {
  return async (providerId) => {
    if (env.EXTRACTION_MODE !== "live") return null;
    const saved = await repo.getAiSettings(providerId).catch(() => null);
    let settings: AiSettings | null = saved && apiKeyFor(env, saved.provider) ? saved : null;
    if (!settings) {
      const d = envDefaultAiSettings(env);
      if (apiKeyFor(env, d.provider)) settings = { ...d, privacy: saved?.privacy ?? d.privacy };
    }
    return settings ? { provider: createInferenceProvider(env, settings, { fetch: opts.fetch }), privacy: settings.privacy } : null;
  };
}
