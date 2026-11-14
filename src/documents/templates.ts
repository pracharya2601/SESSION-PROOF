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
export const DEFAULT_ATTESTATION_STATEMENT =
  "I attest that the services described were provided as documented and that the participant directed their own goals and activities to the extent indicated.";
/** Fixed timestamp so built-ins are deterministic. */
const BUILTIN_UPDATED_AT = "2026-01-01T00:00:00.000Z";

const NAMES: Record<FileKind, string> = {
  session_note: "Standard session note",
  invoice: "Standard invoice",
  approval_record: "Standard approval record",
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
  paymentTerms: "Payment due upon receipt unless your funding agreement states otherwise.",
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
    theme: { ...DEFAULT_THEME },
    sections: defaultSections(kind),
    text: { ...DEFAULT_TEXT },
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
