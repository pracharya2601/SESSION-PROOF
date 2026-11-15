/**
 * One structured checklist per session (v4). Pure, deterministic, no clock.
 *
 * Groups: DDS invoice minimums · plan documentation · consent · EVV (when the code requires it) ·
 * time check. Each item says pass / warn / fail, what value was found and where it came from.
 * Items that mirror a blocking documentation check say so (blocksApproval); every other item is
 * guidance for the invoice/EVV record and never blocks approval by itself.
 * Not a compliance determination.
 */
import {
  SessionChecklist,
  type Appointment,
  type ChecklistItem,
  type DocumentationIssue,
  type InvoiceDraft,
  type ProviderAttestation,
  type ServiceConfig,
  type SessionFacts,
} from "../../contracts/schemas";
import { ISSUE_CODES, PROVIDER_CONFIRMED_LABEL } from "./index";

export const CHECKLIST_VERSION = "checklist-v1";

/** SDP codes on DDS's EVV list (PCS: 310, 313, 320; HHCS: 359, 361, 372, 375, 376). */
export const EVV_SDP_CODES = new Set(["310", "313", "320", "359", "361", "372", "375", "376"]);
/** Warn when billed minutes exceed the recorded span by more than this fraction. */
export const TIME_TOLERANCE = 0.1;

export interface ChecklistInput {
  appointment: Appointment;
  config: ServiceConfig;
  facts: SessionFacts;
  attestations: ProviderAttestation[];
  issues: DocumentationIssue[];
  invoice: InvoiceDraft;
  evidenceWindow: { from: string; to: string } | null;
  confirmedMinutes: number | null;
  /** Claims the provider removed (from claim_rejected attestations). */
  rejectedClaims?: { claimId: string; text: string; reason: string; attestationId: string }[];
}

const money = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

function localTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}

export function buildChecklist(input: ChecklistInput): SessionChecklist {
  const { appointment: a, config, facts, attestations, issues, invoice, confirmedMinutes } = input;
  const ctx = config.context;
  const tz = a.timezone;
  const blocking = new Set(issues.filter((i) => i.blocking).map((i) => i.code));
  const items: ChecklistItem[] = [];
  const add = (i: ChecklistItem) => items.push(i);

  // ------------------------------------------------ DDS invoice minimums
  const dateOk = Number.isFinite(Date.parse(a.startAt));
  add({
    id: "invoice_date",
    group: "invoice_minimums",
    label: "Date of service",
    status: dateOk ? "pass" : "fail",
    value: dateOk ? invoice.serviceDate : null,
    detail: dateOk ? "From the calendar event." : "The calendar event has no readable start time.",
    source: "calendar",
    blocksApproval: blocking.has(ISSUE_CODES.MISSING_SERVICE_DATE),
  });
  const codeWarn = (ctx?.warnings ?? []).find((w) => w.startsWith("Service code differs"));
  add({
    id: "invoice_sdp_code",
    group: "invoice_minimums",
    label: "SDP service code",
    status: invoice.sdpCode === null ? "fail" : codeWarn ? "warn" : "pass",
    value: invoice.sdpCode ?? invoice.serviceCode,
    detail:
      invoice.sdpCode === null
        ? `"${invoice.serviceCode}" is not a recognisable SDP code (310–399). Check the authorization or spending plan.`
        : codeWarn ?? `From the ${invoice.serviceCodeSource === "drive" ? "Drive authorization / service plan" : "calendar event"}.`,
    source: invoice.serviceCodeSource === "drive" ? "drive" : "calendar",
    blocksApproval: false,
  });
  add({
    id: "invoice_rate",
    group: "invoice_minimums",
    label: "Rate",
    status: invoice.hourlyRateCents <= 0 ? "fail" : invoice.rateSource === "drive_authorization" ? "pass" : "warn",
    value: `${money(invoice.hourlyRateCents)}/hr`,
    detail:
      invoice.rateSource === "drive_authorization"
        ? `From authorization ${invoice.authorization?.number ?? ""} in Drive.`.replace(/\s+\./, ".")
        : invoice.rateSource === "client"
          ? "From the client record (no Drive authorization rate)."
          : "From the service configuration (no Drive authorization rate). Check it against the service agreement.",
    source: invoice.rateSource === "drive_authorization" ? "drive" : "configuration",
    blocksApproval: false,
  });
  const evidenceLines = invoice.lines.filter((l) => l.source === "evidence").length;
  const providerLines = invoice.lines.filter((l) => l.source === "provider_attestation").length;
  const taskOk = evidenceLines > 0 || providerLines > 0;
  add({
    id: "invoice_tasks",
    group: "invoice_minimums",
    label: "Description of each service/task",
    status: taskOk ? (evidenceLines > 0 ? "pass" : "warn") : "fail",
    value: `${invoice.lines.length} line(s)`,
    detail: taskOk
      ? evidenceLines > 0
        ? `${evidenceLines} task(s) drafted from cited transcript segments${providerLines ? `, ${providerLines} ${PROVIDER_CONFIRMED_LABEL.toLowerCase()}` : ""}.`
        : `Tasks come from the provider only (${PROVIDER_CONFIRMED_LABEL.toLowerCase()}).`
      : "No task is supported by the session evidence. Write an activity summary in your own words.",
    source: evidenceLines > 0 ? "evidence" : providerLines > 0 ? "provider_attestation" : null,
    blocksApproval: blocking.has(ISSUE_CODES.MISSING_SERVICE_DESCRIPTION),
  });
  const timed = invoice.lines.every((l) => l.billedMinutes !== null);
  add({
    id: "invoice_time_per_task",
    group: "invoice_minimums",
    label: "Time spent on each task",
    status: timed ? "pass" : "fail",
    value: timed ? invoice.lines.map((l) => `${l.billedMinutes} min`).join(" + ") : invoice.lines.map((l) => `~${l.estimatedMinutes} min`).join(" + "),
    detail: timed
      ? "Estimated from segment timing, scaled to the provider-confirmed minutes."
      : "Estimates only (from segment timing). Confirm the actual minutes to fix the time per task.",
    source: timed ? "provider_attestation" : "recording",
    blocksApproval: blocking.has(ISSUE_CODES.MISSING_CONFIRMED_DURATION),
  });
  add({
    id: "invoice_total",
    group: "invoice_minimums",
    label: "Total cost",
    status: invoice.totalCents === null ? "fail" : "pass",
    value: invoice.totalCents === null ? null : money(invoice.totalCents),
    detail:
      invoice.totalCents === null
        ? "No total until the provider confirms the duration (scheduled time is never billed)."
        : `${invoice.rounding.billedMinutes} min × ${money(invoice.hourlyRateCents)}/hr, rounded half-up to the cent (minute rule: ${invoice.rounding.rule}).`,
    source: "system",
    blocksApproval: blocking.has(ISSUE_CODES.MISSING_CONFIRMED_DURATION),
  });
  add({
    id: "invoice_services_statement",
    group: "invoice_minimums",
    label: "Statement that services were provided",
    status: "pass",
    value: invoice.attestationStatement,
    detail: `${PROVIDER_CONFIRMED_LABEL}: made by the provider when approving; it is not drawn from the transcript.`,
    source: "provider_attestation",
    blocksApproval: false,
  });

  // ------------------------------------------------ plan documentation
  const goals = config.plan.goals;
  const byEvidence = goals.filter((g) => {
    const gf = facts.goals.find((x) => x.goalId === g.goalId);
    return gf && gf.status !== "unknown" && gf.claims.some((c) => c.support === "supported" && c.evidenceIds.length > 0);
  }).length;
  const byProvider = goals.filter((g) => {
    const gf = facts.goals.find((x) => x.goalId === g.goalId);
    return gf && gf.claims.some((c) => c.support === "provider_confirmed") && !gf.claims.some((c) => c.support === "supported");
  }).length;
  add({
    id: "doc_goals_addressed",
    group: "documentation",
    label: "Plan goals addressed",
    status: blocking.has(ISSUE_CODES.NO_GOAL_ADDRESSED) ? "fail" : byEvidence + byProvider < goals.length ? "warn" : "pass",
    value: `${byEvidence + byProvider} of ${goals.length}`,
    detail: `${byEvidence} from cited evidence, ${byProvider} ${PROVIDER_CONFIRMED_LABEL.toLowerCase()}.${ctx?.drive ? " Goals from the Drive service plan." : ""}`,
    source: byEvidence > 0 ? "evidence" : byProvider > 0 ? "provider_attestation" : null,
    blocksApproval: blocking.has(ISSUE_CODES.NO_GOAL_ADDRESSED),
  });
  const evidenceProgress = facts.progress.some((c) => c.support === "supported" && c.evidenceIds.length > 0);
  const providerProgress = attestations.some((x) => x.field === "progress" && x.text.trim().length > 0);
  add({
    id: "doc_progress",
    group: "documentation",
    label: "Progress statement",
    status: blocking.has(ISSUE_CODES.MISSING_PROGRESS) ? "fail" : evidenceProgress ? "pass" : "warn",
    value: evidenceProgress ? "From evidence" : providerProgress ? PROVIDER_CONFIRMED_LABEL : null,
    detail: evidenceProgress
      ? "A cited segment states progress explicitly."
      : providerProgress
        ? `Progress is the provider's statement — ${PROVIDER_CONFIRMED_LABEL.toLowerCase()}.`
        : "The transcript states no progress; the drafter left it for the provider.",
    source: evidenceProgress ? "evidence" : providerProgress ? "provider_attestation" : null,
    blocksApproval: blocking.has(ISSUE_CODES.MISSING_PROGRESS),
  });
  add({
    id: "doc_duration",
    group: "documentation",
    label: "Session duration confirmed",
    status: confirmedMinutes === null ? "fail" : "pass",
    value: confirmedMinutes === null ? null : `${confirmedMinutes} min`,
    detail: confirmedMinutes === null ? "Enter the actual minutes; scheduled time is only an estimate." : `${PROVIDER_CONFIRMED_LABEL}.`,
    source: confirmedMinutes === null ? null : "provider_attestation",
    blocksApproval: blocking.has(ISSUE_CODES.MISSING_CONFIRMED_DURATION),
  });
  const refused = issues.filter((i) => i.code === ISSUE_CODES.CLAIM_EXCEEDS_EVIDENCE);
  const removed = input.rejectedClaims?.length ?? 0;
  add({
    id: "doc_claims_within_evidence",
    group: "documentation",
    label: "Claims stay within this session's evidence",
    status: refused.length > 0 ? "fail" : "pass",
    value: refused.length > 0 ? refused.map((i) => i.field.replace(/^claim:/, "")).join(", ") : null,
    detail:
      refused.length > 0
        ? `${refused.length} statement(s) refused: they generalise beyond what the cited segments say.`
        : `No statement asserts frequency, permanence or independence beyond its cited segments.${removed ? ` ${removed} statement(s) removed by the provider.` : ""}`,
    source: "evidence",
    blocksApproval: refused.length > 0,
  });

  // ------------------------------------------------ consent
  const consent = ctx?.consent ?? null;
  add({
    id: "consent_recorded",
    group: "consent",
    label: "Recording consent recorded",
    status: consent ? "pass" : "warn",
    value: consent ? `${consent.method} · ${consent.recordedAt}` : null,
    detail: consent
      ? `Stored by the recording${consent.confirmedBy ? ` (confirmed by ${consent.confirmedBy})` : ""}.`
      : "No consent record is stored with this session yet. Confirm everyone present agreed to the recording (California requires all-party consent).",
    source: consent ? "recording" : null,
    blocksApproval: false,
  });

  // ------------------------------------------------ EVV
  const evvRequired = invoice.sdpCode !== null && EVV_SDP_CODES.has(invoice.sdpCode);
  const span = ctx?.recordingSpan ?? input.evidenceWindow;
  if (evvRequired) {
    const evv = (id: string, label: string, value: string | null, source: ChecklistItem["source"], missing: string) =>
      add({ id, group: "evv", label, status: value ? "pass" : "fail", value, detail: value ? `From the ${source}.` : missing, source: value ? source : null, blocksApproval: false });
    evv("evv_service_type", "Type of service", invoice.sdpCode, "calendar", "No service code.");
    evv("evv_client_id", "Individual receiving the service (client id)", a.clientRef || null, "calendar", "No client reference on the event.");
    evv("evv_date", "Date of service", dateOk ? invoice.serviceDate : null, "calendar", "No readable date.");
    evv("evv_location", "Location of service", ctx?.location ?? null, "calendar", "The calendar event has no location. Add the service address to the event.");
    evv("evv_worker_id", "Individual providing the service (worker id)", ctx?.workerId ?? a.providerId ?? null, "calendar", "No worker id.");
    const scheduled = dateOk ? `${localTime(a.startAt, tz)}–${localTime(a.endAt, tz)} scheduled` : null;
    const recorded = span ? `${localTime(span.from, tz)}–${localTime(span.to, tz)} recorded` : null;
    add({
      id: "evv_start_end",
      group: "evv",
      label: "Time the service begins and ends",
      status: recorded ? "pass" : scheduled ? "warn" : "fail",
      value: [scheduled, recorded].filter(Boolean).join(" · ") || null,
      detail: recorded ? "Start/end from the calendar; actual span from the recording." : "Only the scheduled times are known; no recording span.",
      source: recorded ? "recording" : "calendar",
      blocksApproval: false,
    });
  } else {
    add({
      id: "evv_not_required",
      group: "evv",
      label: "EVV",
      status: "pass",
      value: invoice.sdpCode ?? invoice.serviceCode,
      detail: `Code ${invoice.sdpCode ?? invoice.serviceCode} is not on DDS's EVV list (310, 313, 320 PCS; 359–376 HHCS).`,
      source: "configuration",
      blocksApproval: false,
    });
  }

  // ------------------------------------------------ time
  const billed = invoice.rounding.billedMinutes;
  const recordedMinutes = span ? Math.max(0, (Date.parse(span.to) - Date.parse(span.from)) / 60_000) : null;
  const over = billed !== null && recordedMinutes !== null && billed > recordedMinutes * (1 + TIME_TOLERANCE);
  add({
    id: "time_billed_vs_recorded",
    group: "time",
    label: "Billed minutes vs recorded span",
    status: billed === null || recordedMinutes === null ? "warn" : over ? "warn" : "pass",
    value: `${billed === null ? "not confirmed" : `${billed} min billed`} · ${recordedMinutes === null ? "no recording" : `${Math.round(recordedMinutes)} min recorded`}`,
    detail:
      billed === null
        ? "Nothing to compare until the provider confirms the minutes."
        : recordedMinutes === null
          ? "No recording span to compare against."
          : over
            ? `Billed time is more than ${Math.round(TIME_TOLERANCE * 100)}% over the recorded span. Check the confirmed minutes (time off-mic is allowed but should be explainable).`
            : `Within ${Math.round(TIME_TOLERANCE * 100)}% of the recorded span.`,
    source: "recording",
    blocksApproval: false,
  });
  const auth = invoice.authorization;
  if (auth) {
    const rem = auth.remainingMinutesAfterSession;
    add({
      id: "time_authorization_remaining",
      group: "time",
      label: "Authorized minutes remaining this month",
      status: auth.serviceDateInRange === false || (rem !== null && rem < 0) ? "fail" : rem === null || auth.usedMinutesBeforeSession === null ? "warn" : "pass",
      value: rem === null ? "No monthly limit on the authorization" : `${rem} of ${auth.authorizedMinutesPerMonth} min`,
      detail:
        auth.serviceDateInRange === false
          ? `The service date is outside authorization ${auth.number} (${auth.validFrom} to ${auth.validTo}).`
          : rem !== null && rem < 0
            ? `This session exceeds authorization ${auth.number} by ${-rem} min this month.`
            : auth.usedMinutesBeforeSession === null
              ? `Authorization ${auth.number}: earlier use this month is unknown, so this assumes none.`
              : `Authorization ${auth.number} (${auth.fundingSource}).`,
      source: "drive",
      blocksApproval: false,
    });
  } else {
    add({
      id: "time_authorization_remaining",
      group: "time",
      label: "Authorized minutes remaining this month",
      status: "warn",
      value: null,
      detail: "No authorization document in Drive for this client.",
      source: null,
      blocksApproval: false,
    });
  }

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const i of items) summary[i.status]++;
  const rejectedClaims = (input.rejectedClaims ?? []).slice(0, 50);
  return SessionChecklist.parse({
    version: CHECKLIST_VERSION,
    sdpCode: invoice.sdpCode,
    evvRequired,
    items,
    ...(rejectedClaims.length > 0 ? { rejectedClaims } : {}),
    summary,
  });
}
