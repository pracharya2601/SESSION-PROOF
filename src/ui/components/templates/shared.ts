import type { DocModel, DocumentTemplate, FileKind, TemplateInput, TemplateSection } from "../../../contracts";

// Local copies of contract constants (value imports from contracts would pull zod into the bundle).
export const SECTION_KEYS: Record<FileKind, readonly string[]> = {
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
};

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

export const KINDS: FileKind[] = ["session_note", "invoice", "approval_record"];
export const KIND_LABELS: Record<FileKind, string> = {
  session_note: "Session Note",
  invoice: "Invoice",
  approval_record: "Approval Record",
};

export const ACCENT_PRESETS: { hex: string; name: string }[] = [
  { hex: "#4F46E5", name: "Indigo" },
  { hex: "#2563EB", name: "Blue" },
  { hex: "#0E7490", name: "Teal" },
  { hex: "#047857", name: "Emerald" },
  { hex: "#B45309", name: "Amber" },
  { hex: "#B91C1C", name: "Crimson" },
  { hex: "#9D174D", name: "Berry" },
  { hex: "#6D28D9", name: "Violet" },
  { hex: "#1F2937", name: "Graphite" },
];

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const PREFIX_RE = /^[A-Za-z0-9-]*$/;

export const builtinId = (kind: FileKind) => `builtin:${kind}`;
export const templateHref = (id: string) => `#/templates/${encodeURIComponent(id)}`;

/** Ordered sections with every key for the kind exactly once (unknown keys dropped, missing appended disabled). */
export function normalizeSections(kind: FileKind, sections: TemplateSection[]): TemplateSection[] {
  const valid = new Set(SECTION_KEYS[kind]);
  const seen = new Set<string>();
  const out: TemplateSection[] = [];
  for (const s of sections) {
    if (!valid.has(s.key) || seen.has(s.key)) continue;
    seen.add(s.key);
    out.push({ key: s.key, enabled: s.enabled });
  }
  for (const k of SECTION_KEYS[kind]) if (!seen.has(k)) out.push({ key: k, enabled: false });
  return out;
}

/** Strips server fields (the API schema is strict) and normalizes sections. */
export function toInput(t: DocumentTemplate | TemplateInput): TemplateInput {
  return {
    kind: t.kind,
    name: t.name,
    theme: { ...t.theme },
    sections: normalizeSections(t.kind, t.sections),
    text: { ...t.text },
  };
}

export function sameInput(a: TemplateInput | null, b: TemplateInput | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type InputErrors = Partial<Record<"name" | "accentColor" | "invoicePrefix", string>>;

export function validateInput(t: TemplateInput): InputErrors {
  const e: InputErrors = {};
  if (!t.name.trim()) e.name = "Give the template a name.";
  if (!HEX_RE.test(t.theme.accentColor)) e.accentColor = "Use a #RRGGBB color.";
  if (!PREFIX_RE.test(t.text.invoicePrefix.trim())) e.invoicePrefix = "Letters, numbers and dashes only.";
  return e;
}

/** Small in-memory cache so thumbnails don't refetch on tab switches. */
const previewCache = new Map<string, Promise<DocModel>>();
export function cachedPreview(
  key: string,
  load: () => Promise<DocModel>,
): Promise<DocModel> {
  let p = previewCache.get(key);
  if (!p) {
    p = load();
    previewCache.set(key, p);
    p.catch(() => previewCache.delete(key));
    if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value as string);
  }
  return p;
}
