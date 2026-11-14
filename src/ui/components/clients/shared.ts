import type { ClientInput, ClientRecord, CustomField, FileKind } from "../../../contracts";

// Local copies of contract limits (keeps zod out of the UI bundle).
export const CLIENT_REF_RE = /^[A-Za-z0-9._-]+$/;
export const CLIENT_REF_MAX = 64;
export const MAX_RATE_CENTS = 10_000_000;
export const MAX_AUTH_HOURS = 100_000;
export const MAX_CUSTOM_FIELDS = 20;
export const LIMITS = {
  displayName: 120,
  preferredName: 80,
  fundingSource: 120,
  authorizationNumber: 80,
  fiscalIntermediary: 120,
  caseManager: 120,
  notes: 2000,
  fieldLabel: 60,
  fieldValue: 300,
} as const;
export const FILE_KINDS: { kind: FileKind; label: string }[] = [
  { kind: "session_note", label: "Session note" },
  { kind: "invoice", label: "Invoice" },
  { kind: "approval_record", label: "Approval record" },
];

export function validateClientRef(ref: string): string | null {
  const r = ref.trim();
  if (!r) return "Client ref is required.";
  if (r.length > CLIENT_REF_MAX) return `Use at most ${CLIENT_REF_MAX} characters.`;
  if (!CLIENT_REF_RE.test(r)) return "Use letters, numbers, . _ -";
  return null;
}

/**
 * Parses a dollar amount ("85", "85.5", "$1,234.56") into integer cents with
 * string/integer math only — never `parseFloat(x) * 100`, which can be off by a cent.
 */
export function parseDollarsToCents(raw: string): { cents: number } | { error: string } {
  const s = raw.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (s === "") return { error: "Enter an hourly rate, or switch on “Use agency default”." };
  const m = /^(\d{1,7})?(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === undefined && !m[2])) return { error: "Enter a dollar amount like 85 or 85.50 (at most 2 decimals)." };
  const whole = Number(m[1] ?? "0");
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents) || cents > MAX_RATE_CENTS) return { error: "Rate must be $100,000.00 or less." };
  return { cents };
}

/** Integer cents → "85.50" (no currency sign; for the input). */
export function centsToDollarString(cents: number): string {
  const c = Math.max(0, Math.trunc(cents));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

export function formatRate(cents: number | null): string {
  if (cents == null) return "Default rate";
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)}/hr`;
}

/** Authorized hours: up to 2 decimals. "" → null. */
export function parseHours(raw: string): { hours: number | null } | { error: string } {
  const s = raw.trim();
  if (s === "") return { hours: null };
  if (!/^\d{1,6}(\.\d{0,2})?$/.test(s)) return { error: "Enter hours like 40 or 12.5." };
  const n = Number(s);
  if (n > MAX_AUTH_HOURS) return { error: `At most ${MAX_AUTH_HOURS.toLocaleString()} hours.` };
  return { hours: n };
}

// ------------------------------------------------------------------ draft form
/** Editable string-based draft (inputs keep exactly what the user typed). */
export interface ClientDraft {
  clientRef: string;
  displayName: string;
  preferredName: string;
  useDefaultRate: boolean;
  rateDollars: string;
  fundingSource: string;
  authorizationNumber: string;
  fiscalIntermediary: string;
  authorizedHours: string;
  caseManager: string;
  customFields: (CustomField & { uid: string })[];
  templates: Record<FileKind, string | null>;
  notes: string;
  active: boolean;
}

let uidSeq = 0;
export const newUid = () => `cf${++uidSeq}`;

export function draftFromRecord(c: ClientRecord): ClientDraft {
  return {
    clientRef: c.clientRef,
    displayName: c.displayName ?? "",
    preferredName: c.preferredName ?? "",
    useDefaultRate: c.hourlyRateCents == null,
    rateDollars: c.hourlyRateCents == null ? "" : centsToDollarString(c.hourlyRateCents),
    fundingSource: c.fundingSource ?? "",
    authorizationNumber: c.authorizationNumber ?? "",
    fiscalIntermediary: c.fiscalIntermediary ?? "",
    authorizedHours: c.authorizedHours == null ? "" : String(c.authorizedHours),
    caseManager: c.caseManager ?? "",
    customFields: c.customFields.map((f) => ({ ...f, uid: newUid() })),
    templates: { ...c.templates },
    notes: c.notes ?? "",
    active: c.active,
  };
}

export function emptyInput(clientRef: string): ClientInput {
  return {
    clientRef,
    displayName: null,
    preferredName: null,
    hourlyRateCents: null,
    fundingSource: null,
    authorizationNumber: null,
    fiscalIntermediary: null,
    authorizedHours: null,
    caseManager: null,
    customFields: [],
    templates: { session_note: null, invoice: null, approval_record: null },
    notes: null,
    active: true,
  };
}

const opt = (s: string): string | null => (s.trim() === "" ? null : s.trim());

export type DraftErrors = Partial<Record<"rate" | "authorizedHours" | "customFields" | keyof typeof LIMITS, string>>;

/** Validates and converts a draft into the API body. */
export function draftToInput(d: ClientDraft): { input: ClientInput; errors: DraftErrors } {
  const errors: DraftErrors = {};
  let hourlyRateCents: number | null = null;
  if (!d.useDefaultRate) {
    const r = parseDollarsToCents(d.rateDollars);
    if ("error" in r) errors.rate = r.error;
    else hourlyRateCents = r.cents;
  }
  const h = parseHours(d.authorizedHours);
  let authorizedHours: number | null = null;
  if ("error" in h) errors.authorizedHours = h.error;
  else authorizedHours = h.hours;

  const textFields = ["displayName", "preferredName", "fundingSource", "authorizationNumber", "fiscalIntermediary", "caseManager", "notes"] as const;
  for (const k of textFields) {
    if (d[k].trim().length > LIMITS[k]) errors[k] = `At most ${LIMITS[k]} characters.`;
  }
  const fields = d.customFields.map((f) => ({ label: f.label.trim(), value: f.value.trim() }));
  if (fields.length > MAX_CUSTOM_FIELDS) errors.customFields = `At most ${MAX_CUSTOM_FIELDS} custom fields.`;
  else if (fields.some((f) => !f.label)) errors.customFields = "Every custom field needs a label.";
  else if (fields.some((f) => f.label.length > LIMITS.fieldLabel || f.value.length > LIMITS.fieldValue))
    errors.customFields = `Labels ≤ ${LIMITS.fieldLabel} and values ≤ ${LIMITS.fieldValue} characters.`;

  return {
    errors,
    input: {
      clientRef: d.clientRef,
      displayName: opt(d.displayName),
      preferredName: opt(d.preferredName),
      hourlyRateCents,
      fundingSource: opt(d.fundingSource),
      authorizationNumber: opt(d.authorizationNumber),
      fiscalIntermediary: opt(d.fiscalIntermediary),
      authorizedHours,
      caseManager: opt(d.caseManager),
      customFields: fields,
      templates: { ...d.templates },
      notes: opt(d.notes),
      active: d.active,
    },
  };
}

/** Stable comparison key for dirty tracking (ignores row uids). */
export function draftKey(d: ClientDraft): string {
  const { customFields, ...rest } = d;
  if (rest.useDefaultRate) rest.rateDollars = "";
  return JSON.stringify({ ...rest, customFields: customFields.map((f) => [f.label, f.value]) });
}

export function clientLabel(c: Pick<ClientRecord, "clientRef" | "preferredName" | "displayName">): string {
  return c.preferredName || c.displayName || c.clientRef;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function initials(c: Pick<ClientRecord, "clientRef" | "preferredName" | "displayName">): string {
  const n = (c.preferredName || c.displayName || "").trim();
  if (n) {
    const parts = n.replace(/\([^)]*\)/g, " ").split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
  }
  const alnum = c.clientRef.replace(/[^A-Za-z0-9]/g, "");
  return (alnum.slice(0, 2) || "?").toUpperCase();
}
