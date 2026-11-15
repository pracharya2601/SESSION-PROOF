/**
 * Per-task invoice draft (v4). Pure, deterministic, integer-only money.
 *
 * Tasks come from the evidence-backed note: one line per plan goal with cited claims (plus the
 * activities citing the same segments), one per remaining activity, and — never as evidence — a
 * provider-confirmed goal or provider-written activity summary. Time per task is ESTIMATED from
 * transcript segment timing (segment start → next segment start) and then scaled so the lines add
 * up to the provider-confirmed (and rounded) minutes: the provider adjusts the total, the lines follow.
 * Amount per line is a largest-remainder share of the single total, so lines always sum to it.
 *
 * DDS SDP invoice minimums (docs/research/self-determination-codes.md §1.6): rate, SDP code, date,
 * task description, time per task, total, and the services-provided statement.
 */
import {
  InvoiceDraft,
  type Appointment,
  type EvidenceItem,
  type FactClaim,
  type InvoiceLine,
  type MinuteRounding,
  type ProviderAttestation,
  type ServiceConfig,
  type SessionFacts,
} from "../../contracts/schemas";
import { sdpCodeOf } from "../../drafting/context";
import { roundHalfUpCents } from "./index";

export const INVOICE_VERSION = "invoice-v1";
/** DDS: "A statement that all services specified in the invoice have been provided to the participant." */
export const DDS_SERVICES_STATEMENT = "All services specified in this invoice have been provided to the participant.";
export const INVOICE_ATTESTATION_LABEL = "Provider attestation — provider-confirmed (not evidence), made at approval";
const PROVIDER_CONFIRMED = "provider-confirmed, not evidence";

export function applyMinuteRounding(minutes: number, rule: MinuteRounding = "exact"): number {
  switch (rule) {
    case "nearest_15":
      return Math.floor((minutes + 7) / 15) * 15; // 8-minute rule: 8..22 → 15
    case "floor_15":
      return Math.floor(minutes / 15) * 15;
    case "ceil_15":
      return Math.ceil(minutes / 15) * 15;
    default:
      return minutes;
  }
}

/** Largest-remainder split of an integer `total` by nonnegative weights (ties: earlier wins). */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const s = sum > 0 ? sum : weights.length;
  const raw = w.map((x) => (total * x) / s);
  const out = raw.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]!.i]! += 1;
  return out;
}

function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

interface Task {
  description: string;
  goalId: string | null;
  claimIds: string[];
  evidenceIds: string[];
  source: InvoiceLine["source"];
}

const isEvidenceClaim = (c: FactClaim) => c.support !== "provider_confirmed" && c.evidenceIds.length > 0;

function tasksFrom(config: ServiceConfig, facts: SessionFacts, attestations: ProviderAttestation[]): Task[] {
  const tasks: Task[] = [];
  const usedActivities = new Set<string>();
  for (const g of config.plan.goals) {
    const gf = facts.goals.find((x) => x.goalId === g.goalId);
    if (!gf || gf.status === "unknown") continue;
    const ev = gf.claims.filter(isEvidenceClaim);
    if (ev.length > 0) {
      const evIds = new Set(ev.flatMap((c) => c.evidenceIds));
      const acts = facts.activities.filter((a) => isEvidenceClaim(a) && a.evidenceIds.some((id) => evIds.has(id)));
      acts.forEach((a) => usedActivities.add(a.id));
      for (const a of acts) a.evidenceIds.forEach((id) => evIds.add(id));
      tasks.push({
        description: `Support toward goal: ${g.objective}`,
        goalId: g.goalId,
        claimIds: [...ev.map((c) => c.id), ...acts.map((a) => a.id)],
        evidenceIds: [...evIds],
        source: "evidence",
      });
    } else if (gf.claims.some((c) => c.support === "provider_confirmed")) {
      tasks.push({
        description: `Support toward goal: ${g.objective} (${PROVIDER_CONFIRMED})`,
        goalId: g.goalId,
        claimIds: gf.claims.map((c) => c.id),
        evidenceIds: [],
        source: "provider_attestation",
      });
    }
  }
  for (const a of facts.activities) {
    if (usedActivities.has(a.id) || !isEvidenceClaim(a)) continue;
    tasks.push({ description: a.text.slice(0, 300), goalId: null, claimIds: [a.id], evidenceIds: [...a.evidenceIds], source: "evidence" });
  }
  if (tasks.length === 0) {
    const summary = [...attestations].reverse().find((x) => x.field === "activity_summary" && x.text.trim().length > 0);
    if (summary) {
      tasks.push({
        description: `${summary.text.trim().slice(0, 300)} (provider-written, not evidence)`,
        goalId: null,
        claimIds: [],
        evidenceIds: [],
        source: "provider_attestation",
      });
    } else {
      tasks.push({
        description: `${config.plan.serviceDescription} — no task identified in the evidence`,
        goalId: null,
        claimIds: [],
        evidenceIds: [],
        source: "configuration",
      });
    }
  }
  return tasks.slice(0, 49);
}

/** Seconds of the session attributed to each evidence id: segment start → next segment start (last: its end). */
export function segmentSlots(evidence: EvidenceItem[]): Map<string, number> {
  const timed = evidence
    .filter((e) => e.observedFrom && Number.isFinite(Date.parse(e.observedFrom)))
    .map((e) => ({ id: e.id, from: Date.parse(e.observedFrom!), to: e.observedTo ? Date.parse(e.observedTo) : NaN }))
    .sort((a, b) => a.from - b.from);
  const out = new Map<string, number>();
  timed.forEach((e, i) => {
    const next = timed[i + 1];
    const end = next ? next.from : Number.isFinite(e.to) ? e.to : e.from;
    out.set(e.id, Math.max(0, (end - e.from) / 1000));
  });
  return out;
}

export interface InvoiceInput {
  appointment: Appointment;
  config: ServiceConfig;
  /** Display facts (attestations merged). */
  facts: SessionFacts;
  attestations: ProviderAttestation[];
  evidence: EvidenceItem[];
  confirmedMinutes: number | null;
  scheduledMinutes: number;
}

export function buildInvoice(input: InvoiceInput): InvoiceDraft {
  const { appointment, config, facts, attestations, evidence, confirmedMinutes, scheduledMinutes } = input;
  const ctx = config.context;
  const tz = appointment.timezone;
  const serviceDate = localDate(appointment.startAt, tz);
  const codeKey = ctx?.drive?.serviceCode ?? appointment.serviceCode;
  const sdpCode = sdpCodeOf(codeKey);
  const rate = config.rate.hourlyRateCents;
  const rule: MinuteRounding = config.rate.minuteRounding ?? "exact";
  const billedTotal = confirmedMinutes === null ? null : applyMinuteRounding(confirmedMinutes, rule);
  const notes: string[] = [];

  // Tasks + time estimates from segment timing.
  const tasks = tasksFrom(config, facts, attestations);
  const slots = segmentSlots(evidence);
  const taken = new Set<string>();
  const seconds = tasks.map((t) => {
    let s = 0;
    for (const id of t.evidenceIds) {
      if (taken.has(id)) continue;
      taken.add(id);
      s += slots.get(id) ?? 0;
    }
    return s;
  });
  const unallocated = [...slots.entries()].filter(([id]) => !taken.has(id)).reduce((a, [, s]) => a + s, 0);
  if (unallocated >= 60 && tasks.some((t) => t.source === "evidence")) {
    tasks.push({
      description: "Other session time — no task identified in the transcript",
      goalId: null,
      claimIds: [],
      evidenceIds: [...slots.keys()].filter((id) => !taken.has(id)),
      source: "unallocated",
    });
    seconds.push(unallocated);
  }

  const billed = billedTotal === null ? tasks.map(() => null) : allocate(billedTotal, seconds);
  const totalCents = billedTotal === null ? null : roundHalfUpCents(rate, billedTotal);
  const cents = totalCents === null ? tasks.map(() => null) : allocate(totalCents, billed.map((m) => m ?? 0));

  const lines: InvoiceLine[] = tasks.map((t, i) => ({
    id: `line_${i + 1}`,
    serviceDate,
    serviceCode: sdpCode ?? codeKey,
    taskDescription: t.description.slice(0, 2000),
    source: t.source,
    claimIds: t.claimIds.slice(0, 50),
    evidenceIds: t.evidenceIds.slice(0, 100),
    goalId: t.goalId,
    estimatedMinutes: Math.round(seconds[i]! / 60),
    billedMinutes: billed[i] ?? null,
    hourlyRateCents: rate,
    amountCents: cents[i] ?? null,
  }));

  // Authorization (Drive) — remaining minutes this month.
  let authorization: InvoiceDraft["authorization"] = null;
  const auth = ctx?.drive?.authorization ?? null;
  if (auth) {
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const inRange = ymd.test(auth.validFrom) && ymd.test(auth.validTo) ? serviceDate >= auth.validFrom && serviceDate <= auth.validTo : null;
    const used = ctx?.minutesUsedThisMonth ?? null;
    const thisSession = billedTotal ?? scheduledMinutes;
    const remaining = auth.authorizedMinutesPerMonth === null ? null : auth.authorizedMinutesPerMonth - (used ?? 0) - thisSession;
    authorization = {
      number: auth.number,
      fundingSource: auth.fundingSource,
      validFrom: auth.validFrom,
      validTo: auth.validTo,
      serviceDateInRange: inRange,
      authorizedMinutesPerMonth: auth.authorizedMinutesPerMonth,
      usedMinutesBeforeSession: used,
      remainingMinutesAfterSession: remaining,
    };
    if (used === null && remaining !== null) notes.push("Earlier use this month is not available: remaining minutes assume none were used before this session.");
    if (billedTotal === null && remaining !== null) notes.push("Remaining minutes use the scheduled duration until the provider confirms the actual minutes.");
    if (inRange === false) notes.push(`The service date ${serviceDate} is outside the authorization period ${auth.validFrom} to ${auth.validTo}.`);
  }

  if (billedTotal === null) notes.push("Time per task is an estimate from transcript segment timing until the provider confirms the duration.");
  else notes.push("Time per task is estimated from transcript segment timing and scaled to the provider-confirmed minutes.");
  if (rule !== "exact" && confirmedMinutes !== null) notes.push(`Rounding rule ${rule}: ${confirmedMinutes} confirmed minutes billed as ${billedTotal}.`);
  if (lines.some((l) => l.source === "provider_attestation")) notes.push(`Lines marked ${PROVIDER_CONFIRMED} come from the provider, not from the transcript.`);

  return InvoiceDraft.parse({
    version: INVOICE_VERSION,
    currency: "USD",
    serviceDate,
    serviceCode: codeKey,
    sdpCode,
    serviceCodeSource: ctx?.serviceCodeSource ?? "calendar",
    hourlyRateCents: rate,
    rateSource: ctx?.rateSource ?? (config.rate.rateVersion.startsWith("client:") ? "client" : "service_config"),
    rateVersion: config.rate.rateVersion,
    authorization,
    rounding: { rule, confirmedMinutes, billedMinutes: billedTotal },
    lines,
    totalCents,
    isEstimate: billedTotal === null,
    attestationStatement: DDS_SERVICES_STATEMENT,
    attestationLabel: INVOICE_ATTESTATION_LABEL,
    notes: notes.slice(0, 20),
  });
}
