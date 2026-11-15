/** Loads evals/cases/*.json and turns each case into pipeline inputs (appointment, config, evidence). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Appointment, EvidenceItem, Plan, RuleSet, ServiceConfig } from "../../src/contracts";
import { getBandScenario } from "../../fixtures/band/scenarios";
import { EvalCase, type CaseLine, type PlantedPii } from "./types";

export const CASES_DIR = fileURLToPath(new URL("../cases", import.meta.url));

export const EVAL_PROVIDER_ID = "provider_demo_001";
const START = "2026-11-13T18:00:00.000Z";
const RETRIEVED_AT = "2026-11-13T20:00:00.000Z";

const REQUIRED: RuleSet["required"] = [
  "service_date",
  "provider_identity",
  "client_reference",
  "service_description",
  "goal_addressed",
  "progress_statement",
  "confirmed_duration",
];

export interface PreparedCase {
  def: EvalCase;
  appointment: Appointment;
  config: ServiceConfig;
  evidence: EvidenceItem[];
  completeness: "complete" | "partial" | "unknown";
  scheduledMinutes: number;
  client: { clientRef: string; displayName: string; preferredName: string | null };
  /** Planted PII + the client's own names (always must be scrubbed before the model call). */
  pii: PlantedPii[];
  driveContext: {
    clientRef: string;
    folder: string;
    goals: { goalId: string; objective: string }[];
    serviceCode: string;
    authorization: null;
    documents: NonNullable<EvalCase["context"]>["documents"];
  } | null;
}

export function evidenceId(i: number): string {
  return `ev_${String(i).padStart(3, "0")}`;
}

function addMs(iso: string, sec: number): string {
  return new Date(new Date(iso).getTime() + Math.round(sec * 1000)).toISOString();
}

export function loadCaseFiles(dir = CASES_DIR): EvalCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const parsed = EvalCase.safeParse(raw);
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return parsed.data;
  });
}

export function prepareCase(def: EvalCase): PreparedCase {
  const sc = def.fromScenario ? getBandScenario(def.fromScenario) : null;
  if (def.fromScenario && !sc) throw new Error(`${def.id}: unknown scenario ${def.fromScenario}`);

  const client = def.client ?? (sc ? { clientRef: sc.client.clientRef, displayName: sc.client.displayName ?? sc.client.clientRef, preferredName: sc.client.preferredName ?? null } : null);
  if (!client) throw new Error(`${def.id}: client required`);

  const plan: Plan = sc
    ? sc.plan
    : (() => {
        if (!def.plan) throw new Error(`${def.id}: plan required`);
        return { planVersion: `plan_eval_${def.id}`.slice(0, 128), ...def.plan };
      })();
  const rules: RuleSet = sc ? sc.rules : { ruleVersion: `rules_eval_${def.id}`.slice(0, 128), serviceCode: plan.serviceCode, required: [...REQUIRED], allowProviderProgressAttestation: true };
  const rate = sc ? sc.rate : { rateVersion: `rate_eval_${def.id}`.slice(0, 128), currency: "USD" as const, hourlyRateCents: def.hourlyRateCents, maxMinutes: 480 };

  const lines: CaseLine[] =
    def.transcript ?? (sc ? sc.script.map((l) => ({ t: l.atSec, d: l.durationSec, speaker: l.speaker, text: l.text })) : []);

  const appointment: Appointment = {
    id: `appt_eval_${def.id}`.slice(0, 128),
    occurrenceId: `occ_eval_${def.id}`.slice(0, 128),
    providerId: EVAL_PROVIDER_ID,
    clientRef: client.clientRef,
    startAt: START,
    endAt: addMs(START, def.scheduledMinutes * 60),
    timezone: "America/Los_Angeles",
    serviceCode: plan.serviceCode,
    planVersion: plan.planVersion,
    ruleVersion: rules.ruleVersion,
    rateVersion: rate.rateVersion,
    canceled: false,
  };

  const evidence: EvidenceItem[] = lines.map((l, i) => ({
    id: evidenceId(i + 1),
    sourceId: `eval_recording:${def.id}`,
    sourceMode: "live",
    observedFrom: addMs(START, l.t),
    observedTo: addMs(START, l.t + l.d),
    speaker: l.speaker,
    excerpt: l.text.slice(0, 4000),
    retrievedAt: RETRIEVED_AT,
  }));

  const pii: PlantedPii[] = [...def.expect.pii];
  for (const n of [client.displayName.replace(/\s*\([^)]*\)\s*/g, " ").trim(), client.preferredName]) {
    if (n && !pii.some((p) => p.value.toLowerCase() === n.toLowerCase())) pii.push({ value: n, type: "NAME", knownGap: false, note: "client name" });
  }

  return {
    def,
    appointment,
    config: { plan, rules, rate },
    evidence,
    completeness: def.evidenceCompleteness ?? sc?.expect.evidenceCompleteness ?? "complete",
    scheduledMinutes: def.scheduledMinutes,
    client,
    pii,
    driveContext: def.context
      ? { clientRef: client.clientRef, folder: `Clients/${client.clientRef}`, goals: plan.goals, serviceCode: plan.serviceCode, authorization: null, documents: def.context.documents }
      : null,
  };
}
