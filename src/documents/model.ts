/**
 * buildDocModel: the ONE document model (blocks) rendered as HTML (UI preview)
 * and PDF (downloads / deliveries). Pure + deterministic: everything comes from
 * the bundle (frozen config + billing), attestations, the client snapshot and
 * the template text. Never quotes transcript evidence beyond the bundle's
 * already-rendered document lines.
 */
import { FILE_LABELS, type FileKind } from "../contracts/v2";
import { SECTION_LABELS, type DocBlock, type DocModel, type DocModelInput } from "../contracts/v3";
import type { DocumentLine, ProviderAttestation, SessionBundle } from "../contracts/schemas";
import { dateTimeInTz, longDate, minutesLabel, money, shortDate, timeRange, utcStamp } from "../artifacts/format";
import { fileNameForBundle, invoiceNumberFor } from "./names";
import { DEFAULT_ATTESTATION_STATEMENT, enabledSections } from "./templates";

export const FIXTURE_BANNER = "SYNTHETIC / FIXTURE DATA — not a real visit";
export const DRAFT_BANNER = "DRAFT — not approved";

type KV = { label: string; value: string };
type Ctx = DocModelInput & { kind: FileKind; revision: number; approved: boolean; tz: string };

const STATUS_LABEL: Record<"addressed" | "partially_addressed" | "unknown", string> = {
  addressed: "Addressed",
  partially_addressed: "Partially addressed",
  unknown: "Unknown — no supporting evidence",
};

const has = (s: string | null | undefined): s is string => typeof s === "string" && s.trim().length > 0;

export function isFixtureBundle(b: SessionBundle): boolean {
  return b.provenance.evidenceMode === "fixture" || b.provenance.extractionMode === "fixture";
}

function providerLabel(id: string, identity: string | null): string {
  return identity ? `${identity} (${id})` : id;
}

function sectionLines(b: SessionBundle, key: string): DocumentLine[] {
  return b.documents.sections.find((s) => s.key === key)?.lines ?? [];
}

const muted = (text: string): DocBlock => ({ type: "paragraph", text, tone: "muted" });
const kv = (items: KV[], columns?: 1 | 2): DocBlock => ({ type: "kv", items, ...(columns ? { columns } : {}) });

function lineList(lines: DocumentLine[], empty: string, tag?: (l: DocumentLine) => string | undefined): DocBlock[] {
  if (lines.length === 0) return [muted(empty)];
  return [
    {
      type: "list",
      items: lines.map((l) => {
        const t = tag?.(l) ?? (l.origin === "system_notice" ? "Notice" : undefined);
        return t ? { text: l.text, tag: t } : { text: l.text };
      }),
    },
  ];
}

/** Latest attestation for a field (highest revision, then latest time, then array order). */
function latestAttestation(atts: ProviderAttestation[], field: ProviderAttestation["field"]): ProviderAttestation | null {
  let best: ProviderAttestation | null = null;
  for (const a of atts) {
    if (a.field !== field) continue;
    if (!best || a.bundleRevision > best.bundleRevision || (a.bundleRevision === best.bundleRevision && a.attestedAt >= best.attestedAt)) best = a;
  }
  return best;
}

function participantDirection(c: Ctx): DocBlock[] {
  const atts = c.bundle.attestations;
  const d = latestAttestation(atts, "participant_direction");
  const ch = latestAttestation(atts, "participant_choices");
  let directed = "Not recorded";
  let rest = "";
  if (d) {
    const m = /^\s*(yes|no)\b[\s:;,.\-—–]*([\s\S]*)$/i.exec(d.text);
    if (m) {
      directed = m[1]?.toLowerCase() === "yes" ? "Yes — the participant directed the activities" : "No — the activities were not participant-directed";
      rest = (m[2] ?? "").trim();
    } else if (has(d.text)) {
      directed = d.text.trim();
    }
  }
  const choices = ch && has(ch.text) ? ch.text.trim() : rest || "Not recorded";
  const items: KV[] = [
    { label: "Participant directed", value: directed },
    { label: "Participant's choices", value: choices },
  ];
  const rec = [d, ch].filter((a): a is ProviderAttestation => a !== null).sort((a, b) => (a.attestedAt < b.attestedAt ? 1 : -1))[0];
  if (rec) items.push({ label: "Recorded by", value: `${rec.actorProviderId} · ${dateTimeInTz(rec.attestedAt, c.tz)} · rev r${rec.bundleRevision}` });
  const blocks: DocBlock[] = [kv(items)];
  if (!d && !ch) blocks.push(muted("Participant direction was not recorded by the provider for this revision."));
  return blocks;
}

function signatures(c: Ctx): DocBlock {
  const t = c.template.text;
  const lines: { label: string; name?: string | null }[] = [];
  const participantName = c.client?.preferredName || c.client?.displayName || null;
  lines.push({ label: t.participantSignatureLabel || "Participant", name: participantName });
  lines.push({ label: t.providerSignatureLabel || "Provider", name: c.providerIdentity });
  if (has(t.representativeSignatureLabel)) lines.push({ label: t.representativeSignatureLabel, name: null });
  const statement = has(t.attestationStatement) ? t.attestationStatement : DEFAULT_ATTESTATION_STATEMENT;
  return { type: "signatures", statement, lines };
}

function approvalSummary(c: Ctx): string {
  const ap = c.approval;
  if (!c.approved || !ap) return "Not approved — draft preview";
  return `Revision r${ap.bundleRevision} · ${dateTimeInTz(ap.approvedAt, c.tz)}`;
}

// ------------------------------------------------------------------ session note
function sessionNoteSection(c: Ctx, key: string): DocBlock[] {
  const b = c.bundle;
  const a = b.appointment;
  const tz = c.tz;
  switch (key) {
    case "overview": {
      const items: KV[] = [{ label: "Client reference", value: a.clientRef }];
      if (has(c.client?.displayName)) items.push({ label: "Client name", value: c.client.displayName });
      if (has(c.client?.preferredName)) items.push({ label: "Preferred name", value: c.client.preferredName });
      items.push(
        { label: "Service", value: `${a.serviceCode} — ${b.config.plan.serviceDescription}` },
        { label: "Service date", value: longDate(a.startAt, tz) },
        { label: "Scheduled time", value: timeRange(a.startAt, a.endAt, tz) },
        { label: "Provider", value: providerLabel(a.providerId, c.providerIdentity) },
        { label: "Plan version", value: a.planVersion },
        { label: "Approved", value: approvalSummary(c) },
      );
      return [kv(items)];
    }
    case "session_note":
      return lineList(sectionLines(b, "session_note"), "No session note content recorded.", (l) =>
        l.origin === "provider_attestation" ? (l.text.startsWith("Activity summary") ? "Provider written" : "Provider confirmed") : undefined,
      );
    case "progress":
      return lineList(sectionLines(b, "progress_record"), "No progress statement recorded.", (l) =>
        l.origin === "provider_attestation" || l.attestationIds.length > 0 ? "Provider confirmed" : undefined,
      );
    case "participant_direction":
      return participantDirection(c);
    case "plan_coverage":
      if (b.documents.planCoverage.length === 0) return [muted("No plan goals configured.")];
      return [
        {
          type: "table",
          columns: [
            { label: "Goal", width: 0.18 },
            { label: "Objective", width: 0.44 },
            { label: "Status", width: 0.38 },
          ],
          rows: b.documents.planCoverage.map((g) => [
            g.goalId,
            g.objective,
            g.support === "provider_confirmed" ? "Addressed (provider confirmed)" : STATUS_LABEL[g.status],
          ]),
        },
      ];
    case "follow_ups":
      return [muted("Recorded only — not sent."), ...lineList(sectionLines(b, "follow_ups"), "No follow-ups recorded.")];
    case "missing_information":
      return lineList(sectionLines(b, "missing_information"), "No missing information noted.", () => undefined);
    case "time_summary": {
      const t = b.documents.timeSummary;
      const evidence =
        t.evidenceWindowFrom && t.evidenceWindowTo
          ? `${timeRange(t.evidenceWindowFrom, t.evidenceWindowTo, t.timezone)} (${minutesLabel(t.evidenceWindowMinutes)}) — informational only, not billable`
          : "No evidence window — informational only";
      return [
        kv([
          { label: "Scheduled", value: `${timeRange(t.scheduledFrom, t.scheduledTo, t.timezone)} (${minutesLabel(t.scheduledMinutes)})` },
          { label: "Evidence window (informational)", value: evidence },
          {
            label: "Confirmed duration",
            value: t.confirmedMinutes === null ? "Not confirmed by provider" : `${minutesLabel(t.confirmedMinutes)} — provider confirmed`,
          },
        ]),
      ];
    }
    case "documentation_checks": {
      const ch = b.checks;
      const out: DocBlock[] = [
        {
          type: "paragraph",
          text: `Rule version ${ch.ruleVersion}. ${ch.issues.length === 0 ? "No documentation issues recorded." : `${ch.issues.length} issue(s) recorded.`} Approval permitted by checks: ${ch.canApprove ? "yes" : "no"}.`,
        },
      ];
      if (ch.issues.length > 0) {
        out.push({ type: "list", items: ch.issues.map((i) => ({ text: `${i.message} (${i.field})`, tag: i.blocking ? "Blocking" : "Advisory" })) });
      }
      out.push(
        muted(
          `${c.approved && c.final ? `Generated from approved revision r${c.revision}, finalized ${utcStamp(c.final.finalizedAt)}.` : `Generated from draft revision r${c.revision} (not approved).`} These checks confirm documentation fields are present; they are not a compliance, eligibility or billing determination.`,
        ),
      );
      return out;
    }
    case "signatures":
      return [signatures(c)];
    default:
      return [];
  }
}

// ------------------------------------------------------------------ invoice
function invoiceSection(c: Ctx, key: string): DocBlock[] {
  const b = c.bundle;
  const a = b.appointment;
  const tz = c.tz;
  const bill = b.billing;
  const snap = c.client;
  switch (key) {
    case "bill_to": {
      const items: KV[] = [{ label: "Client reference", value: a.clientRef }];
      if (has(snap?.displayName)) items.push({ label: "Client name", value: snap.displayName });
      if (has(snap?.preferredName)) items.push({ label: "Preferred name", value: snap.preferredName });
      if (!has(snap?.displayName) && !has(snap?.preferredName)) items.push({ label: "Details", value: "Client reference only — no personal details" });
      items.push(
        { label: "Plan", value: a.planVersion },
        { label: "Invoice number", value: invoiceNumberFor(b.sessionId, c.revision, c.template.text.invoicePrefix) },
        { label: "Invoice date", value: shortDate(c.final?.finalizedAt ?? b.createdAt, tz) },
        { label: "Service date", value: shortDate(a.startAt, tz) },
        { label: c.approved ? "Approved revision" : "Draft revision", value: `r${c.revision}` },
        { label: "Status", value: c.approved ? "Approved — not submitted" : "Draft — not approved" },
      );
      return [kv(items, 2)];
    }
    case "funding_authorization": {
      const items: KV[] = [];
      if (snap) {
        if (has(snap.fundingSource)) items.push({ label: "Funding source", value: snap.fundingSource });
        if (has(snap.authorizationNumber)) items.push({ label: "Authorization #", value: snap.authorizationNumber });
        if (has(snap.fiscalIntermediary)) items.push({ label: "Fiscal intermediary", value: snap.fiscalIntermediary });
        if (snap.authorizedHours !== null && snap.authorizedHours !== undefined) items.push({ label: "Authorized hours", value: `${snap.authorizedHours} h (current period)` });
        if (has(snap.caseManager)) items.push({ label: "Case manager", value: snap.caseManager });
      }
      return items.length ? [kv(items)] : [muted("No funding details on file")];
    }
    case "service_lines": {
      const minutes = bill.confirmedMinutes;
      return [
        {
          type: "table",
          columns: [
            { label: "Date", width: 0.15 },
            { label: "Service", width: 0.38 },
            { label: "Minutes", width: 0.13, align: "right" },
            { label: "Hourly rate", width: 0.16, align: "right" },
            { label: "Amount", width: 0.18, align: "right" },
          ],
          rows: [
            [
              `${shortDate(a.startAt, tz)}`,
              `${a.serviceCode} — ${b.config.plan.serviceDescription}`,
              minutes === null ? "—" : String(minutes),
              money(bill.hourlyRateCents),
              money(bill.amountCents),
            ],
          ],
        },
      ];
    }
    case "totals": {
      const out: DocBlock[] = [
        {
          type: "totals",
          rows: [
            { label: "Subtotal", value: money(bill.amountCents) },
            { label: `Total (${bill.currency})`, value: money(bill.amountCents), strong: true },
          ],
        },
      ];
      if (bill.amountCents === null) {
        out.push({ type: "callout", tone: "warning", text: "Amount not established\nConfirmed duration is missing, so no amount can be stated." });
      }
      out.push(
        kv([
          { label: "Rate version", value: bill.rateVersion },
          { label: "Confirmed minutes", value: bill.confirmedMinutes === null ? "Not confirmed" : `${minutesLabel(bill.confirmedMinutes)} — provider confirmed` },
          { label: "Calculation", value: bill.breakdown },
          { label: "Rounding", value: "Rounded half-up to the nearest cent." },
          { label: "Taxes", value: "None applied." },
        ]),
        muted("Billable time is the provider-confirmed duration only. The evidence window and scheduled time are informational and are never billed."),
      );
      return out;
    }
    case "participant_direction":
      return participantDirection(c);
    case "custom_fields": {
      const fields = (snap?.customFields ?? []).filter((f) => has(f.label));
      return fields.length ? [kv(fields.map((f) => ({ label: f.label, value: f.value || "—" })))] : [muted("No custom fields on file")];
    }
    case "notes": {
      const t = c.template.text;
      const out: DocBlock[] = [];
      if (has(t.paymentTerms)) out.push({ type: "paragraph", text: `Payment terms: ${t.paymentTerms}` });
      if (has(t.invoiceNotes)) out.push({ type: "paragraph", text: t.invoiceNotes });
      return out.length ? out : [muted("No notes.")];
    }
    case "signatures":
      return [signatures(c)];
    case "approval_reference": {
      const ap = c.approval;
      if (!c.approved || !ap) return [muted("Not yet approved — this is a draft preview.")];
      return [
        kv([
          { label: "Approval ID", value: ap.id },
          { label: "Approved revision", value: `r${ap.bundleRevision}` },
          { label: "Approved at", value: `${utcStamp(ap.approvedAt)} · ${dateTimeInTz(ap.approvedAt, tz)}` },
        ]),
      ];
    }
    default:
      return [];
  }
}

// ------------------------------------------------------------------ approval record
const ATTESTATION_FIELD: Record<ProviderAttestation["field"], string> = {
  progress: "Progress",
  duration: "Duration",
  participant_direction: "Participant direction",
  participant_choices: "Participant choices",
  amendment_reason: "Amendment reason",
  goal_addressed: "Goal addressed (provider confirmed)",
  activity_summary: "Activity summary (provider written)",
};

function goalLabel(b: SessionBundle, goalId: string): string {
  const g = b.config.plan.goals.find((x) => x.goalId === goalId.trim());
  return g ? `${g.goalId} — ${g.objective}` : goalId;
}

function approvalSection(c: Ctx, key: string): DocBlock[] {
  const b = c.bundle;
  const tz = c.tz;
  const ap = c.approval;
  const p = b.provenance;
  switch (key) {
    case "approval": {
      if (!c.approved || !ap) {
        return [
          { type: "callout", tone: "draft", text: `Not approved\nRevision r${c.revision} has not been approved by the provider. This is a draft preview.` },
          kv([
            { label: "Session ID", value: b.sessionId },
            { label: "Draft revision", value: `r${c.revision}` },
          ]),
        ];
      }
      const rows: KV[] = [
        { label: "Approval ID", value: ap.id },
        { label: "Session ID", value: ap.sessionId },
        { label: "Approver provider ID", value: ap.approverProviderId },
      ];
      if (c.providerIdentity) rows.push({ label: "Approver identity", value: c.providerIdentity });
      rows.push(
        { label: "Approved revision", value: `r${ap.bundleRevision}` },
        { label: "Approved at (UTC)", value: utcStamp(ap.approvedAt) },
        { label: "Approved at (appointment time)", value: dateTimeInTz(ap.approvedAt, tz) },
      );
      if (c.final) rows.push({ label: "Finalized at", value: `${utcStamp(c.final.finalizedAt)} · ${dateTimeInTz(c.final.finalizedAt, tz)}` });
      rows.push(
        { label: "Finalization status", value: ap.finalizationStatus },
        { label: "Idempotency key", value: ap.idempotencyKey },
        { label: "Request fingerprint", value: ap.requestFingerprint },
      );
      return [
        {
          type: "callout",
          tone: "info",
          text: `Approved by ${providerLabel(ap.approverProviderId, c.providerIdentity)}\nRevision r${ap.bundleRevision} approved ${utcStamp(ap.approvedAt)}; finalization ${ap.finalizationStatus}.`,
        },
        kv(rows),
        muted("This record documents the provider's approval of the revision shown and how it was produced. It is not a compliance determination."),
      ];
    }
    case "attestations":
      if (b.attestations.length === 0) return [muted("No provider attestations recorded.")];
      return [
        {
          type: "table",
          columns: [
            { label: "Field", width: 0.17 },
            { label: "Attestation", width: 0.4 },
            { label: "Actor", width: 0.18 },
            { label: "Time", width: 0.25 },
          ],
          rows: b.attestations.map((att) => [
            ATTESTATION_FIELD[att.field] ?? att.field,
            att.field === "duration" && /^\d+$/.test(att.text)
              ? `${att.text} minutes confirmed`
              : att.field === "goal_addressed"
                ? goalLabel(b, att.text)
                : att.text,
            att.actorProviderId,
            `${dateTimeInTz(att.attestedAt, tz)} · rev r${att.bundleRevision}`,
          ]),
        },
      ];
    case "provenance": {
      const modeLabel = (m: string) => (m === "fixture" ? "FIXTURE (synthetic)" : m);
      const rows: KV[] = [
        { label: "Evidence mode", value: modeLabel(p.evidenceMode) },
        { label: "Extraction mode", value: modeLabel(p.extractionMode) },
        { label: "Runtime mode", value: p.runtimeMode },
      ];
      if (p.aiProvider) rows.push({ label: "AI provider", value: p.aiProvider });
      rows.push(
        { label: "Model", value: p.model ?? "None (no model used)" },
        { label: "Prompt version", value: p.promptVersion },
        { label: "Schema version", value: p.schemaVersion },
        { label: "Evidence completeness", value: p.evidenceCompleteness },
      );
      if (p.privacy) {
        const counts = Object.entries(p.privacy.findings)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}: ${n}`)
          .join(", ");
        rows.push({ label: "Privacy scrubbing", value: `${p.privacy.scrubbed ? "Applied" : "Not applied"} — ${counts || "no findings"} (counts only)` });
      }
      rows.push({ label: "Evidence warnings", value: p.evidenceWarnings.length ? p.evidenceWarnings.join("; ") : "None" });
      return [kv(rows)];
    }
    case "signatures":
      return [signatures(c)];
    default:
      return [];
  }
}

const SECTION_BUILDERS: Record<FileKind, (c: Ctx, key: string) => DocBlock[]> = {
  session_note: sessionNoteSection,
  invoice: invoiceSection,
  approval_record: approvalSection,
};

const HEADING_TEXT: Partial<Record<string, string>> = {
  documentation_checks: "Documentation checks — not a compliance determination",
};

// ------------------------------------------------------------------ entry point
export function buildDocModel(kind: FileKind, input: DocModelInput): DocModel {
  const b = input.bundle;
  const a = b.appointment;
  const tz = a.timezone;
  const approved = input.final !== null;
  const revision = input.final?.bundleRevision ?? b.bundleRevision;
  const c: Ctx = { ...input, kind, revision, approved, tz };
  const t = input.template;
  const title = has(t.text.title) ? t.text.title.trim() : FILE_LABELS[kind];
  const fixture = isFixtureBundle(b);

  const bannerParts: string[] = [];
  if (fixture) bannerParts.push(FIXTURE_BANNER);
  if (!approved) bannerParts.push(DRAFT_BANNER);

  const meta: KV[] = [{ label: "Client", value: a.clientRef }];
  if (has(input.client?.preferredName)) meta.push({ label: "Preferred name", value: input.client.preferredName });
  meta.push(
    { label: "Service", value: a.serviceCode },
    { label: "Service date", value: longDate(a.startAt, tz) },
    { label: "Time", value: timeRange(a.startAt, a.endAt, tz) },
    { label: "Revision", value: `r${revision}${approved ? "" : " (draft)"}` },
  );
  if (kind === "invoice") meta.push({ label: "Invoice #", value: invoiceNumberFor(b.sessionId, revision, t.text.invoicePrefix) });

  const blocks: DocBlock[] = [];
  if (fixture) {
    blocks.push({
      type: "callout",
      tone: "fixture",
      text: `${FIXTURE_BANNER}\nEvidence mode: ${b.provenance.evidenceMode}. Extraction mode: ${b.provenance.extractionMode}. This document was generated from synthetic test data and does not describe a real visit, client or claim.`,
    });
  }
  if (!approved) {
    blocks.push({
      type: "callout",
      tone: "draft",
      text: `${DRAFT_BANNER}\nThis is a preview of revision r${revision}. It has not been approved by the provider and may change.`,
    });
  }
  // Amended revision: say which approved revision it replaces and why (reason is provider-entered text).
  const amendment = [...b.attestations].reverse().find((x) => x.field === "amendment_reason");
  if (amendment) {
    blocks.push({
      type: "callout",
      tone: "warning",
      text: `Amended revision r${revision}\nThis revision replaces a previously approved revision. Reason: ${amendment.text}`,
    });
    meta.push({ label: "Amended", value: "Yes" });
  }
  if (kind === "invoice") {
    blocks.push({
      type: "callout",
      tone: "info",
      text: "Draft invoice — no payment requested or submitted\nThis invoice is generated for the provider's records. It has not been sent to a payer, and no claim or payment request has been made.",
    });
  }

  for (const key of enabledSections(kind, t)) {
    const body = SECTION_BUILDERS[kind](c, key);
    if (body.length === 0) continue;
    blocks.push({ type: "heading", text: HEADING_TEXT[key] ?? SECTION_LABELS[key] ?? key, section: key });
    blocks.push(...body);
  }

  const logoText = t.theme.logoText;
  return {
    kind,
    templateId: t.id,
    title,
    filename: fileNameForBundle(kind, b, revision),
    theme: { ...t.theme },
    header: { logoText, headerNote: t.theme.headerNote, meta },
    footer: {
      note: has(t.theme.footerNote) ? t.theme.footerNote : [logoText, title, a.clientRef].filter(has).join(" · "),
      revisionLabel: approved ? `Approved revision r${revision}` : `Draft revision r${revision} — not approved`,
    },
    banner: bannerParts.length ? bannerParts.join(" · ") : null,
    blocks,
  };
}
