/**
 * v3 documents (W2): templates → one DocModel → HTML preview (UI) / PDF (server).
 * Pure parts (templates, model, names) don't import pdf-lib; render does.
 */
export {
  BUILTIN_TEMPLATES,
  DEFAULT_ATTESTATION_STATEMENT,
  DEFAULT_THEME,
  DEFAULT_TEXT,
  NOTE_ATTESTATION_STATEMENT,
  defaultSections,
  enabledSections,
  normalizeTemplate,
} from "./templates";
export {
  buildDocModel,
  isFixtureBundle,
  FIXTURE_BANNER,
  DRAFT_BANNER,
  DRAFT_WATERMARK,
  INVOICE_DRAFT_WATERMARK,
  PROVIDER_ATTESTATION_TAG,
  SOURCES_HEADING,
} from "./model";
export { docText } from "./text";
export { renderDocModelPdf } from "./render";
export { sampleDocModelInput, SAMPLE_PROFILE } from "./sample";
export { fileNameForBundle, invoiceNumberFor, sanitizeFileName } from "./names";
