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
  approval_record: ["approval", "attestations", "provenance", "signatures"],
} as const satisfies Record<FileKind, readonly string[]>;
export type SectionKey<K extends FileKind = FileKind> = (typeof SECTION_KEYS)[K][number];

export const SECTION_LABELS: Record<string, string> = {
  overview: "Overview",
  session_note: "Session note",
  progress: "Progress record",
  participant_direction: "Participant direction",
  plan_coverage: "Plan coverage",
  follow_ups: "Follow-ups",
  missing_information: "Missing information",
  time_summary: "Time summary",
  documentation_checks: "Documentation checks",
  signatures: "Signatures & attestation",
  bill_to: "Bill to",
  funding_authorization: "Funding & authorization",
  service_lines: "Service lines",
  totals: "Totals",
  custom_fields: "Custom fields",
  notes: "Notes & payment terms",
  approval_reference: "Approval reference",
  approval: "Approval",
  attestations: "Attestations",
  provenance: "Provenance",
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
  | { type: "list"; items: { text: string; tag?: string }[] }
  | { type: "kv"; items: { label: string; value: string }[]; columns?: 1 | 2 }
  | { type: "table"; columns: { label: string; align?: "left" | "right"; width?: number }[]; rows: string[][] }
  | { type: "totals"; rows: { label: string; value: string; strong?: boolean }[] }
  | { type: "callout"; tone: "info" | "warning" | "fixture" | "draft"; text: string }
  | { type: "signatures"; statement: string | null; lines: { label: string; name?: string | null }[] }
  | { type: "divider" };

export interface DocModel {
  kind: FileKind;
  templateId: string;
  title: string;
  filename: string;
  theme: TemplateTheme;
  header: { logoText: string; headerNote: string; meta: { label: string; value: string }[] };
  footer: { note: string; revisionLabel: string };
  /** e.g. "SYNTHETIC / FIXTURE DATA — not a real visit" or "DRAFT — not approved". */
  banner: string | null;
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
