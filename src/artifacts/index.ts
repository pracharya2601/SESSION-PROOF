/**
 * v2 artifacts API (kept for callers): the three PDFs every COMPLETED session
 * produces — session note, invoice, approval record. Since v3 these are
 * rendered through the shared document model (src/documents) using the
 * built-in templates and no client snapshot.
 */
import { FILE_LABELS, type FileKind, type SessionFile } from "../contracts/v2";
import type { ApprovalRecord, FinalBundle } from "../contracts/schemas";
import { BUILTIN_TEMPLATES } from "../documents/templates";
import { buildDocModel } from "../documents/model";
import { renderDocModelPdf } from "../documents/render";
import { fileNameForBundle, invoiceNumberFor } from "../documents/names";

export { toWinAnsi, toWinAnsiMultiline } from "./winansi";
export { APP_NAME, FIXTURE_BANNER } from "./layout";

export type ArtifactInput = { final: FinalBundle; approval: ApprovalRecord; providerIdentity: string | null };

export function fileNameFor(kind: FileKind, final: FinalBundle): string {
  return fileNameForBundle(kind, final.bundle, final.bundleRevision);
}

export function sessionFiles(sessionId: string, final: FinalBundle): SessionFile[] {
  return (["session_note", "invoice", "approval_record"] as const).map((kind) => ({
    kind,
    label: FILE_LABELS[kind],
    filename: fileNameFor(kind, final),
    contentType: "application/pdf" as const,
    downloadUrl: `/api/sessions/${encodeURIComponent(sessionId)}/files/${kind}`,
  }));
}

/** Deterministic display invoice number (no PII): INV-<hash(sessionId)>-R<rev>. */
export function invoiceNumber(final: FinalBundle): string {
  return invoiceNumberFor(final.sessionId, final.bundleRevision, "INV");
}

export async function renderFilePdf(kind: FileKind, input: ArtifactInput): Promise<Uint8Array> {
  const model = buildDocModel(kind, {
    bundle: input.final.bundle,
    final: input.final,
    approval: input.approval,
    providerIdentity: input.providerIdentity,
    client: null,
    template: BUILTIN_TEMPLATES[kind],
  });
  return renderDocModelPdf(model);
}
