/** Built-in document templates + section normalization (pure; safe for UI and Worker). */
import type { FileKind } from "../contracts/v2";
import {
  SECTION_KEYS,
  builtinTemplateId,
  type DocumentTemplate,
  type TemplateInput,
  type TemplateSection,
  type TemplateText,
  type TemplateTheme,
} from "../contracts/v3";

export const DEFAULT_ACCENT = "#4338CA";
/** DDS SDP provider certification (docs/research/self-determination-codes.md §1.6). */
export const DEFAULT_ATTESTATION_STATEMENT =
  "I certify that the services listed on this invoice were provided to the participant as described, on the dates and at the times shown, consistent with the participant's Individual Program Plan, spending plan and service agreement, and without discrimination. All services specified in this invoice have been provided to the participant. I understand that payment is made from federal and state funds and that falsification or concealment of a material fact may be prosecuted under federal and state law. Records supporting this invoice will be kept for at least three years from the date of service.";
/** Progress-note attestation. */
export const NOTE_ATTESTATION_STATEMENT =
  "I attest that this note accurately describes the services I provided to the participant on the date and at the times shown, and that the participant directed their goals and activities to the extent indicated.";
/** Fixed timestamp so built-ins are deterministic. */
const BUILTIN_UPDATED_AT = "2026-01-01T00:00:00.000Z";

const NAMES: Record<FileKind, string> = {
  session_note: "Progress note (SDP)",
  invoice: "SDP provider invoice",
  approval_record: "Standard approval record",
};

/**
 * Built-in section order + defaults per kind. Sections not listed are appended disabled
 * (they stay available in the template designer).
 */
const BUILTIN_SECTIONS: Record<FileKind, { key: string; enabled: boolean }[]> = {
  invoice: [
    { key: "bill_to", enabled: true },
    { key: "service_lines", enabled: true },
    { key: "totals", enabled: true },
    { key: "funding_authorization", enabled: true },
    { key: "notes", enabled: true },
    { key: "signatures", enabled: true },
    { key: "custom_fields", enabled: false },
    { key: "participant_direction", enabled: false },
    { key: "approval_reference", enabled: false },
  ],
  session_note: [
    { key: "overview", enabled: true },
    { key: "plan_coverage", enabled: true },
    { key: "session_note", enabled: true },
    { key: "progress", enabled: true },
    { key: "participant_direction", enabled: true },
    { key: "follow_ups", enabled: true },
    { key: "time_summary", enabled: true },
    { key: "signatures", enabled: true },
    { key: "missing_information", enabled: false },
    { key: "documentation_checks", enabled: false },
  ],
  approval_record: SECTION_KEYS.approval_record.map((key) => ({ key, enabled: true })),
};

export const DEFAULT_THEME: TemplateTheme = {
  accentColor: DEFAULT_ACCENT,
  fontFamily: "sans",
  paper: "letter",
  density: "comfortable",
  logoText: "Vexo Field Assistant",
  headerNote: "",
  footerNote: "",
};

export const DEFAULT_TEXT: TemplateText = {
  title: "",
  invoicePrefix: "INV",
  paymentTerms: "Net 30 — payable by the participant's FMS per the spending plan.",
  invoiceNotes: "",
  attestationStatement: DEFAULT_ATTESTATION_STATEMENT,
  participantSignatureLabel: "Participant",
  providerSignatureLabel: "Provider",
  representativeSignatureLabel: "",
};

export function defaultSections(kind: FileKind): TemplateSection[] {
  return SECTION_KEYS[kind].map((key) => ({ key, enabled: true }));
}

function builtin(kind: FileKind): DocumentTemplate {
  return {
    id: builtinTemplateId(kind),
    kind,
    name: NAMES[kind],
    builtin: true,
    isDefault: false,
    updatedAt: BUILTIN_UPDATED_AT,
    theme: { ...DEFAULT_THEME, ...(kind === "approval_record" ? {} : { accentColor: "#1F3A5F", fontFamily: "sans" as const }) },
    sections: normalizeTemplate(kind, { sections: BUILTIN_SECTIONS[kind] } as TemplateInput).sections,
    text: { ...DEFAULT_TEXT, ...(kind === "session_note" ? { attestationStatement: NOTE_ATTESTATION_STATEMENT } : {}) },
  };
}

export const BUILTIN_TEMPLATES: Record<FileKind, DocumentTemplate> = {
  session_note: builtin("session_note"),
  invoice: builtin("invoice"),
  approval_record: builtin("approval_record"),
};

/**
 * Forces `kind`, drops unknown section keys, de-dupes (first wins, keeping order)
 * and appends any missing keys (disabled) in SECTION_KEYS order.
 */
export function normalizeTemplate<T extends TemplateInput>(kind: FileKind, input: T): T {
  const allowed: readonly string[] = SECTION_KEYS[kind];
  const seen = new Set<string>();
  const sections: TemplateSection[] = [];
  for (const s of input.sections ?? []) {
    if (!s || typeof s.key !== "string" || !allowed.includes(s.key) || seen.has(s.key)) continue;
    seen.add(s.key);
    sections.push({ key: s.key, enabled: s.enabled === true });
  }
  for (const key of allowed) if (!seen.has(key)) sections.push({ key, enabled: false });
  return { ...input, kind, sections };
}

/** Enabled section keys in template order (after normalization). */
export function enabledSections(kind: FileKind, t: TemplateInput): string[] {
  return normalizeTemplate(kind, t).sections.filter((s) => s.enabled).map((s) => s.key);
}
