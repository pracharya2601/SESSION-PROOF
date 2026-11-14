/**
 * v3 documents (W2): templates → one DocModel → HTML preview (UI) / PDF (server).
 * Pure parts (templates, model, names) don't import pdf-lib; render does.
 */
export { BUILTIN_TEMPLATES, DEFAULT_THEME, DEFAULT_TEXT, defaultSections, enabledSections, normalizeTemplate } from "./templates";
export { buildDocModel, isFixtureBundle, FIXTURE_BANNER, DRAFT_BANNER } from "./model";
export { renderDocModelPdf } from "./render";
export { sampleDocModelInput } from "./sample";
export { fileNameForBundle, invoiceNumberFor, sanitizeFileName } from "./names";
