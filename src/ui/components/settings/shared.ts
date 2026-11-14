/**
 * Local copies of v2 contract constants (kept here so zod stays out of the
 * browser bundle — types only are imported from contracts) plus small
 * client-side helpers used for PREVIEW purposes only. The server renders the
 * real templates and performs the real redaction.
 */
import type { AiProviderId, ConnectionProvider, FileKind, PrivacyOptions } from "../../../contracts";

export const FILE_KINDS: readonly FileKind[] = ["session_note", "invoice", "approval_record"];
export const FILE_LABELS: Record<FileKind, string> = {
  session_note: "Session Note",
  invoice: "Invoice",
  approval_record: "Approval Record",
};

export const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = ["google", "microsoft"];
export const CONNECTION_LABELS: Record<ConnectionProvider, { name: string; storage: string; mail: string }> = {
  google: { name: "Google", storage: "Google Drive", mail: "Gmail" },
  microsoft: { name: "Microsoft", storage: "OneDrive", mail: "Outlook" },
};

export const AI_PROVIDERS: readonly AiProviderId[] = ["anthropic", "openai", "gemini", "mistral"];
export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  gemini: "Google Gemini",
  mistral: "Mistral",
};
export const AI_DEFAULT_MODELS: Record<AiProviderId, string[]> = {
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  mistral: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
};

export const TEMPLATE_PLACEHOLDERS = [
  "clientRef",
  "serviceDate",
  "serviceCode",
  "amount",
  "revision",
  "providerIdentity",
] as const;
export type Placeholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export const SAMPLE_VARS: Record<Placeholder, string> = {
  clientRef: "C-104",
  serviceDate: "2026-11-13",
  serviceCode: "H2014",
  amount: "$186.40",
  revision: "2",
  providerIdentity: "provider@example.org",
};

/** Client-side preview of the server's {placeholder} rendering. Unknown tokens are left as-is. */
export function renderTemplatePreview(tpl: string, vars: Partial<Record<string, string>>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s.trim());
}

/** Service date (YYYY-MM-DD) in the appointment's own timezone. */
export function serviceDateIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatInstant(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------------ privacy demo (illustration only)
export const PRIVACY_LABELS: Record<keyof PrivacyOptions, { label: string; hint: string }> = {
  redactNames: { label: "Names", hint: "People's names in transcripts and notes" },
  redactContact: { label: "Contact details", hint: "Email addresses and phone numbers" },
  redactIdentifiers: { label: "Identifiers", hint: "SSNs, Medicaid / MRN-style ids, client refs" },
  redactAddresses: { label: "Addresses", hint: "Street addresses" },
  redactDates: { label: "Dates of birth", hint: "DOB-like dates (service times are kept)" },
};
export const PRIVACY_KEYS = Object.keys(PRIVACY_LABELS) as (keyof PrivacyOptions)[];

export const PRIVACY_SAMPLE =
  "Maria Lopez (DOB 04/12/1961, client C-104, SSN 123-45-6789) lives at 42 Oak Street; reach her at maria.lopez@mail.com or (555) 201-3344.";

export interface DemoSegment {
  text: string;
  token?: string;
}

const DEMO_RULES: { key: keyof PrivacyOptions; type: string; re: RegExp }[] = [
  { key: "redactContact", type: "EMAIL", re: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { key: "redactIdentifiers", type: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { key: "redactContact", type: "PHONE", re: /\(?\d{3}\)?[\s.-]\d{3}-\d{4}/g },
  { key: "redactDates", type: "DATE", re: /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g },
  { key: "redactIdentifiers", type: "CLIENT_REF", re: /\bC-\d+\b/g },
  { key: "redactAddresses", type: "ADDRESS", re: /\b\d+\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd)\b/g },
  { key: "redactNames", type: "NAME", re: /\b(?:Maria Lopez|Maria|Lopez)\b/g },
];

/** Splits text into plain/redacted segments with simple regexes. For the settings demo only. */
export function demoRedact(text: string, opts: PrivacyOptions): DemoSegment[] {
  type Hit = { start: number; end: number; type: string };
  const hits: Hit[] = [];
  for (const rule of DEMO_RULES) {
    if (!opts[rule.key]) continue;
    for (const m of text.matchAll(rule.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, type: rule.type });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const counters: Record<string, number> = {};
  const seen = new Map<string, string>();
  const out: DemoSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) out.push({ text: text.slice(pos, h.start) });
    const raw = text.slice(h.start, h.end);
    let token = seen.get(raw);
    if (!token) {
      counters[h.type] = (counters[h.type] ?? 0) + 1;
      token = `[${h.type}_${counters[h.type]}]`;
      seen.set(raw, token);
    }
    out.push({ text: raw, token });
    pos = h.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}
