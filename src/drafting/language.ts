/**
 * Deterministic language helpers shared by the demo drafter (src/drafting/demo.ts) and the
 * CLAIM_EXCEEDS_EVIDENCE rule (src/domain/rules). Pure, no I/O. Rule-based, not AI.
 */

/**
 * Phrases that assert frequency, permanence or independence beyond one observed session.
 * A claim may only use one when a cited segment says it too (`support`, default: the same
 * pattern). Instruction-like segments never support anything; for independence/progress
 * wording, a first-person self-report ("I did it all by myself") does not either.
 * `negatable`: the phrase is not a claim when a negation precedes it ("not independently").
 */
interface GeneralisationPattern {
  label: string;
  re: RegExp;
  support?: RegExp;
  /** Self-reports by the speaker do not count as support. */
  noSelfReport?: boolean;
  negatable?: boolean;
  /**
   * Describes ONE session's performance ("independently", "without prompts"): fine when a cited
   * segment says it. Not session-scoped = frequency / permanence ("always", "every week").
   */
  sessionScoped?: boolean;
}
/**
 * "own" as an adverb ("on her own", "did it on their own and …") vs a possessive determiner
 * ("on their own card", "on her own copy"): after "own", only a clause end or one of these
 * function / time words, or a verb form (-ing / -ed: "on her own using the map"), keeps the
 * adverbial (independence) reading.
 */
const OWN_ADVERBIAL_NEXT =
  "and|or|but|then|so|too|also|again|now|today|tonight|yesterday|this|that|which|who|when|while|after|before|during|until|once|because|since|without|with|at|in|on|for|to|from|by|as|like|first|here|there|each|every|all|most|mostly|sometimes|is|was|were|are|has|had|have|will|would|could|can|did|does|do";
/** `on <possessive> own` not followed by a noun ("on their own card" is not independence). */
const onOwn = (possessives: string): string =>
  `\\bon\\s+(?:${possessives})\\s+own\\b(?!\\s*[-–]?\\s*(?!(?:${OWN_ADVERBIAL_NEXT})\\b|[a-z]+(?:ing|ed)\\b)[a-z])`;
const ON_OWN_3P = onOwn("his|her|their|your");
const INDEPENDENCE_SUPPORT = new RegExp(
  String.raw`\bindependent(?:ly)?\b|\bby\s+(?:him|her|them|your)sel(?:f|ves)\b|${ON_OWN_3P}|\bwithout\s+(?:any\s+|a\s+|an\s+)?(?:help|assistance|support|prompts?|prompting|reminders?|cues?)\b|\bunassisted\b|\balone\b`,
  "i",
);
const NO_PROMPTS_RE =
  /\bwithout\s+(?:any\s+|a\s+|an\s+)?(?:prompts?|prompting|reminders?|cues?|help|assistance)\b|\bwith\s+no\s+(?:prompts?|prompting|reminders?|cues?|help|assistance)\b|\bno\s+(?:prompts?|prompting|reminders?|cues?)\b/i;
const FEWER_PROMPTS_RE =
  /\b(?:decreasing|decreased|reduced|reducing|fewer|less(?:ening)?)\s+(?:prompts?|prompting|support|help|cues?|reminders?)\b|\bprompts?\s+(?:have\s+|has\s+)?(?:decreased|reduced)\b/i;
const ALL_GOALS_RE =
  /\bachiev(?:ed|es|ing)\s+(?:all|both|each|every|the)\b[^.;]{0,60}\bgoals?\b|\bgoals?\s+(?:were|are|have\s+been|has\s+been|was|is)\s+(?:all\s+|both\s+)?(?:achieved|met|completed|accomplished)\b|\b(?:met|reached|completed|accomplished)\s+(?:all|both)\s+(?:the\s+|of\s+the\s+|(?:his|her|their)\s+)?goals\b/i;

const GENERALISATION_PATTERNS: GeneralisationPattern[] = [
  { label: "always", re: /\balways\b/i },
  { label: "never needs", re: /\bnever\s+needs?\b/i },
  { label: "every …", re: /\bevery\s+(?:day|week|weekend|month|morning|evening|night|time|visit|session)\b/i },
  { label: "everyday", re: /\beveryday\b/i },
  { label: "each day/week", re: /\beach\s+(?:day|week|month)\b/i },
  { label: "all the time", re: /\ball\s+the\s+time\b/i },
  { label: "now independently", re: /\bnow\s+(?:fully\s+)?independent(?:ly)?\b|\bindependent(?:ly)?\s+now\b/i },
  { label: "fully independent", re: /\bfully\s+independent(?:ly)?\b|\bcompletely\s+independent(?:ly)?\b/i },
  { label: "independently", sessionScoped: true, re: /\bindependent(?:ly)?\b/i, support: INDEPENDENCE_SUPPORT, noSelfReport: true, negatable: true },
  { label: "progressed to independence", sessionScoped: true, re: /\bprogress(?:ed|ing|es)?\s+(?:to|towards?)\s+(?:being\s+)?independen\w*/i, support: INDEPENDENCE_SUPPORT, noSelfReport: true },
  {
    label: "by himself / on her own",
    sessionScoped: true,
    re: new RegExp(String.raw`\bby\s+(?:him|her|them)sel(?:f|ves)\b|${onOwn("his|her|their")}|\bunassisted\b`, "i"),
    support: INDEPENDENCE_SUPPORT,
    noSelfReport: true,
    negatable: true,
  },
  { label: "without prompts", sessionScoped: true, re: NO_PROMPTS_RE, support: new RegExp(`${NO_PROMPTS_RE.source}|${INDEPENDENCE_SUPPORT.source}`, "i"), noSelfReport: true, negatable: true },
  { label: "decreasing prompts", sessionScoped: true, re: FEWER_PROMPTS_RE, support: new RegExp(`${FEWER_PROMPTS_RE.source}|\\bdown\\s+from\\b|\\bfewer\\b`, "i"), noSelfReport: true, negatable: true },
  { label: "achieved all goals", re: ALL_GOALS_RE },
  { label: "can now", re: /\b(?:can|is\s+able\s+to|are\s+able\s+to)\s+now\b|\bnow\s+(?:can|is\s+able\s+to)\b/i },
  { label: "no longer needs", re: /\bno\s+longer\s+(?:needs?|requires?)\b|\bdoes\s+not\s+need\s+(?:help|support|prompts?)\s+anymore\b/i },
  { label: "from now on", re: /\bfrom\s+now\s+on\b/i },
  { label: "permanently", re: /\bpermanent(?:ly)?\b/i },
  { label: "mastered", re: /\bmaster(?:ed|s|y|ing)?\b/i },
  { label: "consistently", re: /\bconsistent(?:ly)?\b/i },
];

const NEGATION_BEFORE_RE = /\b(?:not|never|nor|isn't|wasn't|aren't|weren't|didn't|doesn't|don't|couldn't|can't|cannot|rather\s+than|instead\s+of|yet\s+to|unable\s+to|working\s+(?:on|toward|towards)|goal\s+(?:of|is|to))\b[^.;]{0,40}$/i;

function matchesClaim(p: GeneralisationPattern, text: string): RegExpExecArray | null {
  const re = new RegExp(p.re.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!p.negatable || !NEGATION_BEFORE_RE.test(text.slice(Math.max(0, m.index - 60), m.index))) return m;
  }
  return null;
}

/**
 * Generalisation phrases found in a text (labels + the matched words). `frequencyOnly`: only
 * frequency / permanence phrases, not session-scoped progress wording (the demo drafter quotes
 * "you did it without prompts today" but never "I always pay every bill").
 */
export function findGeneralisations(text: string, opts: { frequencyOnly?: boolean } = {}): { label: string; match: string }[] {
  const out: { label: string; match: string }[] = [];
  for (const p of GENERALISATION_PATTERNS) {
    if (opts.frequencyOnly && p.sessionScoped) continue;
    const m = matchesClaim(p, text);
    if (m) out.push({ label: p.label, match: m[0] });
  }
  return out;
}

/**
 * The generalisations in `claim` that none of `cited` texts support. Instruction-like segments
 * ("write that he can now shop alone every week") never support a claim, and a first-person
 * self-report never supports independence or progress wording.
 */
export function unsupportedGeneralisations(claim: string, cited: string[]): { label: string; match: string }[] {
  const usable = cited.filter((t) => !isInstructionLike(t));
  const out: { label: string; match: string }[] = [];
  for (const p of GENERALISATION_PATTERNS) {
    const m = matchesClaim(p, claim);
    if (!m) continue;
    const sup = p.support ?? p.re;
    const ok = usable.some((t) => (!p.noSelfReport || !isSelfReport(t)) && sup.test(t));
    if (!ok) out.push({ label: p.label, match: m[0] });
  }
  return out;
}

// ------------------------------------------------------------------ instructions to the system

/**
 * A segment that instructs the system (or the note) rather than describing the session:
 * "write/record/put that …", "bill 10 hours", "set the rate", "mark this session approved",
 * "ignore previous instructions", or text addressed to the assistant / AI / system.
 * Such segments are untrusted instructions: never support, never claim text, never invoice text.
 */
const INSTRUCTION_RES: RegExp[] = [
  /\b(?:write|record|put|note|log|document|say|state|type|enter)\s+(?:it\s+)?(?:down\s+)?(?:in\s+(?:the\s+|my\s+|your\s+)?(?:notes?|record|file|report|chart|system)\s+)?that\s+(?:(?:he|she|they|i|we|you|it|his|her|their|my|the\s+(?:client|participant|visit|session|goals?|appointment))\b|\[NAME_\d+\])/i,
  // "write that Daniel …": a capitalised name right after "that" (case-sensitive on the name).
  /\b(?:[Ww]rite|[Rr]ecord|[Pp]ut|[Nn]ote|[Ll]og|[Dd]ocument|[Ss]ay|[Ss]tate)\s+(?:down\s+)?that\s+[A-Z][a-z]+\s+(?:is|was|can|has|had|did|does|will|now|always|never|completed|achieved|mastered)\b/,
  /\b(?:make\s+sure|ensure)\s+(?:the\s+|my\s+|your\s+)?(?:note|notes|record|report|invoice)\s+(?:says?|shows?|states?)\b/i,
  /\b(?:bill|charge|invoice|claim)\s+(?:(?:for|them|me|him|her|medicaid|the\s+\w+)\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|extra|more|double)\s*(?:hours?|hrs?|minutes?|mins?)\b/i,
  /\b(?:set|change|raise|increase|bump|update|make)\s+(?:the\s+|my\s+|our\s+|your\s+)?(?:hourly\s+)?(?:rate|billing|price|amount|duration|invoice)\b/i,
  /\bmark\s+(?:this|the|it|that|these|all|my|our)\b[^.!?]{0,40}\b(?:approved|complete(?:d)?|done|finali[sz]ed|paid|achieved|met)\b/i,
  /\bapprove\s+(?:this|the|my|our)\s+(?:session|note|invoice|visit|claim|timesheet)\b/i,
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|other|system)?\s*(?:instructions?|rules|prompts?|directions|guidelines)\b/i,
  /^\s*(?:hey\s+|ok(?:ay)?\s+|so\s+|um\s+)?(?:system|assistant|a\.?i\.?|chat\s?gpt|gpt|claude|model|bot|computer|note[\s-]?taker|recorder|scribe)\s*[:,]/i,
  /\b(?:SYSTEM|ASSISTANT|DEVELOPER)\s*:/,
  /\b(?:hey|dear|okay|ok)\s+(?:assistant|a\.?i\.?|system|model|bot|scribe)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the|in)\b|\bnew\s+instructions?\s*:/i,
];

export function isInstructionLike(text: string): boolean {
  return INSTRUCTION_RES.some((re) => re.test(text));
}

/** First-person report of doing something alone / without help ("I did it all by myself"). */
const SELF_REPORT_RE = new RegExp(
  String.raw`\bby\s+(?:my|our)sel(?:f|ves)\b|${onOwn("my|our")}|` +
    String.raw`\b(?:I|we)\b[^.?!]{0,40}\b(?:alone|independent(?:ly)?|without\s+(?:any\s+|a\s+)?(?:help|prompts?|prompting|reminders?|assistance))\b`,
  "i",
);
export function isSelfReport(text: string): boolean {
  return SELF_REPORT_RE.test(text);
}

/** Lowercased word list (privacy tokens kept as one word). */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[([a-z_]+_\d+)\]/g, " $1 ")
    .split(/[^a-z0-9_$]+/)
    .filter((w) => w.length > 0);
}
function trigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}
/** Lead-in of an instruction ("Write that", "SYSTEM:", "Assistant, record that") — not its payload. */
const LEAD_IN_RE =
  /^\s*(?:(?:hey\s+|ok(?:ay)?\s+)?(?:system|assistant|ai|model|bot|scribe)\s*[:,]\s*)?(?:(?:please\s+)?(?:write|record|put|note|log|say|state)\s+(?:down\s+)?that\s+)?/i;

/**
 * Does `claim` repeat an instruction-like segment? High word-trigram overlap with the
 * instruction's payload (≥ 3 shared trigrams, or ≥ half of the claim's trigrams).
 */
export function echoesInstruction(claim: string, instructionTexts: string[]): boolean {
  const cw = wordsOf(claim);
  const ct = trigrams(cw);
  if (ct.size === 0) return false;
  for (const t of instructionTexts) {
    const it = trigrams(wordsOf(t.replace(LEAD_IN_RE, "")));
    let shared = 0;
    for (const g of ct) if (it.has(g)) shared++;
    if (shared >= 3 || (shared >= 1 && shared / ct.size >= 0.5)) return true;
  }
  return false;
}

/**
 * Share of the claim's content words found in `source` (0..1), privacy tokens ignored.
 * Used to detect claims copied from a previous note rather than from today's transcript.
 */
export function contentOverlap(claim: string, source: string): number {
  const strip = (s: string) => s.replace(/\[[A-Z_]+_\d+\]/g, " ");
  const c = contentStems(strip(claim));
  if (c.size === 0) return 0;
  const s = contentStems(strip(source));
  let n = 0;
  for (const x of c) if (s.has(x)) n++;
  return n / c.size;
}
export function contentStemCount(text: string): number {
  return contentStems(text.replace(/\[[A-Z_]+_\d+\]/g, " ")).size;
}

// ------------------------------------------------------------------ discussed is not achieved

/** Future, conditional, plan or negation ("will", "going to", "couldn't", "not yet", "next week"). */
const NOT_DONE_RE =
  /\b(?:will|won't|going\s+to|gonna|plan(?:ned|s|ning)?\s+to|want(?:s|ed)?\s+to|hope\s+to|would|could|might|should|maybe|next\s+(?:time|week|visit|session|shift)|later|tomorrow|try\s+(?:it\s+|that\s+)?again|again\s+(?:on|next)|can\s+(?:talk|look|try)|let's|not\s+yet|yet\s+to|couldn't|could\s+not|didn't|did\s+not|can't|cannot|wasn't|was\s+not|weren't|isn't|haven't|hasn't|never|unable|skip|instead|was\s+down)\b|\w'll\b|\?\s*$/i;
const NEGATED_RE = /\b(?:not|never|couldn't|could\s+not|didn't|did\s+not|can't|cannot|wasn't|weren't|haven't|hasn't|unable|yet\s+to|failed\s+to|no)\b/i;
/** A claim sentence that does not itself assert completion (it is negated, planned or partial). */
const CLAIM_HEDGE_RE =
  /\b(?:not|n't|never|no|yet\s+to|unable|plan(?:ned|s)?|will|discuss(?:ed)?|talked|attempt(?:ed)?|tried|try|retry|intend(?:s|ed)?|aim|toward|towards|working\s+on|practi[cs](?:e|ed|ing)|prepar(?:e|ed|ing)|wants?\s+to|interest(?:ed)?|considered|reviewed|looked\s+at|next)\b|\w'll\b/i;

/**
 * Planned, deferred, asked-about or negated — nothing was done ("next week we can talk about the
 * bus", "we'll do the dishes next visit", "can we skip the dishes?", "I couldn't send it").
 * Narrower than NOT_DONE_RE: "let's practise…" is session work, not a deferral.
 */
const DEFERRED_RE =
  /\b(?:will|going\s+to|gonna|plan(?:ned|s)?\s+to|next\s+(?:time|week|visit|session|shift|appointment)|try\s+(?:it\s+|that\s+)?again|again\s+(?:on|next)|can\s+talk|talk\s+about|skip|not\s+yet|yet\s+to|couldn't|could\s+not|didn't|did\s+not|can't|cannot|wasn't\s+able|unable|was\s+down)\b|\w'll\b|\?\s*$/i;
export function isDeferredOrNegated(text: string): boolean {
  return DEFERRED_RE.test(text.trim());
}

interface CompletionFamily {
  label: string;
  claim: RegExp;
  same: RegExp;
  /** strict: a cited segment must affirm the same action (rarely paraphrased outcomes). */
  strict: boolean;
}
const COMPLETION_FAMILIES: CompletionFamily[] = [
  { label: "submitted", claim: /\b(?:submitted|sent|mailed|emailed|turned\s+in|handed\s+in|filed)\b/i, same: /\b(?:submit\w*|sen[dt]\w*|mail\w*|email\w*|turn\w*\s+(?:it\s+)?in|hand\w*\s+(?:it\s+)?in|fil(?:e|ed|ing))\b/i, strict: true },
  { label: "joined", claim: /\b(?:joined|enrolled|signed\s+up|registered|became\s+a\s+member)\b/i, same: /\b(?:join\w*|enrol\w*|sign\w*\s+up|regist\w*|member\w*)\b/i, strict: true },
  { label: "hired", claim: /\b(?:was\s+hired|got\s+(?:the|a)\s+job|started\s+(?:the|a)\s+(?:new\s+)?job)\b/i, same: /\bhired\b|\bgot\s+(?:the|a)\s+job\b|\bstart\w*\s+(?:the|a|my)\s+(?:new\s+)?job\b/i, strict: true },
  { label: "completed", claim: /\b(?:completed|finished)\b/i, same: /\b(?:complet\w*|finish\w*|done)\b/i, strict: false },
  { label: "applied", claim: /\bapplied\b/i, same: /\bappl(?:y|ied|ying|ication)\b/i, strict: false },
  { label: "washed", claim: /\bwashed\b/i, same: /\bwash\w*\b/i, strict: false },
  { label: "cooked", claim: /\bcooked\b/i, same: /\bcook\w*\b/i, strict: false },
  { label: "rode", claim: /\brode\b/i, same: /\b(?:rode|ride|riding|rides)\b/i, strict: false },
  { label: "bought", claim: /\b(?:bought|purchased)\b/i, same: /\b(?:bought|buy\w*|purchas\w*)\b/i, strict: false },
  { label: "attended", claim: /\battended\b/i, same: /\battend\w*\b/i, strict: false },
  { label: "called", claim: /\b(?:called|phoned)\b/i, same: /\b(?:call\w*|phon\w*)\b/i, strict: false },
];

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Completion claims ("submitted", "joined", "completed", "washed") whose cited segments only
 * discuss, plan, negate or defer the action. Returns the matched words, or [] when fine.
 *  - a cited segment negates the same action ("I couldn't send it") → refused;
 *  - every cited segment is future / conditional / negated ("we were going to submit") → refused;
 *  - strict outcomes (submitted / joined / hired) need a cited segment that affirms the action.
 */
export function unsupportedCompletions(claim: string, cited: string[]): { label: string; match: string }[] {
  const usable = cited.filter((t) => !isInstructionLike(t));
  const citedSentences = usable.flatMap(sentencesOf);
  const out: { label: string; match: string }[] = [];
  for (const sentence of sentencesOf(claim)) {
    if (CLAIM_HEDGE_RE.test(sentence)) continue;
    for (const f of COMPLETION_FAMILIES) {
      const m = f.claim.exec(sentence);
      if (!m || out.some((o) => o.label === f.label)) continue;
      const mentions = citedSentences.filter((s) => f.same.test(s));
      const negatedSame = mentions.some((s) => NEGATED_RE.test(s) || NOT_DONE_RE.test(s));
      const affirmed = mentions.some((s) => !NEGATED_RE.test(s) && !NOT_DONE_RE.test(s));
      const allNotDone = usable.length > 0 && usable.every((t) => NOT_DONE_RE.test(t));
      if ((negatedSame && !affirmed) || (allNotDone && !affirmed) || (f.strict && !affirmed) || usable.length === 0) {
        out.push({ label: f.label, match: m[0] });
      }
    }
  }
  return out;
}

/** Explicit progress language. "Discussed" is not "achieved": only these count as progress. */
const PROGRESS_RE = new RegExp(
  String.raw`\b(?:progress|improv(?:ed|ing|ement)|better\s+than\s+(?:last|before)|first\s+time|by\s+(?:my|him|her|them)sel(?:f|ves)|without\s+(?:any\s+)?(?:help|prompts?|prompting|reminders?)|fewer\s+prompts|less\s+help|did\s+it\s+alone)\b|${onOwn("my|his|her|their")}`,
  "i",
);
export function hasProgressLanguage(text: string): boolean {
  return PROGRESS_RE.test(text);
}

const NEGATED_PROGRESS_RE = /\b(?:no|not|didn't|did\s+not|hasn't|haven't|wasn't|isn't|any)\s+(?:\w+\s+){0,2}(?:progress|improv\w*|better)\b/i;
/**
 * A segment that can establish progress: explicit progress language, NOT an instruction to the
 * system, NOT a first-person self-report ("I did it all by myself" is the participant's account,
 * not confirmed), not a question, not a plan for later, not negated ("no progress").
 */
export function isProgressEvidence(text: string): boolean {
  return (
    hasProgressLanguage(text) &&
    !isInstructionLike(text) &&
    !isSelfReport(text) &&
    !/\?\s*$/.test(text.trim()) &&
    !isFollowUpCommitment(text) &&
    !NEGATED_PROGRESS_RE.test(text)
  );
}

/** Flags computed while preparing evidence for drafting (prompt labels, rules, demo drafter). */
export interface SegmentFlags {
  instructionLike: boolean;
  selfReport: boolean;
  progress: boolean;
}
export function segmentFlags(text: string): SegmentFlags {
  return { instructionLike: isInstructionLike(text), selfReport: isSelfReport(text), progress: isProgressEvidence(text) };
}

/** Casual conversation that is not service activity (TV, weather, family news, weekend plans). */
const SMALL_TALK_RE =
  /\b(?:movie|film|tv|television|netflix|youtube|show\s+last\s+night|weather|rain(?:ing|ed)?|sunny|weekend|vacation|holiday|birthday|party|cousin|football|soccer|basketball|baseball|video\s+games?|song|music|concert|pet|dog|cat|puppy|kitten)\b/i;
export function isSmallTalk(text: string): boolean {
  return SMALL_TALK_RE.test(text);
}

/** A commitment about a future visit or action ("next time I will…", "we'll call…"). */
const FOLLOW_UP_STRONG = /\b(?:next\s+(?:time|visit|week|session|meeting|appointment)|follow[\s-]?up|before\s+(?:our|the)\s+next|at\s+our\s+next)\b/i;
const FUTURE_RE = /\b(?:I\s+will|I'll|we\s+will|we'll|you\s+will|you'll|going\s+to|plan\s+to)\b/i;
const FUTURE_TIME_RE = /\b(?:tomorrow|later|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|bring|call|schedule|book)\b/i;
export function isFollowUpCommitment(text: string): boolean {
  return FOLLOW_UP_STRONG.test(text) || (FUTURE_RE.test(text) && FUTURE_TIME_RE.test(text));
}

/** First-person past action, i.e. something the speaker reports having done in the session. */
const OBSERVATION_RE =
  /\b(?:I|we)\s+(?:just\s+)?(?:(?!need\b|feed\b|proceed\b|succeed\b)\w+ed|did|made|chose|found|picked|got|wrote|took|went|put|paid|bought|cooked|cleaned|finished|remembered|counted|read|set|folded|washed)\b/i;
export function isObservation(text: string): boolean {
  return OBSERVATION_RE.test(text);
}

/** Sentences of an excerpt (keeps the terminal punctuation). */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STOP = new Set(
  (
    "a an the and or but if of to in on at by for from with into onto over under about as is are was were be been being am " +
    "it its this that these those there here then than so too very just also not no yes ok okay right well now today " +
    "i me my we us our you your he him his she her they them their what which who whom how when where why " +
    "do does did done doing have has had having will would can could should may might must shall let lets let's " +
    "up down out off again more less most some any each per all both few other own same such only one two three " +
    // generic plan words that carry no topic on their own
    "plan plans simple weekly week daily day keep keeps date personal complete completes independently independent " +
    "decreasing increasing prompts prompt support supports skill skills goal goals able use using practice manage maintain " +
    "improve develop participant client time times new together thing things get got go going good great sure " +
    "hello thanks thank fine bit feel feeling how"
  ).split(/\s+/),
);

/** Crude deterministic stem: lowercase, strip common suffixes, collapse a doubled final consonant. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && /([bcdfghjklmnpqrstvwxz])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** Content-word stems of a text (no stop words, ≥ 3 letters). */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z']+/)) {
    const lw = raw.toLowerCase().replace(/'s$/, "");
    if (lw.length < 3 || STOP.has(lw)) continue;
    const s = stem(lw);
    if (s.length >= 3 && !STOP.has(s)) out.add(s);
  }
  return out;
}

/**
 * Small topic clusters: a goal keyword in a cluster also matches the cluster's other words
 * ("meal" matches "cook", "pasta", "shopping list"). Deterministic, visible, editable.
 */
const CLUSTERS: string[][] = [
  ["meal", "cook", "food", "recipe", "pasta", "soup", "dinner", "lunch", "breakfast", "kitchen", "grocery", "groceries", "cupboard", "ingredient", "menu", "prepare"],
  ["laundry", "wash", "washing", "clothes", "dryer", "detergent", "setting", "fold", "load", "machine"],
  ["schedule", "calendar", "appointment", "planner", "diary", "reminder"],
  ["budget", "money", "spend", "receipt", "bank", "cash", "price", "cost", "pay", "change", "dollar"],
  ["bus", "transit", "route", "fare", "ride", "stop", "train", "travel"],
  ["job", "work", "resume", "interview", "shift", "employer", "application", "apply"],
  ["shop", "store", "list", "aisle", "checkout", "cart"],
  ["medication", "medicine", "pill", "pharmacy", "dose", "prescription"],
  ["clean", "tidy", "vacuum", "dishes", "sweep", "trash"],
  ["community", "library", "park", "class", "club", "volunteer", "center"],
  ["phone", "call", "text", "message", "email"],
];
const CLUSTER_STEMS = CLUSTERS.map((c) => new Set(c.map(stem)));

/** Goal keyword stems from its objective (and id), expanded through the topic clusters. */
export function goalStems(goalId: string, objective: string): Set<string> {
  const base = contentStems(`${objective} ${goalId.replace(/^goal[_-]?/i, "").replace(/[_-]+/g, " ")}`);
  const out = new Set(base);
  for (const cluster of CLUSTER_STEMS) {
    if ([...base].some((s) => cluster.has(s))) for (const s of cluster) out.add(s);
  }
  return out;
}
