/**
 * buildDocModel: the ONE document model (blocks) rendered as HTML (UI preview)
 * and PDF (downloads / deliveries). Pure + deterministic: everything comes from
 * the bundle (frozen config + billing), attestations, the client snapshot, the
 * business profile and the template text. Never quotes transcript evidence beyond
 * the bundle's already-rendered document lines.
 *
 * Three documents, written as provider paperwork for a California Self-Determination
 * Program FMS (bill-payer model):
 *  - Invoice: letterhead, bill-to FMS, participant + UCI, authorization, service lines with
 *    per-task sub-lines (DDS minimums), DDS certification and signatures.
 *  - Session note: progress-note format. Statements drafted from the recorded visit carry
 *    discreet source markers [n] resolved in a "Sources" appendix; provider statements are
 *    tagged "Provider attestation".
 *  - Approval record: approval, checks, attestations, amendment history and data provenance.
 *    It is the ONLY document that names the transcription/AI provider, model, evidence mode
 *    or fixture provenance.
 */
import { FILE_LABELS, type FileKind } from "../contracts/v2";
import {
  SECTION_LABELS,
  missingProfileFields,
  type DocBlock,
  type DocLetterhead,
  type DocModel,
  type DocModelInput,
  type ProviderProfileInput,
} from "../contracts/v3";
import { CHECKLIST_GROUP_LABELS, parseClaimRejection } from "../contracts/schemas";
import type { ChecklistItem, DocumentLine, InvoiceDraft, InvoiceLine, ProviderAttestation, SessionBundle, SessionChecklist } from "../contracts/schemas";
import { clock, dateTimeInTz, longDate, minutesLabel, money, shortDate, timeRange, tzAbbr, utcStamp, ymdInTz } from "../artifacts/format";
import { fileNameForBundle } from "./names";
import { DEFAULT_ATTESTATION_STATEMENT, NOTE_ATTESTATION_STATEMENT, enabledSections } from "./templates";
import { REFUSED_PREFIX } from "../domain/documents";

/** Tag for statements that come from the provider, not from the recorded visit. */
export const PROVIDER_ATTESTATION_TAG = "Provider attestation";
/** @deprecated kept for older callers; documents now use PROVIDER_ATTESTATION_TAG. */
export const PROVIDER_CONFIRMED_TAG = PROVIDER_ATTESTATION_TAG;
/** @deprecated kept for older callers; documents now use PROVIDER_ATTESTATION_TAG. */
export const PROVIDER_WRITTEN_TAG = PROVIDER_ATTESTATION_TAG;
/** Provenance disclosure: shown on the approval record only. */
export const FIXTURE_BANNER = "SYNTHETIC / FIXTURE DATA — not a real visit";
export const DRAFT_BANNER = "DRAFT — not approved";
/** Watermark on every page of an invoice preview before approval. */
export const INVOICE_DRAFT_WATERMARK = "DRAFT — not for billing";
/** Watermark on the session note / approval record before approval. */
export const DRAFT_WATERMARK = "DRAFT — not approved";
export const SOURCES_HEADING = "Sources";
export const SOURCES_NOTE = "Sources: transcript excerpts on file. Each marker refers to the part of the recorded visit that supports the statement; the excerpts are kept with the provider's records for this visit.";

type KV = { label: string; value: string };
type Ctx = DocModelInput & {
  kind: FileKind;
  revision: number;
  approved: boolean;
  tz: string;
  profile: ProviderProfileInput | null;
  /** Evidence id → source marker number (session note). */
  refs: Map<string, number>;
};

const STATUS_LABEL: Record<"addressed" | "partially_addressed" | "unknown", string> = {
  addressed: "Addressed",
  partially_addressed: "Partially addressed",
  unknown: "Not addressed this visit",
};

/** SDP service names (DDS SDP code table, docs/research/self-determination-codes.md §1.2). */
const SDP_NAMES: Record<string, string> = {
  "310": "Respite",
  "313": "Homemaker",
  "314": "Housing Access Supports",
  "320": "Community Living Supports",
  "331": "Community Integration Supports",
  "334": "Individual Training and Education",
  "335": "Employment Supports",
  "336": "Technology Supports",
  "338": "Non-Medical Transportation",
  "339": "Prevocational Supports",
  "340": "Independent Facilitator",
  "360": "Communication Support",
  "363": "Crisis Intervention and Supports",
  "364": "Behavioral Intervention Services",
  "366": "Family/Consumer Training",
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

/** "320" from "CA-SDP-320" / "320"; null when not an SDP-style code. */
function sdpCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const m = /(?:^|[^0-9])(3\d{2})$/.exec(code.trim()) ?? /^(3\d{2})$/.exec(code.trim());
  return m ? m[1]! : null;
}

function serviceCodeOf(b: SessionBundle): string {
  const inv = b.billing.invoice;
  return inv?.sdpCode ?? sdpCode(b.config.context?.drive?.serviceCode) ?? sdpCode(b.appointment.serviceCode) ?? b.appointment.serviceCode;
}

function serviceCodeLabel(b: SessionBundle): string {
  const code = serviceCodeOf(b);
  const name = SDP_NAMES[code];
  return name ? `SDP ${code} — ${name}` : code;
}

function participantName(c: Ctx): string {
  return c.client?.displayName?.trim() || c.client?.preferredName?.trim() || c.bundle.appointment.clientRef;
}

/** "11/13/2026" in the appointment timezone. */
function mdy(iso: string, tz: string): string {
  const [y, m, d] = ymdInTz(iso, tz).split("-");
  return `${m}/${d}/${y}`;
}

function ymdToMdy(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ymd;
}

/** EVV time in / time out: the recorded span when the recording side knows it, else the calendar event. */
function visitSpan(b: SessionBundle): { from: string; to: string; source: "recording" | "calendar" } {
  const span = b.config.context?.recordingSpan;
  if (span && Number.isFinite(Date.parse(span.from)) && Number.isFinite(Date.parse(span.to))) return { ...span, source: "recording" };
  return { from: b.appointment.startAt, to: b.appointment.endAt, source: "calendar" };
}

function timeInOut(b: SessionBundle, tz: string): string {
  const s = visitSpan(b);
  return `${clock(s.from, tz)} – ${clock(s.to, tz)}`;
}

function latestAttestation(atts: ProviderAttestation[], field: ProviderAttestation["field"]): ProviderAttestation | null {
  let best: ProviderAttestation | null = null;
  for (const a of atts) {
    if (a.field !== field) continue;
    if (!best || a.bundleRevision > best.bundleRevision || (a.bundleRevision === best.bundleRevision && a.attestedAt >= best.attestedAt)) best = a;
  }
  return best;
}

// ------------------------------------------------------------------ business identity
function businessName(p: ProviderProfileInput | null): string | null {
  return has(p?.legalName) ? p.legalName.trim() : null;
}

function addressLines(p: ProviderProfileInput | null): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (has(p.addressLine1)) out.push(p.addressLine1.trim());
  if (has(p.addressLine2)) out.push(p.addressLine2.trim());
  const cityLine = [has(p.city) ? p.city.trim() : "", [p.state, p.postalCode].filter(has).join(" ")].filter(Boolean).join(", ");
  if (cityLine) out.push(cityLine);
  return out;
}

function letterhead(c: Ctx, meta: KV[]): DocLetterhead {
  const p = c.profile;
  const missing = missingProfileFields(p);
  const name = businessName(p) ?? "[Business name]";
  const lines: string[] = [];
  if (has(p?.dba)) lines.push(`DBA ${p.dba.trim()}`);
  const addr = addressLines(p);
  if (addr.length) lines.push(...addr);
  else lines.push("[Business address]");
  const contact = [p?.phone, p?.email].filter(has).join("  ·  ");
  if (contact) lines.push(contact);
  const ids = [`Vendor # ${has(p?.vendorNumber) ? p.vendorNumber.trim() : "[not set]"}`];
  if (has(p?.npi)) ids.push(`NPI ${p.npi}`);
  if (has(p?.taxIdLast4)) ids.push(`Tax ID ending ${p.taxIdLast4}`);
  lines.push(ids.join("  ·  "));
  if (missing.length) lines.push(`Complete Settings → Business profile (missing: ${missing.join(", ")})`);
  return { name, lines, logoDataUrl: p?.logoDataUrl ?? null, incomplete: missing.length > 0, meta };
}

function signerName(c: Ctx): string | null {
  return (has(c.profile?.signerName) ? c.profile.signerName.trim() : null) ?? businessName(c.profile) ?? c.providerIdentity;
}

function signatures(c: Ctx, defaultStatement: string): DocBlock {
  const t = c.template.text;
  const ap = c.approved ? c.approval : null;
  const signer = signerName(c);
  const participant = participantName(c);
  const rep = has(c.client?.representativeName) ? c.client.representativeName.trim() : null;
  const lines: { label: string; name?: string | null; signed?: string | null; date?: string | null }[] = [];
  const providerLabel = t.providerSignatureLabel || "Provider";
  lines.push({
    label: providerLabel === "Provider" ? "Provider signature" : providerLabel,
    name: [signer, businessName(c.profile) && signer !== businessName(c.profile) ? businessName(c.profile) : null].filter(has).join(", ") || null,
    signed: ap && signer ? `/s/ ${signer} — signed electronically ${shortDate(ap.approvedAt, c.tz)}, ${clock(ap.approvedAt, c.tz)} ${tzAbbr(ap.approvedAt, c.tz)}` : null,
    date: ap ? mdy(ap.approvedAt, c.tz) : null,
  });
  const partLabel = t.participantSignatureLabel || "Participant";
  lines.push({
    label: partLabel === "Participant" ? "Participant or authorized representative" : partLabel,
    name: rep ? `${rep}, authorized representative for ${participant}` : participant,
    signed: null,
    date: null,
  });
  if (has(t.representativeSignatureLabel)) lines.push({ label: t.representativeSignatureLabel, name: rep, signed: null, date: null });
  const statement = has(t.attestationStatement) ? t.attestationStatement : defaultStatement;
  return { type: "signatures", statement, lines };
}

// ------------------------------------------------------------------ professional phrasing of note lines
const PROVIDER_PREFIXES = [
  "Activity summary (provider-written, not evidence): ",
  "Goal addressed (provider-confirmed, not evidence): ",
  "Provider-confirmed (not evidence): ",
];

/** Cleans one bundle document line for the note: strips internal prefixes, tags provider statements, adds source markers. */
function noteItem(c: Ctx, l: DocumentLine): { text: string; tag?: string; refs?: number[] } {
  let text = l.text;
  let tag: string | undefined;
  if (text.startsWith(REFUSED_PREFIX)) {
    text = text.slice(REFUSED_PREFIX.length);
    tag = "Refused";
  }
  for (const p of PROVIDER_PREFIXES) {
    if (text.startsWith(p)) {
      text = (p.startsWith("Goal addressed") ? "Goal addressed: " : "") + text.slice(p.length);
      tag = PROVIDER_ATTESTATION_TAG;
    }
  }
  text = text.replace(/^Activity: /, "").replace(/^Observation: /, "Participant response: ").replace(/^Recorded only — not sent: /, "");
  if (l.origin === "provider_attestation") tag = PROVIDER_ATTESTATION_TAG;
  if (l.origin === "system_notice") tag = "Notice";
  const refs = l.origin === "extracted" ? [...new Set(l.evidenceIds.map((id) => c.refs.get(id)).filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b) : [];
  return { text, ...(tag ? { tag } : {}), ...(refs.length ? { refs } : {}) };
}

function noteList(c: Ctx, lines: DocumentLine[], empty: string | null): DocBlock[] {
  const shown = lines.filter((l) => l.origin !== "configuration");
  if (shown.length === 0) return empty ? [muted(empty)] : [];
  return [{ type: "list", items: shown.map((l) => noteItem(c, l)) }];
}

/** Assigns source markers [1..n] to evidence ids in reading order of the note sections. */
function registerRefs(b: SessionBundle, sectionsInOrder: string[]): Map<string, number> {
  const refs = new Map<string, number>();
  const keyFor: Record<string, string> = { session_note: "session_note", progress: "progress_record", follow_ups: "follow_ups" };
  const known = new Set(b.evidence.map((e) => e.id));
  for (const s of sectionsInOrder) {
    const k = keyFor[s];
    if (!k) continue;
    for (const l of sectionLines(b, k)) {
      if (l.origin !== "extracted") continue;
      for (const id of l.evidenceIds) if (known.has(id) && !refs.has(id)) refs.set(id, refs.size + 1);
    }
  }
  return refs;
}

function sourcesAppendix(c: Ctx): DocBlock[] {
  if (c.refs.size === 0) return [];
  const byId = new Map(c.bundle.evidence.map((e) => [e.id, e]));
  const items = [...c.refs.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => {
      const e = byId.get(id);
      const when =
        e?.observedFrom && Number.isFinite(Date.parse(e.observedFrom))
          ? e.observedTo && Number.isFinite(Date.parse(e.observedTo))
            ? `${clock(e.observedFrom, c.tz)} – ${clock(e.observedTo, c.tz)} ${tzAbbr(e.observedFrom, c.tz)}`
            : `${clock(e.observedFrom, c.tz)} ${tzAbbr(e.observedFrom, c.tz)}`
          : "time not recorded";
      return { text: `[${n}] Transcript excerpt, recorded ${when}, on file.` };
    });
  return [
    { type: "pagebreak" },
    { type: "heading", text: SOURCES_HEADING, section: "sources" },
    { type: "paragraph", text: SOURCES_NOTE, tone: "muted" },
    { type: "list", items },
  ];
}

// ------------------------------------------------------------------ participant direction
function participantDirection(c: Ctx, withRecorder: boolean): DocBlock[] {
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
  if (rec && withRecorder) items.push({ label: "Recorded by", value: `${rec.actorProviderId} · ${dateTimeInTz(rec.attestedAt, c.tz)} · rev r${rec.bundleRevision}` });
  else if (rec) items.push({ label: "Source", value: `${PROVIDER_ATTESTATION_TAG}, ${shortDate(rec.attestedAt, c.tz)}` });
  const blocks: DocBlock[] = [kv(items)];
  if (!d && !ch) blocks.push(muted("Participant direction was not recorded by the provider for this visit."));
  return blocks;
}

// ------------------------------------------------------------------ checklist (approval record)
const CHECK_TAG: Record<ChecklistItem["status"], string> = { pass: "Pass", warn: "Warn", fail: "Fail" };

function checklistBlocks(cl: SessionChecklist): DocBlock[] {
  const out: DocBlock[] = [
    {
      type: "paragraph",
      text: `Session checklist (${cl.version}): ${cl.summary.pass} pass, ${cl.summary.warn} warn, ${cl.summary.fail} fail. SDP code ${cl.sdpCode ?? "not recognised"}; EVV ${cl.evvRequired ? "required" : "not required"} for this code.`,
    },
  ];
  if (cl.rejectedClaims?.length) {
    out.push({
      type: "list",
      items: cl.rejectedClaims.map((r) => ({ text: `${r.claimId}: ${r.text.slice(0, 160)} — removed by provider: ${r.reason}`, tag: "Removed" })),
    });
  }
  for (const group of Object.keys(CHECKLIST_GROUP_LABELS) as ChecklistItem["group"][]) {
    const items = cl.items.filter((i) => i.group === group);
    if (items.length === 0) continue;
    out.push({
      type: "list",
      items: items.map((i) => ({
        text: `${CHECKLIST_GROUP_LABELS[group]} · ${i.label}${i.value ? `: ${i.value}` : ""} — ${i.detail}${i.blocksApproval ? " (blocks approval)" : ""}`,
        tag: CHECK_TAG[i.status],
      })),
    });
  }
  return out;
}

function documentationChecks(c: Ctx): DocBlock[] {
  const ch = c.bundle.checks;
  const out: DocBlock[] = [
    {
      type: "paragraph",
      text: `Rule version ${ch.ruleVersion}. ${ch.issues.length === 0 ? "No documentation issues recorded." : `${ch.issues.length} issue(s) recorded.`} Approval permitted by checks: ${ch.canApprove ? "yes" : "no"}.`,
    },
  ];
  if (ch.issues.length > 0) {
    out.push({ type: "list", items: ch.issues.map((i) => ({ text: `${i.message} (${i.field})`, tag: i.blocking ? "Blocking" : "Advisory" })) });
  }
  if (ch.checklist) out.push(...checklistBlocks(ch.checklist));
  out.push(
    muted(
      `${c.approved && c.final ? `Generated from approved revision r${c.revision}, finalized ${utcStamp(c.final.finalizedAt)}.` : `Generated from draft revision r${c.revision} (not approved).`} These checks confirm documentation fields are present; they are not a compliance, eligibility or billing determination.`,
    ),
  );
  return out;
}

// ------------------------------------------------------------------ session note
function sessionNoteSection(c: Ctx, key: string): DocBlock[] {
  const b = c.bundle;
  const a = b.appointment;
  const tz = c.tz;
  switch (key) {
    case "overview": {
      const items: KV[] = [
        { label: "Participant", value: participantName(c) },
        { label: "UCI #", value: has(c.client?.uciNumber) ? c.client.uciNumber : "Not on file" },
        { label: "Date of service", value: longDate(a.startAt, tz) },
        { label: "Time in – out", value: `${timeInOut(b, tz)} ${tzAbbr(a.startAt, tz)}` },
        { label: "Location", value: has(b.config.context?.location) ? b.config.context.location : "Not recorded" },
        { label: "Service", value: serviceCodeLabel(b) },
        { label: "Provider", value: businessName(c.profile) ?? c.providerIdentity ?? a.providerId },
        { label: "Staff", value: signerName(c) ?? a.providerId },
      ];
      const auth = authorizationNumber(c);
      if (auth) items.push({ label: "Authorization #", value: auth });
      items.push({ label: "Service description", value: b.config.plan.serviceDescription });
      return [kv(items, 2)];
    }
    case "plan_coverage": {
      if (b.documents.planCoverage.length === 0) return [muted("No plan goals on file.")];
      return [
        {
          type: "table",
          columns: [
            { label: "Goal (from the participant's plan)", width: 0.68 },
            { label: "This visit", width: 0.32 },
          ],
          rows: b.documents.planCoverage.map((g) => [
            g.objective,
            g.support === "provider_confirmed" ? `Addressed (${PROVIDER_ATTESTATION_TAG.toLowerCase()})` : STATUS_LABEL[g.status],
          ]),
        },
      ];
    }
    case "session_note":
      return noteList(c, sectionLines(b, "session_note"), "No activities recorded for this visit.");
    case "progress":
      return noteList(c, sectionLines(b, "progress_record"), "No progress statement recorded.");
    case "participant_direction":
      return participantDirection(c, false);
    case "follow_ups":
      return noteList(c, sectionLines(b, "follow_ups"), "No follow-up recorded.");
    case "missing_information": {
      const lines = sectionLines(b, "missing_information");
      return lines.length ? [{ type: "list", items: lines.map((l) => ({ text: l.text })) }] : [];
    }
    case "time_summary": {
      const t = b.documents.timeSummary;
      const items: KV[] = [{ label: "Scheduled", value: `${timeRange(t.scheduledFrom, t.scheduledTo, t.timezone)} (${t.scheduledMinutes} min)` }];
      const span = visitSpan(b);
      if (span.source === "recording") items.push({ label: "Recorded visit", value: timeRange(span.from, span.to, t.timezone) });
      items.push({
        label: "Duration of service",
        value: t.confirmedMinutes === null ? "Pending provider attestation" : `${t.confirmedMinutes} min (${PROVIDER_ATTESTATION_TAG.toLowerCase()})`,
      });
      return [kv(items)];
    }
    case "documentation_checks":
      return documentationChecks(c);
    case "signatures":
      return [signatures(c, NOTE_ATTESTATION_STATEMENT)];
    default:
      return [];
  }
}

// ------------------------------------------------------------------ invoice
function authorizationNumber(c: Ctx): string | null {
  if (has(c.client?.authorizationOverride)) return c.client.authorizationOverride.trim();
  const drive = c.bundle.billing.invoice?.authorization?.number ?? c.bundle.config.context?.drive?.authorization?.number;
  if (has(drive)) return drive.trim();
  return has(c.client?.authorizationNumber) ? c.client.authorizationNumber.trim() : null;
}

function invoiceNumberText(c: Ctx): string {
  return c.approved && has(c.invoiceNumber) ? c.invoiceNumber : "Assigned at approval";
}

function invoiceDate(c: Ctx): string {
  const at = c.approval?.approvedAt ?? c.final?.finalizedAt;
  return c.approved && at ? mdy(at, c.tz) : mdy(c.bundle.createdAt, c.tz);
}

/** Task text for an invoice sub-line (internal provenance wording replaced by professional labels). */
function taskText(l: InvoiceLine, serviceDescription: string): string {
  let t = l.taskDescription
    .replace(/\s*\((?:provider-confirmed|provider-written),\s*not evidence\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (l.source === "unallocated") t = "Other direct support during the visit";
  if (l.source === "configuration") t = serviceDescription;
  if (l.source === "provider_attestation") t = `${t} (per provider attestation)`;
  return t;
}

function serviceLinesTable(c: Ctx): DocBlock {
  const b = c.bundle;
  const tz = c.tz;
  const bill = b.billing;
  const inv: InvoiceDraft | undefined = bill.invoice;
  const rate = inv?.hourlyRateCents ?? bill.hourlyRateCents;
  const billedTotal = inv ? inv.rounding.billedMinutes : bill.confirmedMinutes;
  const minutes = billedTotal === null || billedTotal === undefined ? "Pending" : String(billedTotal);
  const date = inv ? ymdToMdy(inv.serviceDate) : mdy(b.appointment.startAt, tz);
  const code = serviceCodeOf(b);
  const desc = b.config.plan.serviceDescription;
  const columns = [
    { label: "Date", width: 0.11 },
    { label: "SDP code", width: 0.08 },
    { label: "Service description", width: 0.35 },
    { label: "Time in – out", width: 0.16 },
    { label: "Minutes", width: 0.09, align: "right" as const },
    { label: "Rate", width: 0.09, align: "right" as const },
    { label: "Amount", width: 0.12, align: "right" as const },
  ];
  const head = [date, code, desc, timeInOut(b, tz), minutes, `${money(rate)}/hr`];
  if (!inv || inv.lines.length === 0) {
    return { type: "table", columns, rows: [[...head, bill.amountCents === null ? "Pending" : money(bill.amountCents)]], rowKinds: ["item"] };
  }
  const rows: string[][] = [[...head, ""]];
  const kinds: ("item" | "sub")[] = ["item"];
  for (const l of inv.lines) {
    rows.push(["", "", taskText(l, desc), "", l.billedMinutes === null ? "Pending" : String(l.billedMinutes), "", l.amountCents === null ? "Pending" : money(l.amountCents)]);
    kinds.push("sub");
  }
  return { type: "table", columns, rows, rowKinds: kinds };
}

function splitAddress(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function invoiceSection(c: Ctx, key: string): DocBlock[] {
  const b = c.bundle;
  const tz = c.tz;
  const bill = b.billing;
  const snap = c.client;
  const inv = bill.invoice;
  switch (key) {
    case "bill_to": {
      const fms = has(snap?.fiscalIntermediary) ? snap.fiscalIntermediary.trim() : null;
      const billTo = [fms ?? "[FMS name — add it to the participant's record]"];
      if (has(snap?.fmsAddress)) billTo.push(...splitAddress(snap.fmsAddress));
      else billTo.push("[FMS address — add it to the participant's record]");
      billTo.push("Financial Management Services (bill payer)");
      const participant = [participantName(c), `UCI # ${has(snap?.uciNumber) ? snap.uciNumber.trim() : "[not on file]"}`];
      if (has(snap?.representativeName)) participant.push(`Authorized representative: ${snap.representativeName.trim()}`);
      const auth = authorizationNumber(c);
      const authLines = [`Authorization # ${auth ?? "[not on file]"}`];
      const a = inv?.authorization ?? null;
      if (a && has(a.validFrom) && has(a.validTo)) authLines.push(`Authorization period ${ymdToMdy(a.validFrom)} – ${ymdToMdy(a.validTo)}`);
      authLines.push(`Service period ${inv ? ymdToMdy(inv.serviceDate) : mdy(b.appointment.startAt, tz)}`);
      const funding = a?.fundingSource ?? snap?.fundingSource;
      if (has(funding)) authLines.push(`Funding: ${funding.trim()}`);
      return [
        {
          type: "parties",
          parties: [
            { label: "Bill to", lines: billTo },
            { label: "Participant", lines: participant },
            { label: "Spending plan / authorization", lines: authLines },
          ],
        },
      ];
    }
    case "funding_authorization": {
      const a = inv?.authorization;
      if (!a || a.authorizedMinutesPerMonth === null) return [];
      const items: KV[] = [{ label: "Authorized this month", value: minutesLabel(a.authorizedMinutesPerMonth) }];
      if (a.usedMinutesBeforeSession !== null) {
        items.push({ label: "Billed before this invoice", value: minutesLabel(a.usedMinutesBeforeSession) });
        if (a.remainingMinutesAfterSession !== null) items.push({ label: "Remaining after this invoice", value: minutesLabel(Math.max(0, a.remainingMinutesAfterSession)) });
      }
      return [kv(items, 2)];
    }
    case "service_lines":
      return [serviceLinesTable(c)];
    case "totals": {
      const total = inv ? inv.totalCents : bill.amountCents;
      const out: DocBlock[] = [
        {
          type: "totals",
          rows: [
            { label: "Subtotal", value: total === null ? "Pending" : money(total) },
            { label: `Total due (${bill.currency})`, value: total === null ? "Pending" : money(total), strong: true },
          ],
        },
      ];
      if (total === null) out.push(muted("The amount is completed when the provider attests the duration of service."));
      const rule = inv?.rounding.rule ?? "exact";
      if (rule !== "exact") {
        const label = rule === "nearest_15" ? "nearest 15 minutes" : rule === "floor_15" ? "15-minute increments (rounded down)" : "15-minute increments (rounded up)";
        out.push(muted(`Time billed to the ${label}, per the FMS billing rules.`));
      }
      return out;
    }
    case "participant_direction":
      return participantDirection(c, false);
    case "custom_fields": {
      const fields = (snap?.customFields ?? []).filter((f) => has(f.label));
      return fields.length ? [kv(fields.map((f) => ({ label: f.label, value: f.value || "—" })))] : [];
    }
    case "notes": {
      const t = c.template.text;
      const p = c.profile;
      const items: KV[] = [];
      const terms = has(p?.paymentTerms) ? p.paymentTerms : has(t.paymentTerms) ? t.paymentTerms : null;
      if (terms) items.push({ label: "Payment terms", value: terms.trim() });
      const remit = has(p?.remitTo) ? p.remitTo.trim() : [businessName(p), ...addressLines(p)].filter(has).join("\n");
      items.push({ label: "Remit to", value: remit || "[Remit-to address — complete Settings → Business profile]" });
      const contact = [p?.phone, p?.email].filter(has).join("  ·  ");
      if (contact) items.push({ label: "Billing questions", value: contact });
      const out: DocBlock[] = [kv(items)];
      if (has(t.invoiceNotes)) out.push({ type: "paragraph", text: t.invoiceNotes });
      return out;
    }
    case "signatures":
      return [signatures(c, DEFAULT_ATTESTATION_STATEMENT)];
    case "approval_reference": {
      const ap = c.approval;
      if (!c.approved || !ap) return [muted("Not yet approved.")];
      return [
        kv([
          { label: "Invoice #", value: invoiceNumberText(c) },
          { label: "Approved", value: dateTimeInTz(ap.approvedAt, tz) },
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
  goal_addressed: "Goal addressed (provider-confirmed, not evidence)",
  activity_summary: "Activity summary (provider-written, not evidence)",
  claim_rejected: "Statement removed by provider",
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
      if (has(c.invoiceNumber)) rows.push({ label: "Invoice number", value: c.invoiceNumber });
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
    case "checks":
      return documentationChecks(c);
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
                : att.field === "claim_rejected"
                  ? (() => {
                      const r = parseClaimRejection(att);
                      return r ? `${r.claimId} — removed by provider: ${r.reason}` : att.text;
                    })()
                  : att.text,
            att.actorProviderId,
            `${dateTimeInTz(att.attestedAt, tz)} · rev r${att.bundleRevision}`,
          ]),
        },
      ];
    case "amendments": {
      const list = c.superseded ?? [];
      const amendment = [...b.attestations].reverse().find((x) => x.field === "amendment_reason");
      if (list.length === 0 && !amendment) return [muted("No amendments — this is the original revision.")];
      const out: DocBlock[] = [];
      if (list.length) {
        out.push({
          type: "table",
          columns: [
            { label: "Revision", width: 0.12 },
            { label: "Approved / finalized", width: 0.24 },
            { label: "Superseded", width: 0.22 },
            { label: "Reason", width: 0.3 },
            { label: "Amount", width: 0.12, align: "right" },
          ],
          rows: list.map((s) => [
            `r${s.bundleRevision} → r${s.supersededByRevision}`,
            dateTimeInTz(s.finalizedAt, tz),
            dateTimeInTz(s.supersededAt, tz),
            s.reason,
            money(s.amountCents),
          ]),
        });
      } else if (amendment) {
        out.push(kv([{ label: "Amendment reason", value: amendment.text }]));
      }
      return out;
    }
    case "provenance": {
      const modeLabel = (m: string) => (m === "fixture" ? "FIXTURE (synthetic)" : m);
      const out: DocBlock[] = [];
      if (isFixtureBundle(b)) {
        out.push({
          type: "callout",
          tone: "fixture",
          text: `${FIXTURE_BANNER}\nEvidence mode: ${p.evidenceMode}. Extraction mode: ${p.extractionMode}. This document set was generated from synthetic test data and does not describe a real visit, client or claim.`,
        });
      }
      const rows: KV[] = [
        { label: "Evidence mode", value: modeLabel(p.evidenceMode) },
        { label: "Extraction mode", value: modeLabel(p.extractionMode) },
        { label: "Runtime mode", value: p.runtimeMode },
      ];
      if (p.drafter) rows.push({ label: "Drafted by", value: p.drafter.label });
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
      const span = visitSpan(b);
      rows.push({ label: "Time in – out source", value: span.source === "recording" ? "Recording span (EVV)" : "Calendar event" });
      if (b.evidenceWindow) rows.push({ label: "Evidence window (informational)", value: timeRange(b.evidenceWindow.from, b.evidenceWindow.to, tz) });
      const inv = b.billing.invoice;
      if (inv) {
        rows.push(
          { label: "Invoice rate source", value: `${inv.rateSource} (${inv.rateVersion})` },
          { label: "Invoice code source", value: inv.serviceCodeSource },
        );
      }
      out.push(kv(rows));
      if (inv?.notes.length) out.push({ type: "list", items: inv.notes.map((n) => ({ text: `Invoice: ${n}` })) });
      if (inv) out.push(muted(`${inv.attestationStatement} — ${inv.attestationLabel}.`));
      if (c.refs.size === 0) {
        const cited = new Set(b.evidence.map((e) => e.id));
        if (cited.size) out.push(muted(`Session note source markers [n] refer to ${cited.size} transcript segment(s) kept with this record.`));
      }
      return out;
    }
    case "signatures":
      return [signatures(c, DEFAULT_ATTESTATION_STATEMENT)];
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
  checks: "Checks passed — not a compliance determination",
};
/** Sections whose block carries its own labels (no section heading on paper). */
const NO_HEADING = new Set(["invoice:bill_to"]);

// ------------------------------------------------------------------ entry point
export function buildDocModel(kind: FileKind, input: DocModelInput): DocModel {
  const b = input.bundle;
  const a = b.appointment;
  const tz = a.timezone;
  const approved = input.final !== null;
  const revision = input.final?.bundleRevision ?? b.bundleRevision;
  const t = input.template;
  const sections = enabledSections(kind, t);
  const c: Ctx = {
    ...input,
    kind,
    revision,
    approved,
    tz,
    profile: input.profile ?? null,
    invoiceNumber: input.invoiceNumber ?? null,
    refs: kind === "session_note" ? registerRefs(b, sections) : new Map(),
  };
  const paperwork = kind !== "approval_record";
  const defaultTitle = kind === "invoice" ? "INVOICE" : kind === "session_note" ? "Session Note" : FILE_LABELS[kind];
  const title = has(t.text.title) ? t.text.title.trim() : defaultTitle;
  const fixture = isFixtureBundle(b);
  const participant = participantName(c);
  const business = businessName(c.profile);

  // Banner (footer strip): approval record only — the provenance document.
  const bannerParts: string[] = [];
  if (!paperwork && fixture) bannerParts.push(FIXTURE_BANNER);
  if (!paperwork && !approved) bannerParts.push(DRAFT_BANNER);

  const meta: KV[] = [];
  if (paperwork) {
    meta.push({ label: "Participant", value: participant }, { label: "Service date", value: mdy(a.startAt, tz) });
    if (kind === "invoice") meta.push({ label: "Invoice #", value: invoiceNumberText(c) });
  } else {
    meta.push({ label: "Client", value: a.clientRef });
    if (input.client?.preferredName?.trim()) meta.push({ label: "Preferred name", value: input.client.preferredName.trim() });
    meta.push(
      { label: "Service", value: a.serviceCode },
      { label: "Service date", value: longDate(a.startAt, tz) },
      { label: "Time", value: timeRange(a.startAt, a.endAt, tz) },
      { label: "Revision", value: `r${revision}${approved ? "" : " (draft)"}` },
    );
  }

  const blocks: DocBlock[] = [];
  if (!paperwork && !approved) {
    blocks.push({ type: "callout", tone: "draft", text: `${DRAFT_BANNER}\nThis is a preview of revision r${revision}. It has not been approved by the provider and may change.` });
  }
  // Amended revision: say that it replaces an earlier approved version and why (provider-entered text).
  const amendment = [...b.attestations].reverse().find((x) => x.field === "amendment_reason");
  if (amendment) {
    const what = kind === "invoice" ? "Corrected invoice" : kind === "session_note" ? "Amended note" : `Amended revision r${revision}`;
    const body =
      kind === "invoice"
        ? `This invoice replaces an invoice issued earlier for the same visit. Reason: ${amendment.text}`
        : `This version replaces a previously approved version. Reason: ${amendment.text}`;
    blocks.push({ type: "callout", tone: "warning", text: `${what}\n${body}` });
    meta.push({ label: "Amended", value: "Yes" });
  }

  for (const key of sections) {
    const body = SECTION_BUILDERS[kind](c, key);
    if (body.length === 0) continue;
    if (!NO_HEADING.has(`${kind}:${key}`)) blocks.push({ type: "heading", text: HEADING_TEXT[key] ?? SECTION_LABELS[key] ?? key, section: key });
    blocks.push(...body);
  }
  if (kind === "session_note") blocks.push(...sourcesAppendix(c));

  let lh: DocLetterhead | null = null;
  if (kind === "invoice") {
    const lhMeta: KV[] = [
      { label: "Invoice #", value: invoiceNumberText(c) },
      { label: "Invoice date", value: invoiceDate(c) },
      { label: "Service period", value: b.billing.invoice ? ymdToMdy(b.billing.invoice.serviceDate) : mdy(a.startAt, tz) },
    ];
    if (has(c.profile?.paymentTerms)) lhMeta.push({ label: "Terms", value: c.profile.paymentTerms.trim().slice(0, 40) });
    lh = letterhead(c, lhMeta);
  } else if (kind === "session_note") {
    lh = letterhead(c, [
      { label: "Participant", value: participant },
      { label: "Date of service", value: mdy(a.startAt, tz) },
      { label: "Service", value: serviceCodeLabel(b) },
    ]);
  }

  const logoText = lh ? lh.name : t.theme.logoText;
  let footerNote: string;
  let revisionLabel: string;
  if (kind === "invoice") {
    footerNote = has(t.theme.footerNote) ? t.theme.footerNote : [business, `Invoice # ${invoiceNumberText(c)}`].filter(has).join(" · ");
    revisionLabel = approved ? `Invoice # ${invoiceNumberText(c)}` : INVOICE_DRAFT_WATERMARK;
  } else if (kind === "session_note") {
    footerNote = has(t.theme.footerNote) ? t.theme.footerNote : [business, "Session note", participant, mdy(a.startAt, tz)].filter(has).join(" · ");
    revisionLabel = approved && input.approval ? `Signed electronically ${mdy(input.approval.approvedAt, tz)}` : "Draft — not signed";
  } else {
    footerNote = has(t.theme.footerNote) ? t.theme.footerNote : [t.theme.logoText, title, a.clientRef].filter(has).join(" · ");
    revisionLabel = approved ? `Approved revision r${revision}` : `Draft revision r${revision} — not approved`;
  }

  return {
    kind,
    templateId: t.id,
    title,
    filename: fileNameForBundle(kind, b, revision),
    theme: { ...t.theme },
    header: { logoText, headerNote: t.theme.headerNote, meta },
    footer: { note: footerNote, revisionLabel },
    banner: bannerParts.length ? bannerParts.join(" · ") : null,
    letterhead: lh,
    watermark: approved ? null : kind === "invoice" ? INVOICE_DRAFT_WATERMARK : DRAFT_WATERMARK,
    blocks,
  };
}
