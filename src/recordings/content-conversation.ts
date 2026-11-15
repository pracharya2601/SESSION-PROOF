/**
 * Conversation type of a block of transcript (pass 1 session blocks and pass 2 suggestion
 * blocks): is this really a client session, or a colleague / supervisor meeting, a guardian or
 * family call, a phone call, or personal talk? Deterministic rules first (pure, below); an AI
 * provider may then classify the scrubbed text among the same labels (strictly validated) and
 * the two are combined like content suggestions (content.ts `combine`).
 *
 * Signals are counts and booleans only: never transcript text, names or client refs.
 * Nothing is ever deleted or dismissed automatically: a non-client type with confidence ≥ 0.6
 * only flags the session for the provider (VisitContext.conversationNeedsConfirmation).
 */
import type { InferenceRequest } from "../contracts";
import { scoreBlock, type AiLine, type Candidate } from "./content";

import { ConversationType } from "../contracts";

export const CONVERSATION_TYPES = ConversationType.options;

/** A non-client type at or above this confidence needs the provider's confirmation (blocking checklist item). */
export const CONVERSATION_FLAG_CONFIDENCE = 0.6;

export const CONVERSATION_LABELS: Record<ConversationType, string> = {
  client_session: "client session",
  colleague_meeting: "colleague meeting",
  guardian_or_family: "guardian or family conversation",
  phone_call: "phone call",
  personal: "personal conversation",
  unclear: "unclear",
};

export interface ConversationSignals {
  speakers: number;
  /** A participant-like voice: questions directed at someone answered with first-person practice. */
  participantVoice: boolean;
  /** Distinct client goal / plan terms matched (0 when no Drive context). */
  planTermHits: number;
  workTermHits: number;
  /** Count of OTHER client refs mentioned (the refs themselves are never stored). */
  otherClientRefs: number;
  familyTermHits: number;
  phoneCues: number;
  personalTermHits: number;
  /**
   * Lines that talk ABOUT the participant (their name in the third person or possessive:
   * "Sam's", "is Sam okay", "tell Sam"), not to them ("Okay Sam, …", "See you, Sam."). 0 without
   * known name parts.
   */
  participantMentions: number;
  /** Family-relation cues: "Sam's mom", "as the guardian", "your son", "it's Maria, his mother". */
  relationCues: number;
  /** Hint from the calendar event title ("meeting", "call", …) or null. */
  eventTitleHint: "meeting" | "call" | "family" | null;
}

export interface ConversationResult {
  conversationType: ConversationType;
  confidence: number;
  method: "rules" | "ai+rules";
  signals: ConversationSignals;
}

export interface ConversationInput {
  lines: { index: number; speaker: string | null; text: string }[];
  /** The client the block is (or would be) assigned to, with Drive context; null when none. */
  client: Candidate | null;
  /** The calendar event title, when the block belongs to an event. */
  eventTitle?: string | null;
}

const WORK = [
  "caseload", "supervisor", "supervision", "billing", "invoice", "invoices", "timesheet", "timesheets", "payroll", "staff", "staffing",
  "meeting", "agenda", "team", "coworker", "colleague", "manager", "intake", "mileage", "audit", "compliance", "paperwork", "documentation",
  "shift", "coverage", "referral", "referrals", "case", "cases", "office",
];
const FAMILY = ["mom", "mother", "dad", "father", "guardian", "conservator", "sister", "brother", "aunt", "uncle", "grandma", "grandmother", "grandpa", "grandfather", "family", "parent", "parents", "son", "daughter", "husband", "wife"];
const PERSONAL = ["weekend", "vacation", "holiday", "movie", "movies", "dinner", "boyfriend", "girlfriend", "kids", "birthday", "party", "concert", "game", "netflix", "date", "lunch", "gym", "traffic", "weather"];
const PHONE = [
  /\bhello,? this is\b/i,
  /\bhi,? this is\b/i,
  /^\s*(?:hi|hello|hey)[,!]?\s+it'?s\s+\S+/i,
  /\b(?:i'?m|am|is|are|was|were)\s+(?:\w+\s+){0,4}calling\b/i,
  /\bis\s+(?:now|this)\s+a\s+(?:good|bad|ok(?:ay)?)\s+time\b/i,
  /\bbye\s+now\b/i, /\bcall(?:ing)? you back\b/i, /\bvoicemail\b/i, /\bcan you hear me\b/i, /\bon the phone\b/i, /\bthanks for calling\b/i, /\bspeaking\.?$/i];
const RELATION = "mom|mum|mother|dad|father|guardian|conservator|grandma|grandmother|grandpa|grandfather|aunt|uncle|sister|brother|parent|stepmom|stepdad|caregiver";
const RELATION_RES = [
  // "Sam's mom", "his mother", "their guardian"
  new RegExp(`\\b(?:[\\p{L}]+['’]s|his|her|their)\\s+(?:${RELATION})\\b`, "iu"),
  // "as the guardian", "I'm the mom", "as Sam's mom" (covered above)
  new RegExp(`\\b(?:as|i'?m|i\\s+am)\\s+(?:the|a|an)\\s+(?:${RELATION})\\b`, "i"),
  // speaking to the parent about their child
  /\byour\s+(?:son|daughter|child|kid|grandson|granddaughter|nephew|niece)\b/i,
];
const CLIENT_REF_RE = /\b[A-Z]{1,3}-\d{3}(?:-[A-Z])?\b/g;

function hits(text: string, words: string[]): number {
  const t = text.toLowerCase();
  let n = 0;
  for (const w of words) if (new RegExp(`\\b${w}\\b`).test(t)) n++;
  return n;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Words before a name that make it an address ("Okay Sam,", "Hi Sam", "Thanks Sam!"). */
const VOCATIVE_BEFORE = /(?:^|[,;:—–-]|\b(?:hi|hey|hello|okay|ok|thanks|thank\s+you|bye|great|good|nice|well\s+done|good\s+job|right|yes|no|see\s+you(?:\s+\w+)?|come\s+on|alright|so))\s*$/i;

/**
 * Number of lines that talk ABOUT the participant: a name part in the possessive ("Sam's") or not
 * in an addressing position (an address is preceded by the line start / a comma / a greeting
 * AND followed by punctuation or the end of the line).
 */
export function participantMentionLines(lines: { text: string }[], nameParts: string[]): number {
  const parts = [...new Set(nameParts.filter((p) => p.length >= 3))];
  if (parts.length === 0) return 0;
  const re = new RegExp(`\\b(?:${parts.map(escapeRe).join("|")})\\b(['’]s\\b)?`, "giu");
  let n = 0;
  for (const l of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let about = false;
    while (!about && (m = re.exec(l.text)) !== null) {
      if (m[1]) {
        about = true;
        break;
      }
      const before = l.text.slice(0, m.index);
      const after = l.text.slice(m.index + m[0].length);
      const vocative = VOCATIVE_BEFORE.test(before) && /^\s*(?:[,.!?;:]|$)/.test(after);
      if (!vocative) about = true;
    }
    if (about) n++;
  }
  return n;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function conversationSignals(input: ConversationInput): ConversationSignals {
  const text = input.lines.map((l) => l.text).join("\n");
  const speakers = new Set(input.lines.map((l) => l.speaker?.trim()).filter((x): x is string => !!x)).size;
  // Participant voice: someone asks / prompts "you", someone else answers in the first person.
  const bySpeaker = new Map<string, { asks: number; firstPerson: number }>();
  for (const l of input.lines) {
    const k = l.speaker?.trim() || "?";
    const s = bySpeaker.get(k) ?? { asks: 0, firstPerson: 0 };
    if (/\byou\b|\byour\b|\blet'?s\b|\bshow me\b|\btry\b/i.test(l.text) && /\?|\blet'?s\b|\btry\b|\bshow me\b/i.test(l.text)) s.asks++;
    if (/\b(?:i|i'm|i've|i'll|my|me)\b/i.test(l.text)) s.firstPerson++;
    bySpeaker.set(k, s);
  }
  const askers = [...bySpeaker].filter(([, s]) => s.asks > 0).map(([k]) => k);
  const participantVoice = speakers >= 2 && [...bySpeaker].some(([k, s]) => s.firstPerson > 0 && askers.some((a) => a !== k));
  const ownRef = input.client?.clientRef ?? null;
  const refs = new Set((text.match(CLIENT_REF_RE) ?? []).filter((r) => r !== ownRef));
  let planTermHits = 0;
  if (input.client) {
    const d = scoreBlock({ segments: input.lines.map((l) => ({ ...l, observedFrom: "1970-01-01T00:00:00.000Z", observedTo: "1970-01-01T00:00:00.000Z" })), fromMs: 0, toMs: 0 }, [input.client]);
    planTermHits = d.scores[0]?.matchedTerms.length ?? 0;
  }
  const title = (input.eventTitle ?? "").toLowerCase();
  const eventTitleHint = /\b(meeting|supervision|staff meeting|team meeting|huddle)\b/.test(title)
    ? "meeting"
    : /\b(call|phone)\b/.test(title)
      ? "call"
      : /\b(family|guardian|parent)\b/.test(title)
        ? "family"
        : null;
  return {
    speakers,
    participantVoice,
    planTermHits,
    workTermHits: hits(text, WORK),
    otherClientRefs: refs.size,
    familyTermHits: hits(text, FAMILY),
    phoneCues: PHONE.filter((re) => input.lines.some((l) => re.test(l.text))).length,
    personalTermHits: hits(text, PERSONAL),
    participantMentions: participantMentionLines(input.lines, input.client?.nameParts ?? []),
    relationCues: input.lines.filter((l) => RELATION_RES.some((re) => re.test(l.text))).length,
    eventTitleHint,
  };
}

/** Per-label rule scores from the signals. Pure. */
export function conversationScores(s: ConversationSignals): Record<Exclude<ConversationType, "unclear">, number> {
  const plan = Math.min(1, s.planTermHits / 3);
  const about = Math.min(3, s.participantMentions ?? 0);
  const relation = Math.min(2, s.relationCues ?? 0);
  // Talking ABOUT the participant with a family relation named (often on the phone): the
  // participant is not the one in the conversation.
  const familyCall = relation > 0 || (about >= 2 && s.familyTermHits > 0);
  return {
    client_session:
      0.15 + 0.45 * plan + (s.participantVoice ? (plan > 0 ? 0.25 : 0.1) : 0) - (s.eventTitleHint === "meeting" ? 0.2 : 0) - 0.08 * about - 0.15 * relation,
    colleague_meeting: 0.12 * Math.min(4, s.workTermHits) + (s.otherClientRefs > 0 ? 0.25 : 0) + (s.eventTitleHint === "meeting" ? 0.3 : 0) - 0.15 * plan,
    guardian_or_family:
      0.15 * Math.min(3, s.familyTermHits) +
      0.25 * relation +
      (familyCall ? 0.1 * about : 0) +
      (familyCall && s.phoneCues > 0 ? 0.1 : 0) +
      (s.eventTitleHint === "family" ? 0.3 : 0) -
      0.1 * plan,
    phone_call: 0.25 * Math.min(2, s.phoneCues) + (s.speakers === 1 && s.phoneCues > 0 ? 0.2 : 0) + (s.eventTitleHint === "call" ? 0.2 : 0),
    personal: 0.12 * Math.min(4, s.personalTermHits) - 0.3 * plan - (s.workTermHits > 1 ? 0.1 : 0),
  };
}

/**
 * Deterministic classification: the best label when it scores ≥ 0.35, else "unclear".
 * confidence = clamp(0.25 + top − 0.5 · second, 0.2, 0.9).
 */
export function classifyConversation(input: ConversationInput): ConversationResult {
  const signals = conversationSignals(input);
  const ranked = (Object.entries(conversationScores(signals)) as [ConversationType, number][]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [topType, top] = ranked[0]!;
  const second = Math.max(0, ranked[1]![1]);
  if (top < 0.35) return { conversationType: "unclear", confidence: round2(clamp(0.6 - top, 0.2, 0.6)), method: "rules", signals };
  return { conversationType: topType, confidence: round2(clamp(0.25 + top - 0.5 * second, 0.2, 0.9)), method: "rules", signals };
}

// ------------------------------------------------------------------ AI
export const CONVERSATION_TOOL = {
  name: "classify_conversation",
  description: "Classify what kind of conversation this transcript block is.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["conversationType", "confidence"],
    properties: {
      conversationType: { type: "string", enum: [...CONVERSATION_TYPES] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;

const SYSTEM = [
  "A home-and-community-services provider records visits with clients. Classify one block of de-identified transcript lines ([NAME_1]-style tokens replace personal data).",
  "client_session: the provider working with the client on their goals. colleague_meeting: talk with a colleague or supervisor (caseload, schedules, billing, other clients).",
  "guardian_or_family: talk with the client's guardian or family about the client. phone_call: one side of a phone call. personal: personal small talk unrelated to services. unclear: cannot tell.",
  "Answer only with the tool.",
].join(" ");

export function buildConversationRequest(lines: AiLine[], goals: { goalId: string; objective: string }[]): InferenceRequest {
  const user = JSON.stringify({
    block: lines.map((l) => ({ i: l.index, speaker: l.speaker, text: l.text.slice(0, 1000) })),
    clientGoals: goals.map((g) => ({ goalId: g.goalId, objective: g.objective.slice(0, 300) })),
  });
  return { system: SYSTEM, user, tool: { ...CONVERSATION_TOOL, inputSchema: CONVERSATION_TOOL.inputSchema as unknown as Record<string, unknown> }, maxTokens: 100 };
}

/** Strict: exactly {conversationType, confidence}, a known label, confidence in [0, 1]. */
export function validateConversationOutput(out: unknown): { conversationType: ConversationType; confidence: number } | null {
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  const o = out as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "confidence,conversationType") return null;
  if (typeof o.conversationType !== "string" || !(CONVERSATION_TYPES as readonly string[]).includes(o.conversationType)) return null;
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  return { conversationType: o.conversationType as ConversationType, confidence: o.confidence };
}

export function combineConversation(rules: ConversationResult, ai: { conversationType: ConversationType; confidence: number } | null): ConversationResult {
  if (!ai) return rules;
  if (ai.conversationType === rules.conversationType) {
    return { ...rules, confidence: round2(Math.min(0.95, (rules.confidence + ai.confidence) / 2 + 0.1)), method: "ai+rules" };
  }
  const pick = ai.confidence > rules.confidence ? ai : rules;
  const nonClient = (t: ConversationType) => t !== "client_session" && t !== "unclear";
  if (nonClient(ai.conversationType) && nonClient(rules.conversationType)) {
    // Both say "not a client session" (e.g. guardian call vs phone call): that much is agreed.
    return { ...rules, conversationType: pick.conversationType, confidence: round2(Math.min(0.9, (rules.confidence + ai.confidence) / 2)), method: "ai+rules" };
  }
  return { ...rules, conversationType: pick.conversationType, confidence: round2(pick.confidence / 2), method: "ai+rules" };
}

export function needsConfirmation(a: Pick<ConversationResult, "conversationType" | "confidence"> | null): boolean {
  return !!a && a.conversationType !== "client_session" && a.conversationType !== "unclear" && a.confidence >= CONVERSATION_FLAG_CONFIDENCE;
}
