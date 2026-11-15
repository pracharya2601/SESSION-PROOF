/**
 * v3 contracts (FROZEN for the v3 build): clients + per-client hourly rate,
 * self-determination receipt items, document templates, a shared document
 * model (HTML preview + PDF from the same blocks), and run history.
 * Additive — v1/v2 schemas unchanged except the additive review-edit fields.
 */
import { z } from "zod";
import type { ApprovalRecord, FinalBundle, SessionBundle } from "./schemas";
import type { FileKind } from "./v2";

const Id = z.string().min(1).max(128);
const Instant = z.string().datetime({ offset: true });
const Text = (max: number) => z.string().trim().max(max);
const OptText = (max: number) => z.string().trim().max(max).nullable();

// ================================================================== clients
export const CustomField = z.object({ label: Text(60).min(1), value: Text(300) }).strict();
export type CustomField = z.infer<typeof CustomField>;

/** Editable client fields. clientRef is the stable key (matches Appointment.clientRef). */
export const ClientInput = z
  .object({
    clientRef: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, . _ -"),
    /** Sensitive: never sent to AI (added to the PII scrubber's known terms). */
    displayName: OptText(120),
    preferredName: OptText(80),
    /** Per-client hourly rate; null = agency default rate from the service config. */
    hourlyRateCents: z.number().int().nonnegative().max(10_000_000).nullable(),
    // self-determination: funding & authorization
    fundingSource: OptText(120),
    authorizationNumber: OptText(80),
    fiscalIntermediary: OptText(120),
    /** Authorized hours for the current authorization period (informational on the invoice). */
    authorizedHours: z.number().nonnegative().max(100_000).nullable(),
    caseManager: OptText(120),
    // ---- invoice / bill-payer details (v5, additive; absent on older records = null)
    /** Regional Center Unique Client Identifier (UCI) number. */
    uciNumber: OptText(20).optional(),
    /** Bill-to address of the FMS (the FMS name is `fiscalIntermediary`). */
    fmsAddress: OptText(300).optional(),
    /** Spending plan / authorization number override; null = use the Drive authorization (preferred). */
    authorizationOverride: OptText(80).optional(),
    /** Participant's authorized representative (signs on the participant's behalf). */
    representativeName: OptText(120).optional(),
    customFields: z.array(CustomField).max(20),
    /** Template ids to use for this client's documents; null = provider default. */
    templates: z
      .object({ session_note: Id.nullable(), invoice: Id.nullable(), approval_record: Id.nullable() })
      .strict(),
    notes: OptText(2000),
    active: z.boolean(),
  })
  .strict();
export type ClientInput = z.infer<typeof ClientInput>;

export const ClientRecord = ClientInput.extend({
  providerId: Id,
  /** Bumped by the server whenever hourlyRateCents changes. */
  rateVersion: z.number().int().positive(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type ClientRecord = z.infer<typeof ClientRecord>;

export const ClientStats = z.object({
  sessions: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  billedCents: z.number().int().nonnegative(),
  billedMinutes: z.number().int().nonnegative(),
  lastServiceAt: Instant.nullable(),
});
export type ClientStats = z.infer<typeof ClientStats>;

export const ClientSummary = z.object({ client: ClientRecord, stats: ClientStats });
export type ClientSummary = z.infer<typeof ClientSummary>;

/** Frozen at approval/finalization so documents never change after approval. */
export const ClientSnapshot = ClientRecord.omit({ notes: true, templates: true }).extend({
  effectiveHourlyRateCents: z.number().int().nonnegative(),
  capturedAt: Instant,
});
export type ClientSnapshot = z.infer<typeof ClientSnapshot>;

/** rateVersion written into the bundle's frozen RateRule when a client rate applies. */
export function clientRateVersion(clientRef: string, rateVersion: number): string {
  return `client:${clientRef}:v${rateVersion}`;
}

// ================================================================== provider business profile (v5)
/** Logo: PNG or JPEG data URL, at most 100 KB decoded. */
export const LOGO_MAX_BYTES = 100 * 1024;
const LogoDataUrl = z
  .string()
  .max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64)
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/, "Use a PNG or JPEG image")
  .refine((s) => {
    const b64 = s.slice(s.indexOf(",") + 1);
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return (b64.length * 3) / 4 - pad <= LOGO_MAX_BYTES;
  }, "Logo must be 100 KB or smaller");

/**
 * The provider's business details, captured once (Settings → Business profile) and printed on
 * every invoice. Captured per provider. Never sent to AI.
 */
export const ProviderProfileInput = z
  .object({
    legalName: OptText(120),
    dba: OptText(120),
    addressLine1: OptText(120),
    addressLine2: OptText(120),
    city: OptText(60),
    state: OptText(30),
    postalCode: OptText(20),
    phone: OptText(40),
    /** Business contact email shown on the invoice. */
    email: z.string().trim().max(254).email().nullable(),
    /** Regional Center / FMS vendor number. */
    vendorNumber: OptText(40),
    npi: z.string().trim().regex(/^\d{10}$/, "NPI is 10 digits").nullable(),
    /** Last 4 digits of the tax id only — never the full number. */
    taxIdLast4: z.string().trim().regex(/^\d{4}$/, "Enter the last 4 digits only").nullable(),
    /** Remit-to (payment) address or instructions; null = the business address. */
    remitTo: OptText(400),
    /** Person whose typed name is the provider e-signature on approval. */
    signerName: OptText(120),
    logoDataUrl: LogoDataUrl.nullable(),
    invoicePrefix: z.string().trim().max(12).regex(/^[A-Za-z0-9-]*$/, "Letters, numbers and dashes only"),
    /** Next sequential invoice number. The server never lets it go below a number already used. */
    nextInvoiceNumber: z.number().int().positive().max(99_999_999),
    paymentTerms: OptText(300),
  })
  .strict();
export type ProviderProfileInput = z.infer<typeof ProviderProfileInput>;

export const ProviderProfile = ProviderProfileInput.extend({ providerId: Id, updatedAt: Instant.nullable() });
export type ProviderProfile = z.infer<typeof ProviderProfile>;

export const EMPTY_PROVIDER_PROFILE: ProviderProfileInput = {
  legalName: null,
  dba: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  phone: null,
  email: null,
  vendorNumber: null,
  npi: null,
  taxIdLast4: null,
  remitTo: null,
  signerName: null,
  logoDataUrl: null,
  invoicePrefix: "INV",
  nextInvoiceNumber: 1,
  paymentTerms: null,
};

/** Fields an invoice cannot go out without (labels shown in the blocking checklist item). */
export function missingProfileFields(p: ProviderProfileInput | null | undefined): string[] {
  const blank = (v: string | null | undefined) => !v || v.trim().length === 0;
  const out: string[] = [];
  if (!p || blank(p.legalName)) out.push("business name");
  if (!p || blank(p.vendorNumber)) out.push("vendor #");
  if (!p || blank(p.addressLine1) || blank(p.city) || blank(p.state) || blank(p.postalCode)) out.push("address");
  return out;
}

/** GET/PUT /api/settings/business-profile response. */
export interface BusinessProfileView {
  profile: ProviderProfileInput;
  /** Required fields still missing (approval is blocked until empty). */
  missing: string[];
  updatedAt: string | null;
}

/** Sequential invoice number assigned once per approved revision (never reused). */
export const InvoiceNumberRecord = z.object({
  providerId: Id,
  sessionId: Id,
  bundleRevision: z.number().int().positive(),
  seq: z.number().int().positive(),
  invoiceNumber: z.string().min(1).max(40),
  /** Business profile frozen when the number was assigned (documents for a final use it). */
  profile: ProviderProfileInput,
  assignedAt: Instant,
});
export type InvoiceNumberRecord = z.infer<typeof InvoiceNumberRecord>;

/** "<prefix>-<seq padded to 4>" (empty prefix → just the number). */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  const p = prefix.replace(/[^A-Za-z0-9-]/g, "");
  const n = String(seq).padStart(4, "0");
  return p ? `${p}-${n}` : n;
}

// ================================================================== templates
export const SECTION_KEYS = {
  session_note: [
    "overview",
    "session_note",
    "progress",
    "participant_direction",
    "plan_coverage",
    "follow_ups",
    "missing_information",
    "time_summary",
    "documentation_checks",
    "signatures",
  ],
  invoice: [
    "bill_to",
    "funding_authorization",
    "service_lines",
    "totals",
    "participant_direction",
    "custom_fields",
    "notes",
    "signatures",
    "approval_reference",
  ],
  approval_record: ["approval", "checks", "attestations", "amendments", "provenance", "signatures"],
} as const satisfies Record<FileKind, readonly string[]>;
export type SectionKey<K extends FileKind = FileKind> = (typeof SECTION_KEYS)[K][number];

export const SECTION_LABELS: Record<string, string> = {
  overview: "Visit details",
  session_note: "Activities and participant response",
  progress: "Progress toward goals",
  participant_direction: "Participant direction & choices",
  plan_coverage: "Purpose / goals addressed",
  follow_ups: "Follow-up / next visit",
  missing_information: "Outstanding items",
  time_summary: "Time",
  documentation_checks: "Documentation checks",
  signatures: "Signatures & attestation",
  bill_to: "Bill to & participant",
  funding_authorization: "Authorization",
  service_lines: "Services provided",
  totals: "Totals",
  custom_fields: "Additional details",
  notes: "Payment terms & remit to",
  approval_reference: "Approval reference",
  approval: "Approval",
  checks: "Checks passed",
  attestations: "Provider attestations",
  amendments: "Amendment history",
  provenance: "Data provenance",
};

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB color");

export const TemplateTheme = z
  .object({
    accentColor: HexColor,
    fontFamily: z.enum(["sans", "serif", "mono"]),
    paper: z.enum(["letter", "a4"]),
    density: z.enum(["comfortable", "compact"]),
    logoText: Text(60),
    headerNote: Text(200),
    footerNote: Text(300),
  })
  .strict();
export type TemplateTheme = z.infer<typeof TemplateTheme>;

export const TemplateText = z
  .object({
    /** Overrides the default document title when non-empty. */
    title: Text(80),
    invoicePrefix: z.string().trim().max(12).regex(/^[A-Za-z0-9-]*$/),
    paymentTerms: Text(500),
    invoiceNotes: Text(1000),
    attestationStatement: Text(1000),
    participantSignatureLabel: Text(80),
    providerSignatureLabel: Text(80),
    /** Empty = no representative line. */
    representativeSignatureLabel: Text(80),
  })
  .strict();
export type TemplateText = z.infer<typeof TemplateText>;

export const TemplateSection = z.object({ key: z.string().min(1).max(40), enabled: z.boolean() }).strict();
export type TemplateSection = z.infer<typeof TemplateSection>;

export const TemplateInput = z
  .object({
    kind: z.enum(["session_note", "invoice", "approval_record"]),
    name: Text(80).min(1),
    theme: TemplateTheme,
    /** Ordered; every key must be in SECTION_KEYS[kind]; missing keys are appended disabled. */
    sections: z.array(TemplateSection).max(20),
    text: TemplateText,
  })
  .strict();
export type TemplateInput = z.infer<typeof TemplateInput>;

export const DocumentTemplate = TemplateInput.extend({
  /** Built-ins: "builtin:<kind>" (read-only). */
  id: Id,
  builtin: z.boolean(),
  isDefault: z.boolean(),
  updatedAt: Instant,
});
export type DocumentTemplate = z.infer<typeof DocumentTemplate>;

export const builtinTemplateId = (kind: FileKind) => `builtin:${kind}`;

// ================================================================== document model
/** One structured document → rendered as HTML/CSS (preview) and as PDF (download/upload). */
export type DocBlock =
  | { type: "heading"; text: string; section: string }
  | { type: "paragraph"; text: string; tone?: "default" | "muted" | "notice" }
  /** refs: superscript source markers ([1], [2]) resolved in the document's Sources appendix. */
  | { type: "list"; items: { text: string; tag?: string; refs?: number[] }[] }
  | { type: "kv"; items: { label: string; value: string }[]; columns?: 1 | 2 }
  /** rowKinds (optional, per row): "sub" = an indented detail line under the preceding "item" row. */
  | { type: "table"; columns: { label: string; align?: "left" | "right"; width?: number }[]; rows: string[][]; rowKinds?: ("item" | "sub")[] }
  | { type: "totals"; rows: { label: string; value: string; strong?: boolean }[] }
  | { type: "callout"; tone: "info" | "warning" | "fixture" | "draft"; text: string }
  /** signed: typed e-signature text (e.g. "/s/ Alex Rivera"); date: pre-filled date; both null = blank line. */
  | { type: "signatures"; statement: string | null; lines: { label: string; name?: string | null; signed?: string | null; date?: string | null }[] }
  /** Side-by-side address/party blocks (Bill to, Participant, …). */
  | { type: "parties"; parties: { label: string; lines: string[] }[] }
  /** Forces the next block onto a new page. */
  | { type: "pagebreak" }
  | { type: "divider" };

/** Letterhead (business identity + document title block) drawn instead of the plain header band. */
export interface DocLetterhead {
  /** Business display name (or a placeholder when the business profile is incomplete). */
  name: string;
  /** Address / phone / email / vendor # lines under the name. */
  lines: string[];
  /** PNG/JPEG data URL or null. */
  logoDataUrl: string | null;
  /** True when required business profile fields are missing (lines carry a placeholder). */
  incomplete: boolean;
  /** Right-hand title block items (Invoice #, Date, …). */
  meta: { label: string; value: string }[];
}

export interface DocModel {
  kind: FileKind;
  templateId: string;
  title: string;
  filename: string;
  theme: TemplateTheme;
  header: { logoText: string; headerNote: string; meta: { label: string; value: string }[] };
  footer: { note: string; revisionLabel: string };
  /** Footer strip on every page (approval record only: provenance / draft). */
  banner: string | null;
  /** Optional letterhead (invoice / session note). Absent = plain header band. */
  letterhead?: DocLetterhead | null;
  /** Diagonal watermark on every page (e.g. "DRAFT — not for billing" before approval); null = none. */
  watermark?: string | null;
  blocks: DocBlock[];
}

export interface DocModelInput {
  /** Approved final bundle, or the current draft bundle (preview only; banner = DRAFT). */
  bundle: SessionBundle;
  final: FinalBundle | null;
  approval: ApprovalRecord | null;
  providerIdentity: string | null;
  client: ClientSnapshot | null;
  template: DocumentTemplate;
  /** v5: business profile (frozen with the invoice number for finals; live for drafts). */
  profile?: ProviderProfileInput | null;
  /** v5: sequential invoice number assigned at approval; null = not yet assigned. */
  invoiceNumber?: string | null;
  /** v5: earlier approved revisions this one replaced (approval record amendment history). */
  superseded?: SupersededRevision[];
}

export const PreviewTemplateRequest = z
  .object({
    template: TemplateInput,
    /** Real session to preview with; omitted = built-in synthetic sample. */
    sessionId: Id.optional(),
  })
  .strict();
export type PreviewTemplateRequest = z.infer<typeof PreviewTemplateRequest>;

// ================================================================== run history
export const RunStage = z.enum([
  "discovered",
  "queued",
  "workflow_started",
  "load",
  "evidence",
  "match",
  "privacy",
  "extraction",
  "assemble",
  "draft_saved",
  "review_saved",
  "approval_wait",
  "approved",
  "finalize",
  "client_snapshot",
  "files",
  "delivery_drive",
  "delivery_email",
  "completed",
  "failed",
  "amended",
]);
export type RunStage = z.infer<typeof RunStage>;

export const RunEvent = z.object({
  /** Deterministic so retried steps don't duplicate: `${runId}:${stage}:${status}[:${suffix}]`. */
  id: z.string().min(1).max(300),
  runId: z.string().min(1).max(200),
  runKind: z.enum(["processing", "delivery"]),
  sessionId: Id,
  providerId: Id,
  stage: RunStage,
  status: z.enum(["started", "succeeded", "failed", "waiting", "skipped", "info"]),
  /** Human label, e.g. "Extracted facts with OpenAI gpt-4.1". NEVER transcript text or PII. */
  label: z.string().max(200),
  /** Safe detail (reason codes, counts). Never excerpts, names, tokens. */
  detail: z.string().max(500).nullable(),
  meta: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
  at: Instant,
});
export type RunEvent = z.infer<typeof RunEvent>;

export const RunSummary = z.object({
  runId: z.string(),
  runKind: z.enum(["processing", "delivery"]),
  sessionId: Id,
  clientRef: z.string().nullable(),
  status: z.enum(["running", "waiting", "succeeded", "failed"]),
  currentStage: RunStage,
  startedAt: Instant,
  endedAt: Instant.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  eventCount: z.number().int().nonnegative(),
  aiProvider: z.string().nullable(),
  model: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const RunDetail = z.object({ summary: RunSummary, events: z.array(RunEvent) });
export type RunDetail = z.infer<typeof RunDetail>;

export const ListRunsResponse = z.object({ runs: z.array(RunSummary), nextCursor: z.string().nullable() });
export type ListRunsResponse = z.infer<typeof ListRunsResponse>;

/** Recorder port used by workflow/jobs/services (implementation: src/history). Never throws. */
export interface RunRecorder {
  record(e: Omit<RunEvent, "id" | "at"> & { idSuffix?: string; at?: string }): Promise<void>;
}

// ================================================================== amendments
/** Reopen a COMPLETED session as a new revision that must be re-approved. */
export const AmendRequest = z
  .object({
    /** The finalized revision being amended (must be the current final). */
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AmendRequest = z.infer<typeof AmendRequest>;

/** A previously approved revision that an amendment replaced (kept for audit). */
export const SupersededRevision = z.object({
  sessionId: Id,
  bundleRevision: z.number().int().positive(),
  approvalId: Id,
  finalizedAt: Instant,
  supersededAt: Instant,
  supersededByRevision: z.number().int().positive(),
  reason: z.string(),
  actorProviderId: Id,
  amountCents: z.number().int().nonnegative().nullable(),
});
export type SupersededRevision = z.infer<typeof SupersededRevision>;
