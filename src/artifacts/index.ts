/**
 * v2 artifacts (V4): the three print-ready Letter PDFs every COMPLETED session
 * produces — session note, draft invoice, approval record. Rendered ONLY from
 * the immutable FinalBundle + ApprovalRecord. pdf-lib StandardFonts (Workers-safe).
 */
import { FILE_LABELS, type FileKind, type SessionFile } from "../contracts/v2";
import type { ApprovalRecord, DocumentLine, FinalBundle } from "../contracts/schemas";
import {
  clock,
  dateTimeInTz,
  fnv1a,
  longDate,
  minutesLabel,
  money,
  shortDate,
  timeRange,
  utcStamp,
  ymdInTz,
} from "./format";
import { APP_NAME, C, PdfWriter, type Tone } from "./layout";

export { toWinAnsi, toWinAnsiMultiline } from "./winansi";
export { APP_NAME, FIXTURE_BANNER } from "./layout";

export type ArtifactInput = { final: FinalBundle; approval: ApprovalRecord; providerIdentity: string | null };

// ------------------------------------------------------------------ names + listing
const kebab = (kind: FileKind) => kind.replace(/_/g, "-");

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+/, "").slice(0, 200);
}

export function fileNameFor(kind: FileKind, final: FinalBundle): string {
  const a = final.bundle.appointment;
  const date = ymdInTz(a.startAt, a.timezone);
  return sanitizeFileName(`${a.clientRef}_${date}_${kebab(kind)}_r${final.bundleRevision}.pdf`);
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
  return `INV-${fnv1a(final.sessionId)}-R${final.bundleRevision}`;
}

// ------------------------------------------------------------------ rendering
export async function renderFilePdf(kind: FileKind, input: ArtifactInput): Promise<Uint8Array> {
  const w = await writerFor(kind, input);
  switch (kind) {
    case "session_note":
      renderSessionNote(w, input);
      break;
    case "invoice":
      renderInvoice(w, input);
      break;
    case "approval_record":
      renderApprovalRecord(w, input);
      break;
  }
  return w.finish();
}

function isFixture(final: FinalBundle): boolean {
  const p = final.bundle.provenance;
  return p.evidenceMode === "fixture" || p.extractionMode === "fixture";
}

function writerFor(kind: FileKind, { final }: ArtifactInput): Promise<PdfWriter> {
  const b = final.bundle;
  const a = b.appointment;
  const tz = a.timezone;
  const label = FILE_LABELS[kind];
  const p = b.provenance;
  const date = Number.isNaN(Date.parse(final.finalizedAt)) ? new Date(0) : new Date(final.finalizedAt);
  return PdfWriter.create({
    title: label,
    metaRows: [
      `Client ${a.clientRef}   |   Service ${a.serviceCode}   |   Revision r${final.bundleRevision}`,
      `${longDate(a.startAt, tz)}   |   ${timeRange(a.startAt, a.endAt, tz)}`,
    ],
    fixture: isFixture(final),
    fixtureDetail: `Evidence mode: ${p.evidenceMode}. Extraction mode: ${p.extractionMode}. This document was generated from synthetic test data and does not describe a real visit, client or claim.`,
    footerLeft: `${APP_NAME}  ·  ${label}  ·  ${a.clientRef}  ·  Approved revision r${final.bundleRevision}`,
    metadata: {
      title: `${label} — ${a.clientRef} — ${ymdInTz(a.startAt, tz)} (r${final.bundleRevision})`,
      subject: `${label} for client ${a.clientRef}, approved revision ${final.bundleRevision}`,
      keywords: [APP_NAME, label, a.clientRef, a.serviceCode, `r${final.bundleRevision}`],
      date,
    },
  });
}

const STATUS: Record<"addressed" | "partially_addressed" | "unknown", { text: string; color: typeof C.ink }> = {
  addressed: { text: "Addressed", color: C.green },
  partially_addressed: { text: "Partially addressed", color: C.amber },
  unknown: { text: "Unknown — no supporting evidence", color: C.muted },
};

function providerLabel(id: string, identity: string | null): string {
  return identity ? `${identity} (${id})` : id;
}

function sectionLines(input: ArtifactInput, key: string): DocumentLine[] {
  return input.final.bundle.documents.sections.find((s) => s.key === key)?.lines ?? [];
}

function lineBullets(w: PdfWriter, lines: DocumentLine[], empty: string, tag?: (l: DocumentLine) => { label: string; tone: Tone } | undefined) {
  if (lines.length === 0) {
    w.paragraph(empty, { font: "italic", color: C.muted });
    return;
  }
  for (const l of lines) {
    const notice = l.origin === "system_notice";
    w.bullet(l.text, { tag: tag?.(l), font: notice ? "italic" : "regular", color: notice ? C.muted : C.ink });
  }
}

// ------------------------------------------------------------------ session note
function renderSessionNote(w: PdfWriter, input: ArtifactInput) {
  const { final, approval, providerIdentity } = input;
  const b = final.bundle;
  const a = b.appointment;
  const tz = a.timezone;
  const t = b.documents.timeSummary;

  w.heading("Overview");
  w.keyValues([
    ["Client reference", a.clientRef],
    ["Service", `${a.serviceCode} — ${b.config.plan.serviceDescription}`],
    ["Service date", longDate(a.startAt, tz)],
    ["Scheduled time", timeRange(a.startAt, a.endAt, tz)],
    ["Provider", providerLabel(a.providerId, providerIdentity)],
    ["Plan version", a.planVersion],
    ["Approved", `Revision r${approval.bundleRevision} · ${dateTimeInTz(approval.approvedAt, tz)}`],
  ]);

  w.heading("Session note");
  lineBullets(w, sectionLines(input, "session_note"), "No session note content recorded.");

  w.heading("Progress record");
  lineBullets(w, sectionLines(input, "progress_record"), "No progress statement recorded.", (l) =>
    l.origin === "provider_attestation" || l.attestationIds.length > 0 ? { label: "Provider confirmed", tone: "accent" } : undefined,
  );

  w.heading("Plan coverage");
  if (b.documents.planCoverage.length === 0) {
    w.paragraph("No plan goals configured.", { font: "italic", color: C.muted });
  } else {
    w.table(
      [
        { header: "Goal", width: 0.18 },
        { header: "Objective", width: 0.44 },
        { header: "Status", width: 0.38 },
      ],
      b.documents.planCoverage.map((g) => {
        const s = STATUS[g.status];
        return [{ text: g.goalId, color: C.muted }, g.objective, { text: s.text, color: s.color, bold: true }];
      }),
    );
  }

  w.heading("Follow-ups", "Recorded only — not sent");
  lineBullets(w, sectionLines(input, "follow_ups"), "No follow-ups recorded.");

  w.heading("Missing information");
  lineBullets(w, sectionLines(input, "missing_information"), "No missing information noted.");

  w.heading("Time summary");
  const evidence =
    t.evidenceWindowFrom && t.evidenceWindowTo
      ? `${timeRange(t.evidenceWindowFrom, t.evidenceWindowTo, t.timezone)} (${minutesLabel(t.evidenceWindowMinutes)}) — informational only, not billable`
      : "No evidence window — informational only";
  w.keyValues([
    ["Scheduled", `${timeRange(t.scheduledFrom, t.scheduledTo, t.timezone)} (${minutesLabel(t.scheduledMinutes)})`],
    ["Evidence window (informational)", evidence],
    [
      "Confirmed duration",
      t.confirmedMinutes === null
        ? { text: "Not confirmed by provider", color: C.red, bold: true }
        : { text: `${minutesLabel(t.confirmedMinutes)} — provider confirmed`, bold: true },
    ],
  ], 0.36);

  w.heading("Documentation checks — not a compliance determination");
  const c = b.checks;
  w.paragraph(
    `Rule version ${c.ruleVersion}. ${c.issues.length === 0 ? "No documentation issues recorded." : `${c.issues.length} issue(s) recorded.`} Approval permitted by checks: ${c.canApprove ? "yes" : "no"}.`,
    { size: 9.5 },
  );
  for (const i of c.issues) {
    w.bullet(`${i.message} (${i.field})`, { tag: i.blocking ? { label: "Blocking", tone: "danger" } : { label: "Advisory", tone: "warning" } });
  }
  w.space(4);
  w.paragraph(
    `Generated from approved revision r${final.bundleRevision}, finalized ${utcStamp(final.finalizedAt)}. These checks confirm documentation fields are present; they are not a compliance, eligibility or billing determination.`,
    { size: 8, font: "italic", color: C.muted },
  );
}

// ------------------------------------------------------------------ invoice
function renderInvoice(w: PdfWriter, input: ArtifactInput) {
  const { final } = input;
  const b = final.bundle;
  const a = b.appointment;
  const tz = a.timezone;
  const bill = b.billing;
  const minutes = bill.confirmedMinutes;

  w.parties(
    { label: "Bill to", lines: [`Client ${a.clientRef}`, "Client reference only — no personal details", `Plan ${a.planVersion}`] },
    [
      ["Invoice number", invoiceNumber(final)],
      ["Invoice date", shortDate(final.finalizedAt, tz)],
      ["Service date", shortDate(a.startAt, tz)],
      ["Approved revision", `r${final.bundleRevision}`],
      ["Status", "Draft"],
    ],
  );

  w.callout(
    "Draft invoice — no payment requested or submitted",
    "This draft is generated for the provider's records. It has not been sent to a payer, and no claim or payment request has been made.",
    "info",
  );

  w.heading("Services");
  w.table(
    [
      { header: "Service", width: 0.38 },
      { header: "Date", width: 0.15 },
      { header: "Minutes", width: 0.13, align: "right" },
      { header: "Hourly rate", width: 0.16, align: "right" },
      { header: "Amount", width: 0.18, align: "right" },
    ],
    [
      [
        { text: `${a.serviceCode}\n${b.config.plan.serviceDescription}` },
        `${shortDate(a.startAt, tz)}\n${clock(a.startAt, tz)}`,
        minutes === null ? "—" : String(minutes),
        money(bill.hourlyRateCents),
        { text: money(bill.amountCents), bold: true },
      ],
    ],
    { size: 9.5 },
  );

  w.totals([
    { label: "Subtotal", value: money(bill.amountCents) },
    { label: `Total (${bill.currency})`, value: money(bill.amountCents), strong: true },
  ]);
  if (bill.amountCents === null) {
    w.callout("Amount not established", "Confirmed duration is missing, so no amount can be stated.", "warning");
  }

  w.heading("Billing details");
  w.keyValues([
    ["Rate version", bill.rateVersion],
    ["Confirmed minutes", minutes === null ? "Not confirmed" : `${minutesLabel(minutes)} — provider confirmed`],
    ["Calculation", bill.breakdown],
    ["Rounding", "Rounded half-up to the nearest cent."],
    ["Taxes", "None applied."],
  ]);
  w.paragraph(
    "Billable time is the provider-confirmed duration only. The evidence window and scheduled time are informational and are never billed.",
    { size: 8, font: "italic", color: C.muted },
  );
}

// ------------------------------------------------------------------ approval record
function renderApprovalRecord(w: PdfWriter, input: ArtifactInput) {
  const { final, approval, providerIdentity } = input;
  const b = final.bundle;
  const tz = b.appointment.timezone;
  const p = b.provenance;

  w.callout(
    `Approved by ${providerLabel(approval.approverProviderId, providerIdentity)}`,
    `Revision r${approval.bundleRevision} approved ${utcStamp(approval.approvedAt)}; finalization ${approval.finalizationStatus}.`,
    "success",
  );

  w.heading("Approval");
  const rows: [string, string][] = [
    ["Approval ID", approval.id],
    ["Session ID", approval.sessionId],
    ["Approver provider ID", approval.approverProviderId],
  ];
  if (providerIdentity) rows.push(["Approver identity", providerIdentity]);
  rows.push(
    ["Approved revision", `r${approval.bundleRevision}`],
    ["Approved at (UTC)", utcStamp(approval.approvedAt)],
    ["Approved at (appointment time)", dateTimeInTz(approval.approvedAt, tz)],
    ["Finalized at", `${utcStamp(final.finalizedAt)}  ·  ${dateTimeInTz(final.finalizedAt, tz)}`],
    ["Finalization status", approval.finalizationStatus],
    ["Idempotency key", approval.idempotencyKey],
    ["Request fingerprint", approval.requestFingerprint],
  );
  w.keyValues(rows, 0.34);

  w.heading("Provenance");
  const modeLabel = (m: string) => (m === "fixture" ? "FIXTURE (synthetic)" : m);
  const prov: [string, string][] = [
    ["Evidence mode", modeLabel(p.evidenceMode)],
    ["Extraction mode", modeLabel(p.extractionMode)],
    ["Runtime mode", p.runtimeMode],
  ];
  if (p.aiProvider) prov.push(["AI provider", p.aiProvider]);
  prov.push(
    ["Model", p.model ?? "None (no model used)"],
    ["Prompt version", p.promptVersion],
    ["Schema version", p.schemaVersion],
    ["Evidence completeness", p.evidenceCompleteness],
  );
  if (p.privacy) {
    const counts = Object.entries(p.privacy.findings)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ");
    prov.push(["Privacy scrubbing", `${p.privacy.scrubbed ? "Applied" : "Not applied"} — ${counts || "no findings"} (counts only)`]);
  }
  prov.push(["Evidence warnings", p.evidenceWarnings.length ? p.evidenceWarnings.join("; ") : "None"]);
  w.keyValues(prov, 0.34);

  w.heading("Provider attestations");
  if (b.attestations.length === 0) {
    w.paragraph("No provider attestations recorded.", { font: "italic", color: C.muted });
  } else {
    w.table(
      [
        { header: "Field", width: 0.13 },
        { header: "Attestation", width: 0.42 },
        { header: "Actor", width: 0.2 },
        { header: "Time", width: 0.25 },
      ],
      b.attestations.map((att) => [
        { text: att.field, bold: true },
        att.field === "duration" && /^\d+$/.test(att.text) ? `${att.text} minutes confirmed` : att.text,
        att.actorProviderId,
        `${dateTimeInTz(att.attestedAt, tz)}\nrev r${att.bundleRevision}`,
      ]),
    );
  }

  w.paragraph(
    "This record documents the provider's approval of the revision shown and how it was produced. It is not a compliance determination.",
    { size: 8, font: "italic", color: C.muted },
  );
}
