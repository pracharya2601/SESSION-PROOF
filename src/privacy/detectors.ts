/**
 * Deterministic PII detectors (regex + small lexicons; no network, no ML).
 * Each detector returns candidate spans; `resolveSpans` picks a
 * non-overlapping set (longest first, then category priority).
 */
import type { PiiType, PrivacyOptions } from "../contracts/v2";
import { FIRST_NAMES, NAME_STOPWORDS } from "./names";

export interface Span {
  start: number;
  end: number;
  type: PiiType;
  /** Lower = wins ties of equal length. */
  priority: number;
}

export interface KnownTerm {
  value: string;
  type: PiiType;
}

/** Case-alternate the first letter of each word: "my name is" -> "[Mm]y\s+[Nn]ame\s+is". */
function kw(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((w) => w.replace(/^([a-z])/, (c) => `[${c.toUpperCase()}${c}]`).replace(/\./g, "\\."))
    .join("\\s+");
}

// ------------------------------------------------------------------ contact
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

// US phone: optional +1, (555) 123-4567 / 555-123-4567 / 555.123.4567 / 555 123 4567, optional extension.
// Look-behind excludes "$", digits, ":" (clock times) and "." (decimals).
const PHONE_RE =
  /(?<![\w$:.\/-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?:\s?(?:x|ext\.?|extension)\s?\d{1,6})?(?![\w:\/-]|\.\d)/gi;
// Ten bare digits only when anchored by a phone keyword.
const PHONE_KW_RE = /\b(?:phone|cell|mobile|tel|telephone|number|call|text)(?:\s+(?:me|at|is|number|no\.?))*\s*[:#]?\s*(\+?1?\d{10})\b/gi;

// ------------------------------------------------------------------ identifiers
const SSN_RE = /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g;
const SSN_KW_RE = /\b(?:ssn|ss#|social(?:\s+security)?)(?:\s+(?:number|no\.?|#|is))*\s*[:#]?\s*(\d{9}|\d{3}\s\d{2}\s\d{4})\b/gi;

// Keyword-anchored ids. Value must be >= 5 chars and contain a digit (checked in code).
const ID_STRONG_KW = "medicaid|medicare|medi-cal|mrn|mbi|insurance|subscriber|ssi|ebt|snap";
const ID_WEAK_KW = "member|policy|account|acct|patient|case|client|record|chart|license|id";
const ID_RE = new RegExp(
  String.raw`\b(?:(?:${ID_STRONG_KW})(?:\s+(?:id|number|num|no\.?|#))?|(?:${ID_WEAK_KW})\s*(?:id|number|num|no\.?|#))\s*(?:is\s+)?[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,}[A-Za-z0-9])\b`,
  "gi",
);
const MRN_RE = /\b(?:mrn|id)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9-]{3,}[A-Za-z0-9])\b/gi;

// ------------------------------------------------------------------ addresses
const SUFFIXES = [
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "lane", "ln", "drive", "dr", "court", "ct",
  "way", "place", "pl", "terrace", "ter", "circle", "cir", "parkway", "pkwy", "highway", "hwy", "trail", "trl",
  "square", "sq", "loop", "row", "alley", "plaza",
];
const SUFFIX_ALT = SUFFIXES.map(kw).join("|");
const STREET_WORD = String.raw`(?:[A-Z][A-Za-z'-]*|\d{1,3}(?:st|nd|rd|th))`;
const UNIT = String.raw`(?:,?\s*(?:${["apt", "apartment", "unit", "suite", "ste"].map(kw).join("|")}|#)\.?\s*#?[A-Za-z0-9-]+)`;
const CITY_STATE_ZIP = String.raw`(?:,?\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2},?\s+[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?(?![A-Za-z]))`;
const ADDRESS_RE = new RegExp(
  String.raw`\b\d{1,6}[A-Za-z]?\s+(?:[NSEW]\.?\s+)?(?:${STREET_WORD}\s+){1,4}?(?:${SUFFIX_ALT})\b\.?${UNIT}?${CITY_STATE_ZIP}?`,
  "g",
);
const PO_BOX_RE = /\b(?:p\.?\s?o\.?\s+box|post\s+office\s+box)\s+\d{1,6}\b/gi;
const ZIP4_RE = /(?<![\w-])\d{5}-\d{4}(?![\w-])/g;
const ZIP_NEAR_RE = /\b(?:zip(?:\s*code)?|postal\s+code|address|live[sd]?\s+(?:at|in|on)|moved\s+to)\b[^.\n]{0,40}?(?<![\w$.-])(\d{5}(?:-\d{4})?)(?![\w.-])/gi;

// ------------------------------------------------------------------ dates
const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE_NUMERIC_RE = /(?<![\w\/.:-])(?:0?[1-9]|1[0-2])([\/.-])(?:0?[1-9]|[12]\d|3[01])\1(?:\d{4}|\d{2})(?![\w\/:-]|\.\d)/g;
const DATE_ISO_RE = /(?<![\w\/.-])(?:19|20)\d{2}([\/.-])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])(?![\d\/-])/g;
const DATE_TEXT_RE = new RegExp(
  String.raw`\b(?:(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS})\.?,?\s+\d{4})\b`,
  "gi",
);
const DOB_RE = new RegExp(
  String.raw`\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date|birthday(?:\s+is)?|born(?:\s+on)?)\s*[:\-]?\s*((?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS})(?:,?\s+\d{4})?|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)`,
  "gi",
);

// ------------------------------------------------------------------ names
const CAP = String.raw`[A-Z][a-z]+(?:['-][A-Za-z][a-z]+)?`;
const HONORIFIC_RE = new RegExp(String.raw`\b(?:Mr|Mrs|Ms|Mx|Miss|Dr|Prof)\.?\s+(${CAP}(?:\s+${CAP})?)`, "g");
const INTRO_SINGLE_RE = new RegExp(String.raw`\b(?:${["my name is", "my name's", "name is", "i am called", "named", "call me"].map(kw).join("|")})\s+(${CAP}(?:\s+${CAP}){0,2})`, "g");
const INTRO_PAIR_RE = new RegExp(
  String.raw`\b(?:${["this is", "i am", "i'm", "it's", "call", "called", "with", "from", "meet", "met", "ask for", "spoke to", "spoke with", "talked to", "talk to", "speak to", "for"].map(kw).join("|")})\s+(${CAP}\s+${CAP}(?:\s+${CAP})?)`,
  "g",
);
const BIGRAM_RE = new RegExp(String.raw`\b(${CAP})(?=\s+(${CAP})\b)`, "g");

function isStop(word: string): boolean {
  return NAME_STOPWORDS.has(word.toLowerCase());
}
function namePartsOk(name: string): boolean {
  const parts = name.split(/\s+/);
  return parts.length > 0 && parts.every((p) => !isStop(p.replace(/'s$/, "")));
}

// ------------------------------------------------------------------ helpers
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Push the span of capture group 1 (or whole match when group absent). */
function pushGroup(out: Span[], m: RegExpExecArray, type: PiiType, priority: number, group = 1): void {
  const g = m[group];
  if (g === undefined) {
    out.push({ start: m.index, end: m.index + m[0].length, type, priority });
    return;
  }
  const offset = m[0].lastIndexOf(g);
  const start = m.index + offset;
  out.push({ start, end: start + g.length, type, priority });
}

function scan(re: RegExp, text: string, fn: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) re.lastIndex++;
    fn(m);
  }
}

const PRIORITY: Record<PiiType, number> = {
  CLIENT_REF: 0,
  EMAIL: 1,
  SSN: 2,
  ID: 3,
  PHONE: 4,
  ADDRESS: 5,
  DATE: 6,
  NAME: 7,
};

/** Compiled known-term matcher (whole word, case-insensitive, longest first). */
export interface TermMatcher {
  re: RegExp | null;
  types: Map<string, PiiType>;
}
export function compileTerms(terms: KnownTerm[]): TermMatcher {
  const types = new Map<string, PiiType>();
  for (const t of terms) {
    const v = t.value.trim().replace(/\s+/g, " ");
    if (v.length < 2) continue;
    const k = v.toLowerCase();
    if (!types.has(k)) types.set(k, t.type);
  }
  if (types.size === 0) return { re: null, types };
  const alts = [...types.keys()].sort((a, b) => b.length - a.length).map((v) => escapeRe(v).replace(/ /g, "\\s+"));
  return { re: new RegExp(String.raw`(?<![\p{L}\p{N}_]|[\p{L}\p{N}][.@])(?:${alts.join("|")})(?![\p{L}\p{N}_]|-\p{N}|[.@][\p{L}\p{N}])`, "giu"), types };
}

export function detectSpans(text: string, options: PrivacyOptions, terms: TermMatcher[], termPriority: number[]): Span[] {
  const out: Span[] = [];
  terms.forEach((tm, i) => {
    if (!tm.re) return;
    scan(tm.re, text, (m) => {
      const type = tm.types.get(m[0].toLowerCase().replace(/\s+/g, " "));
      if (type) out.push({ start: m.index, end: m.index + m[0].length, type, priority: termPriority[i] ?? PRIORITY[type] });
    });
  });

  if (options.redactContact) {
    scan(EMAIL_RE, text, (m) => pushGroup(out, m, "EMAIL", PRIORITY.EMAIL, 99));
    scan(PHONE_RE, text, (m) => pushGroup(out, m, "PHONE", PRIORITY.PHONE, 99));
    scan(PHONE_KW_RE, text, (m) => pushGroup(out, m, "PHONE", PRIORITY.PHONE));
  }
  if (options.redactIdentifiers) {
    scan(SSN_RE, text, (m) => pushGroup(out, m, "SSN", PRIORITY.SSN, 99));
    scan(SSN_KW_RE, text, (m) => pushGroup(out, m, "SSN", PRIORITY.SSN));
    const idFn = (m: RegExpExecArray) => {
      if (/\d/.test(m[1] ?? "")) pushGroup(out, m, "ID", PRIORITY.ID);
    };
    scan(ID_RE, text, idFn);
    scan(MRN_RE, text, idFn);
  }
  if (options.redactAddresses) {
    scan(ADDRESS_RE, text, (m) => pushGroup(out, m, "ADDRESS", PRIORITY.ADDRESS, 99));
    scan(PO_BOX_RE, text, (m) => pushGroup(out, m, "ADDRESS", PRIORITY.ADDRESS, 99));
    scan(ZIP4_RE, text, (m) => pushGroup(out, m, "ADDRESS", PRIORITY.ADDRESS, 99));
    scan(ZIP_NEAR_RE, text, (m) => pushGroup(out, m, "ADDRESS", PRIORITY.ADDRESS));
  }
  if (options.redactDates) {
    scan(DATE_NUMERIC_RE, text, (m) => pushGroup(out, m, "DATE", PRIORITY.DATE, 99));
    scan(DATE_ISO_RE, text, (m) => pushGroup(out, m, "DATE", PRIORITY.DATE, 99));
    scan(DATE_TEXT_RE, text, (m) => pushGroup(out, m, "DATE", PRIORITY.DATE, 99));
    scan(DOB_RE, text, (m) => pushGroup(out, m, "DATE", PRIORITY.DATE));
  }
  if (options.redactNames) {
    const nameFn = (m: RegExpExecArray) => {
      if (m[1] && namePartsOk(m[1])) pushGroup(out, m, "NAME", PRIORITY.NAME);
    };
    scan(HONORIFIC_RE, text, nameFn);
    scan(INTRO_SINGLE_RE, text, nameFn);
    scan(INTRO_PAIR_RE, text, nameFn);
    scan(BIGRAM_RE, text, (m) => {
      const first = m[1] ?? "";
      const second = m[2] ?? "";
      if (!FIRST_NAMES.has(first.toLowerCase()) || isStop(second)) return;
      const end = text.indexOf(second, m.index + first.length) + second.length;
      out.push({ start: m.index, end, type: "NAME", priority: PRIORITY.NAME });
    });
  }
  return resolveSpans(out);
}

/** Non-overlapping selection: longest first, then priority; returned sorted by start. */
export function resolveSpans(spans: Span[]): Span[] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.priority - b.priority || a.start - b.start);
  const taken: Span[] = [];
  for (const s of sorted) {
    if (taken.every((t) => s.end <= t.start || s.start >= t.end)) taken.push(s);
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** Split a detected full name into derived single-word terms worth propagating ("Jane Doe" -> Jane, Doe). */
export function nameParts(name: string): string[] {
  return name
    .split(/\s+/)
    .map((p) => p.replace(/'s$/i, ""))
    .filter((p) => p.length >= 3 && !isStop(p));
}
