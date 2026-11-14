/**
 * v2 contracts (FROZEN for the v2 build): files, cloud connections,
 * deliveries (drive upload + email draft), per-provider settings, the
 * multi-provider inference adapter and the PII privacy controller.
 * Additive to schemas.ts — nothing there changes.
 */
import { z } from "zod";
import type { EvidenceItem, SessionFacts } from "./schemas";

const Id = z.string().min(1).max(128);
const Instant = z.string().datetime({ offset: true });
const Email = z.string().trim().toLowerCase().email().max(254);

// ------------------------------------------------------------------ files
/** The three artifacts every COMPLETED session produces (all PDF). */
export const FileKind = z.enum(["session_note", "invoice", "approval_record"]);
export type FileKind = z.infer<typeof FileKind>;
export const FILE_KINDS: readonly FileKind[] = ["session_note", "invoice", "approval_record"];
export const FILE_LABELS: Record<FileKind, string> = {
  session_note: "Session Note",
  invoice: "Invoice",
  approval_record: "Approval Record",
};

export const SessionFile = z.object({
  kind: FileKind,
  label: z.string(),
  /** e.g. "C-104_2026-11-13_session-note_r2.pdf" — deterministic, no PII beyond clientRef. */
  filename: z.string().max(200),
  contentType: z.literal("application/pdf"),
  /** Relative URL: /api/sessions/:id/files/:kind */
  downloadUrl: z.string(),
});
export type SessionFile = z.infer<typeof SessionFile>;

// ------------------------------------------------------------------ connections
export const ConnectionProvider = z.enum(["google", "microsoft"]);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;
export const CONNECTION_LABELS: Record<ConnectionProvider, { name: string; storage: string; mail: string }> = {
  google: { name: "Google", storage: "Google Drive", mail: "Gmail" },
  microsoft: { name: "Microsoft", storage: "OneDrive", mail: "Outlook" },
};

/** Safe view — never contains tokens. */
export const Connection = z.object({
  provider: ConnectionProvider,
  /** not_configured = server lacks OAuth client credentials for this provider. */
  status: z.enum(["connected", "not_connected", "error", "not_configured"]),
  accountEmail: z.string().nullable(),
  scopes: z.array(z.string()),
  connectedAt: Instant.nullable(),
  lastError: z.string().max(500).nullable(),
});
export type Connection = z.infer<typeof Connection>;

export const StartConnectionResponse = z.object({ authorizeUrl: z.string().url() });
export type StartConnectionResponse = z.infer<typeof StartConnectionResponse>;

/** Server-side stored connection (tokens encrypted with TOKEN_ENCRYPTION_KEY via src/security encryptToken). */
export interface StoredConnection {
  providerId: string;
  provider: ConnectionProvider;
  accountEmail: string | null;
  scopes: string[];
  /** encryptToken(JSON.stringify({ accessToken, refreshToken })) */
  encryptedTokens: string;
  accessTokenExpiresAt: string | null;
  status: "connected" | "error";
  lastError: string | null;
  connectedAt: string;
  updatedAt: string;
}

export interface OAuthPending {
  nonce: string;
  providerId: string;
  provider: ConnectionProvider;
  codeVerifier: string;
  returnTo: string;
  expiresAt: string;
}

// ------------------------------------------------------------------ deliveries
export const DeliveryTarget = z.enum(["drive", "email_draft"]);
export type DeliveryTarget = z.infer<typeof DeliveryTarget>;

export const FileDelivery = z.object({
  id: Id,
  sessionId: Id,
  bundleRevision: z.number().int().positive(),
  target: DeliveryTarget,
  provider: ConnectionProvider,
  files: z.array(FileKind),
  status: z.enum(["pending", "done", "failed"]),
  /** Drive folder id or mail draft id. */
  externalId: z.string().nullable(),
  /** Link to open the folder / the draft in the provider's web UI. */
  webUrl: z.string().nullable(),
  /** Recipients for drafts (empty for drive). */
  recipients: z.array(z.string()),
  error: z.string().max(500).nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type FileDelivery = z.infer<typeof FileDelivery>;

export const DriveUploadRequest = z
  .object({
    provider: ConnectionProvider.optional(), // default: storage settings provider
    files: z.array(FileKind).min(1).max(3).optional(), // default: all three
  })
  .strict();
export type DriveUploadRequest = z.infer<typeof DriveUploadRequest>;

export const EmailDraftRequest = z
  .object({
    provider: ConnectionProvider.optional(), // default: email settings provider
    to: z.array(Email).min(1).max(10),
    cc: z.array(Email).max(10).optional(),
    subject: z.string().trim().min(1).max(250).optional(), // default: rendered template
    body: z.string().max(10_000).optional(), // default: rendered template
    files: z.array(FileKind).min(1).max(3).optional(), // default: email settings attach
  })
  .strict();
export type EmailDraftRequest = z.infer<typeof EmailDraftRequest>;

/** One row on the Files dashboard: a COMPLETED session and its artifacts. */
export const CompletedSessionFiles = z.object({
  sessionId: Id,
  clientRef: Id,
  serviceCode: Id,
  startAt: Instant,
  endAt: Instant,
  timezone: z.string(),
  bundleRevision: z.number().int().positive(),
  approvedAt: Instant,
  approverProviderId: Id,
  amountCents: z.number().int().nonnegative().nullable(),
  confirmedMinutes: z.number().int().positive().nullable(),
  evidenceMode: z.enum(["live", "fixture"]),
  files: z.array(SessionFile),
  deliveries: z.array(FileDelivery),
});
export type CompletedSessionFiles = z.infer<typeof CompletedSessionFiles>;

export const ListFilesResponse = z.object({
  items: z.array(CompletedSessionFiles),
  nextCursor: z.string().nullable(),
});
export type ListFilesResponse = z.infer<typeof ListFilesResponse>;

// ------------------------------------------------------------------ settings
/**
 * Template placeholders (rendered server-side, values HTML-free):
 * {clientRef} {serviceDate} {serviceCode} {amount} {revision} {providerIdentity}
 */
export const TEMPLATE_PLACEHOLDERS = [
  "clientRef",
  "serviceDate",
  "serviceCode",
  "amount",
  "revision",
  "providerIdentity",
] as const;

export const StorageSettings = z
  .object({
    provider: ConnectionProvider.nullable(),
    /** Folder path inside the drive; may use {clientRef} and {serviceDate}. */
    folderPath: z.string().trim().min(1).max(300).regex(/^[^\\:*?"<>|]+$/, "Folder path has invalid characters"),
    autoUploadOnComplete: z.boolean(),
  })
  .strict();
export type StorageSettings = z.infer<typeof StorageSettings>;
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  provider: null,
  folderPath: "Vexo Field Assistant/{clientRef}/{serviceDate}",
  autoUploadOnComplete: false,
};

export const EmailSettings = z
  .object({
    provider: ConnectionProvider.nullable(),
    defaultTo: z.array(Email).max(10),
    defaultCc: z.array(Email).max(10),
    subjectTemplate: z.string().trim().min(1).max(250),
    bodyTemplate: z.string().max(10_000),
    attach: z.array(FileKind).max(3),
  })
  .strict();
export type EmailSettings = z.infer<typeof EmailSettings>;
export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  provider: null,
  defaultTo: [],
  defaultCc: [],
  subjectTemplate: "Session documentation — {clientRef} — {serviceDate}",
  bodyTemplate:
    "Hello,\n\nAttached are the approved session note, invoice and approval record for {clientRef} ({serviceDate}, revision {revision}). Amount: {amount}.\n\nThank you.",
  attach: ["session_note", "invoice", "approval_record"],
};

// ------------------------------------------------------------------ AI + privacy
export const AiProviderId = z.enum(["anthropic", "openai", "gemini", "mistral"]);
export type AiProviderId = z.infer<typeof AiProviderId>;
export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  gemini: "Google Gemini",
  mistral: "Mistral",
};
/** Suggested models per provider (UI picker; any string accepted server-side up to 100 chars). */
export const AI_DEFAULT_MODELS: Record<AiProviderId, string[]> = {
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  mistral: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
};

export const PrivacyOptions = z
  .object({
    redactNames: z.boolean(),
    redactContact: z.boolean(), // emails, phone numbers
    redactIdentifiers: z.boolean(), // SSN, Medicaid/MRN-like ids, client refs
    redactAddresses: z.boolean(),
    redactDates: z.boolean(), // DOB-like dates (service timestamps are kept)
  })
  .strict();
export type PrivacyOptions = z.infer<typeof PrivacyOptions>;

export const AiSettings = z
  .object({
    provider: AiProviderId,
    model: z.string().trim().min(1).max(100),
    privacy: PrivacyOptions,
  })
  .strict();
export type AiSettings = z.infer<typeof AiSettings>;
export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  privacy: { redactNames: true, redactContact: true, redactIdentifiers: true, redactAddresses: true, redactDates: true },
};

export const AiProviderStatus = z.object({
  provider: AiProviderId,
  label: z.string(),
  /** Server has an API key for it. Keys never leave the server. */
  configured: z.boolean(),
  models: z.array(z.string()),
});
export type AiProviderStatus = z.infer<typeof AiProviderStatus>;

/** GET /api/settings */
export const SettingsBundle = z.object({
  storage: StorageSettings,
  email: EmailSettings,
  ai: AiSettings,
  aiProviders: z.array(AiProviderStatus),
  extractionMode: z.enum(["live", "fixture"]),
});
export type SettingsBundle = z.infer<typeof SettingsBundle>;

// ------------------------------------------------------------------ inference adapter port
export interface InferenceRequest {
  system: string;
  user: string;
  /** Structured output: the model must return JSON matching inputSchema. */
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
  maxTokens: number;
  signal?: AbortSignal;
}
export interface InferenceResult {
  /** Parsed JSON object (or raw string if the provider returned unparsable text — caller validates). */
  output: unknown;
  provider: AiProviderId;
  model: string;
}
export interface InferenceProvider {
  readonly id: AiProviderId;
  readonly model: string;
  generateStructured(req: InferenceRequest): Promise<InferenceResult>;
}
export class InferenceError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "auth" | "rate_limited" | "timeout" | "provider" | "invalid_output",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

// ------------------------------------------------------------------ privacy controller port
export type PiiType = "NAME" | "EMAIL" | "PHONE" | "SSN" | "ID" | "ADDRESS" | "DATE" | "CLIENT_REF";

export interface PrivacyContext {
  options: PrivacyOptions;
  /** Known sensitive terms to always redact (client ref, provider identity, roster names…). */
  knownTerms: { value: string; type: PiiType }[];
}

export interface PrivacyReport {
  scrubbed: boolean;
  findings: Partial<Record<PiiType, number>>;
}

export interface PreparedEvidence {
  /** Same ids/timestamps/speakers; excerpt text has PII replaced by tokens like [NAME_1]. */
  evidence: EvidenceItem[];
  report: PrivacyReport;
  /** Restores tokens in model output. Vault never leaves the Worker or gets logged/persisted. */
  restoreFacts(facts: SessionFacts): SessionFacts;
  restoreText(text: string): string;
}

export interface PrivacyController {
  prepare(evidence: EvidenceItem[], ctx: PrivacyContext): PreparedEvidence;
}
