/**
 * PII privacy controller (V3). Runs before ANY text reaches an inference
 * provider: replaces PII in evidence excerpts with stable tokens ([NAME_1],
 * [PHONE_1]…) and returns closures that restore tokens in model output.
 * Deterministic, synchronous, no network. The vault never leaves the closures.
 */
import type { Appointment, EvidenceItem, SessionFacts } from "../contracts/schemas";
import type {
  PiiType,
  PreparedEvidence,
  PrivacyContext,
  PrivacyController,
  PrivacyOptions,
  PrivacyReport,
} from "../contracts/v2";
import { compileTerms, detectSpans, nameParts, resolveSpans, type KnownTerm, type Span, type TermMatcher } from "./detectors";
import { ROLE_SPEAKERS } from "./names";
import { PrivacyVault } from "./vault";

export { PrivacyVault } from "./vault";

const KNOWN_PRIORITY = -1; // explicit context terms beat detectors on equal length
const DERIVED_PRIORITY = 7; // propagated name parts rank like NAME

/** Fields in SessionFacts that are identifiers/enums, never restored. */
const NON_TEXT_KEYS = new Set(["id", "evidenceIds", "goalId", "providerAttestationId", "support", "status"]);

const SPEAKER_NAME_RE = /^[A-Z][a-z]+(?:['-][A-Za-z][a-z]+)?(?:\s+[A-Z]\.?|\s+[A-Z][a-z]+(?:['-][A-Za-z][a-z]+)?){0,2}$/;

function looksLikePersonName(speaker: string): boolean {
  const s = speaker.trim();
  if (!SPEAKER_NAME_RE.test(s)) return false;
  return !s.split(/\s+/).some((w) => ROLE_SPEAKERS.has(w.toLowerCase().replace(/\.$/, "")));
}

function applySpans(text: string, spans: Span[], vault: PrivacyVault, findings: Partial<Record<PiiType, number>>): string {
  if (spans.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + vault.tokenFor(s.type, text.slice(s.start, s.end));
    findings[s.type] = (findings[s.type] ?? 0) + 1;
    pos = s.end;
  }
  return out + text.slice(pos);
}

function makeReport(findings: Partial<Record<PiiType, number>>): PrivacyReport {
  return { scrubbed: Object.values(findings).some((n) => (n ?? 0) > 0), findings: { ...findings } };
}

function deepRestore(value: unknown, restore: (s: string) => string): unknown {
  if (typeof value === "string") return restore(value);
  if (Array.isArray(value)) return value.map((v) => deepRestore(v, restore));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = NON_TEXT_KEYS.has(k) ? v : deepRestore(v, restore);
    }
    return out;
  }
  return value;
}

/**
 * Core engine shared by prepare() and scrubText(): two passes so a name found
 * anywhere (e.g. "Jane Doe" or a named speaker) is also redacted where it
 * appears alone ("Jane said…") in every other text.
 */
function scrubMany(
  texts: string[],
  speakers: (string | null)[],
  ctx: PrivacyContext,
): { texts: string[]; speakers: (string | null)[]; vault: PrivacyVault; findings: Partial<Record<PiiType, number>> } {
  const options: PrivacyOptions = ctx.options;
  const known = compileTerms(ctx.knownTerms as KnownTerm[]);
  const vault = new PrivacyVault();
  const findings: Partial<Record<PiiType, number>> = {};

  // Pass 1: detect everywhere, collect names for propagation.
  const spans1 = texts.map((t) => detectSpans(t, options, [known], [KNOWN_PRIORITY]));
  const derived: KnownTerm[] = [];
  const seen = new Set<string>();
  const addName = (name: string) => {
    for (const v of [name, ...nameParts(name)]) {
      const k = v.toLowerCase();
      if (!seen.has(k) && !known.types.has(k)) {
        seen.add(k);
        derived.push({ value: v, type: "NAME" });
      }
    }
  };
  if (options.redactNames) {
    texts.forEach((t, i) => {
      for (const s of spans1[i] ?? []) if (s.type === "NAME") addName(t.slice(s.start, s.end));
    });
    for (const sp of speakers) if (sp && looksLikePersonName(sp)) addName(sp.trim());
  }

  // Pass 2: add propagated-term spans and re-resolve.
  const derivedMatcher: TermMatcher | null = derived.length ? compileTerms(derived) : null;
  const outTexts = texts.map((t, i) => {
    let spans = spans1[i] ?? [];
    if (derivedMatcher) {
      const extra = detectSpans(t, NO_DETECTORS, [derivedMatcher], [DERIVED_PRIORITY]);
      if (extra.length) spans = resolveSpans([...spans, ...extra]);
    }
    return applySpans(t, spans, vault, findings);
  });

  const outSpeakers = speakers.map((sp) => {
    if (sp === null || sp === undefined) return sp;
    if (options.redactNames && looksLikePersonName(sp)) {
      findings.NAME = (findings.NAME ?? 0) + 1;
      return vault.tokenFor("NAME", sp.trim());
    }
    const matchers = derivedMatcher ? [known, derivedMatcher] : [known];
    const spans = detectSpans(sp, options, matchers, [KNOWN_PRIORITY, DERIVED_PRIORITY]);
    return applySpans(sp, spans, vault, findings).slice(0, 64);
  });

  return { texts: outTexts, speakers: outSpeakers, vault, findings };
}

const NO_DETECTORS: PrivacyOptions = {
  redactNames: false,
  redactContact: false,
  redactIdentifiers: false,
  redactAddresses: false,
  redactDates: false,
};

export function createPrivacyController(): PrivacyController {
  return {
    prepare(evidence: EvidenceItem[], ctx: PrivacyContext): PreparedEvidence {
      const r = scrubMany(
        evidence.map((e) => e.excerpt),
        evidence.map((e) => e.speaker ?? null),
        ctx,
      );
      const vault = r.vault;
      const restoreText = (s: string): string => vault.restore(s);
      return {
        evidence: evidence.map((e, i) => ({ ...e, excerpt: r.texts[i] ?? e.excerpt, speaker: r.speakers[i] ?? e.speaker ?? null })),
        report: makeReport(r.findings),
        restoreFacts: (facts: SessionFacts): SessionFacts => deepRestore(facts, restoreText) as SessionFacts,
        restoreText,
      };
    },
  };
}

export function buildPrivacyContext(
  appointment: Appointment,
  options: PrivacyOptions,
  extraTerms: { value: string; type: PiiType }[] = [],
): PrivacyContext {
  const knownTerms: { value: string; type: PiiType }[] = [];
  if (appointment.clientRef.trim()) knownTerms.push({ value: appointment.clientRef.trim(), type: "CLIENT_REF" });
  for (const t of extraTerms) if (t.value.trim()) knownTerms.push({ value: t.value.trim(), type: t.type });
  return { options: { ...options }, knownTerms };
}

export function scrubText(
  text: string,
  ctx: PrivacyContext,
): { text: string; report: PrivacyReport; restore: (s: string) => string } {
  const r = scrubMany([text], [], ctx);
  const vault = r.vault;
  return { text: r.texts[0] ?? text, report: makeReport(r.findings), restore: (s) => vault.restore(s) };
}
