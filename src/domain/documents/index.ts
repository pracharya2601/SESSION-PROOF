/**
 * Deterministic document templates (Agent 11). Pure, no AI, no HTML.
 * Every line carries provenance (claimIds / evidenceIds / attestationIds /
 * origin). Templates only frame fact texts; they never add factual claims.
 */
import type {
  DocumentLine,
  DocumentSection,
  Documents,
  FactClaim,
  GenerateDocumentsFn,
  PlanCoverageEntry,
  ProviderAttestation,
  TimeSummary,
} from "../../contracts";

const NO_PROGRESS_NOTICE = "No supported progress statement — provider confirmation required.";

function minutesBetween(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : 0;
}

/** YYYY-MM-DD in the given IANA timezone. */
export function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** HH:MM (24h) in the given IANA timezone. */
export function localTime(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

function config(text: string): DocumentLine {
  return { text, claimIds: [], evidenceIds: [], attestationIds: [], origin: "configuration" };
}
function notice(text: string, evidenceIds: string[] = []): DocumentLine {
  return { text, claimIds: [], evidenceIds, attestationIds: [], origin: "system_notice" };
}
function attestationLine(prefix: string, a: ProviderAttestation): DocumentLine {
  return { text: `${prefix}${a.text}`, claimIds: [], evidenceIds: [], attestationIds: [a.id], origin: "provider_attestation" };
}
/** Line for a fact claim. provider_confirmed claims keep attestation provenance. */
function claimLine(prefix: string, c: FactClaim): DocumentLine {
  const uncertain = c.support === "uncertain" ? "(uncertain) " : "";
  if (c.support === "provider_confirmed") {
    return {
      text: `${prefix}Provider confirmed: ${c.text}`,
      claimIds: [c.id],
      evidenceIds: [...c.evidenceIds],
      attestationIds: c.providerAttestationId ? [c.providerAttestationId] : [],
      origin: "provider_attestation",
    };
  }
  return {
    text: `${prefix}${uncertain}${c.text}`,
    claimIds: [c.id],
    evidenceIds: [...c.evidenceIds],
    attestationIds: [],
    origin: "extracted",
  };
}

/** Latest duration attestation by attestedAt (ties: later array position wins). */
export function latestDurationAttestation(attestations: ProviderAttestation[]): ProviderAttestation | null {
  let best: ProviderAttestation | null = null;
  for (const a of attestations) {
    if (a.field !== "duration") continue;
    if (!best || new Date(a.attestedAt).getTime() >= new Date(best.attestedAt).getTime()) best = a;
  }
  return best;
}

const STATUS_LABEL = {
  addressed: "Addressed",
  partially_addressed: "Partially addressed",
  unknown: "Unknown — no supporting evidence",
} as const;

export const generateDocuments: GenerateDocumentsFn = (input) => {
  const { appointment, plan, facts, attestations } = input;
  const tz = appointment.timezone;

  // ---- session note
  const sessionNote: DocumentLine[] = [
    config(`Service: ${plan.serviceDescription} (${appointment.serviceCode})`),
    config(`Date: ${localDate(appointment.startAt, tz)} (${tz})`),
    config(`Client reference: ${appointment.clientRef}`),
    ...facts.activities.map((c) => claimLine("Activity: ", c)),
    ...facts.observations.map((c) => claimLine("Observation: ", c)),
  ];
  if (facts.activities.length === 0 && facts.observations.length === 0) {
    sessionNote.push(notice("No supported activities or observations recorded."));
  }

  // ---- progress record (attestations rendered from the attestation list; merged
  // provider_confirmed claims in facts are skipped to avoid duplicates)
  const progressAttestations = attestations.filter((a) => a.field === "progress");
  const attestedIds = new Set(progressAttestations.map((a) => a.id));
  const progress: DocumentLine[] = [];
  for (const c of facts.progress) {
    if (c.support === "provider_confirmed" && c.providerAttestationId && attestedIds.has(c.providerAttestationId)) continue;
    progress.push(claimLine("", c));
  }
  for (const a of progressAttestations) progress.push(attestationLine("Provider confirmed: ", a));
  const hasSupportedProgress =
    progressAttestations.length > 0 || facts.progress.some((c) => c.support !== "uncertain");
  if (!hasSupportedProgress) progress.push(notice(NO_PROGRESS_NOTICE));

  // ---- plan coverage
  const planCoverage: PlanCoverageEntry[] = plan.goals.map((g) => {
    const gf = facts.goals.find((x) => x.goalId === g.goalId);
    return {
      goalId: g.goalId,
      objective: g.objective,
      status: gf?.status ?? "unknown",
      claimIds: gf ? gf.claims.map((c) => c.id) : [],
    };
  });
  const coverageLines: DocumentLine[] = planCoverage.map((e) => {
    const claims = facts.goals.find((x) => x.goalId === e.goalId)?.claims ?? [];
    const detail = e.status === "unknown" || claims.length === 0 ? "" : ` — ${claims.map((c) => c.text).join(" ")}`;
    return {
      text: `${e.objective} — ${STATUS_LABEL[e.status]}${detail}`,
      claimIds: [...e.claimIds],
      evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))],
      attestationIds: [],
      origin: e.status === "unknown" ? "system_notice" : "extracted",
    };
  });

  // ---- follow-ups
  const followUps: DocumentLine[] = facts.followUps.map((c) => claimLine("Recorded only — not sent: ", c));
  if (followUps.length === 0) followUps.push(notice("No follow-ups recorded."));

  // ---- missing information
  const missing: DocumentLine[] = facts.missingInformation.map((t) => ({
    text: t,
    claimIds: [],
    evidenceIds: [],
    attestationIds: [],
    origin: "extracted" as const,
  }));
  if (input.evidenceCompleteness !== "complete") {
    missing.push(
      notice(
        input.evidenceCompleteness === "partial"
          ? "Evidence retrieval was partial — some sources may be missing."
          : "Evidence completeness is unknown — some sources may be missing.",
      ),
    );
  }
  for (const w of input.evidenceWarnings) missing.push(notice(`Retrieval warning: ${w}`));
  if (missing.length === 0) missing.push(notice("No missing information recorded."));

  // ---- time summary
  const scheduledMinutes = minutesBetween(appointment.startAt, appointment.endAt);
  const ew = input.evidenceWindow;
  const timeSummary: TimeSummary = {
    scheduledFrom: appointment.startAt,
    scheduledTo: appointment.endAt,
    scheduledMinutes,
    evidenceWindowFrom: ew?.from ?? null,
    evidenceWindowTo: ew?.to ?? null,
    evidenceWindowMinutes: ew ? minutesBetween(ew.from, ew.to) : null,
    confirmedMinutes: input.confirmedMinutes,
    timezone: tz,
  };
  const time: DocumentLine[] = [
    config(
      `Scheduled: ${localTime(appointment.startAt, tz)}–${localTime(appointment.endAt, tz)} ${tz} (${scheduledMinutes} minutes)`,
    ),
    ew
      ? notice(
          `Evidence window (informational only, not billable): ${localTime(ew.from, tz)}–${localTime(ew.to, tz)} ${tz} (${timeSummary.evidenceWindowMinutes} minutes)`,
          input.evidence.map((e) => e.id),
        )
      : notice("Evidence window: not available"),
  ];
  if (input.confirmedMinutes !== null) {
    const durationAtt = latestDurationAttestation(attestations);
    time.push({
      text: `Confirmed duration: ${input.confirmedMinutes} minutes (provider confirmed)`,
      claimIds: [],
      evidenceIds: [],
      attestationIds: durationAtt ? [durationAtt.id] : [],
      origin: "provider_attestation",
    });
  } else {
    time.push(notice("Confirmed duration: Not yet confirmed by provider"));
  }

  const sections: DocumentSection[] = [
    { key: "session_note", title: "Session note", lines: sessionNote },
    { key: "progress_record", title: "Progress record", lines: progress },
    { key: "plan_coverage", title: "Plan coverage", lines: coverageLines },
    { key: "follow_ups", title: "Follow-ups", lines: followUps },
    { key: "missing_information", title: "Missing information", lines: missing },
    { key: "time_summary", title: "Time summary", lines: time },
  ];
  const docs: Documents = { sections, planCoverage, timeSummary };
  return docs;
};
