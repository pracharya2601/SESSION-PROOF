/**
 * Canonical SYNTHETIC fixture (handoff §14). Fictional provider, client and
 * visit. Every consumer (backend, UI, QA) uses these exact IDs and values.
 * Do not create alternative copies.
 */
import type {
  Appointment,
  EvidenceItem,
  Plan,
  RateRule,
  RuleSet,
  ServiceConfig,
  SessionFacts,
} from "../src/contracts";

export const FIXTURE_VERSION = "1";
export const FIXTURE_CLOCK_NOW = "2026-11-13T20:00:00.000Z";
export const fixtureClock = { now: () => new Date(FIXTURE_CLOCK_NOW) };

export const DEMO_PROVIDER_ID = "provider_demo_001";
export const DEMO_PROVIDER_IDENTITY = "demo.provider@example.invalid";
export const OTHER_PROVIDER_ID = "provider_other_002";
export const OTHER_PROVIDER_IDENTITY = "other.provider@example.invalid";

export const demoAppointment: Appointment = {
  id: "appointment_demo_001",
  occurrenceId: "occurrence_demo_001",
  providerId: DEMO_PROVIDER_ID,
  clientRef: "C-104",
  startAt: "2026-11-13T18:00:00.000Z", // 10:00 America/Los_Angeles
  endAt: "2026-11-13T19:00:00.000Z", // 11:00 America/Los_Angeles
  timezone: "America/Los_Angeles",
  serviceCode: "DEMO-ILS",
  planVersion: "plan_demo_v1",
  ruleVersion: "rules_demo_v1",
  rateVersion: "rate_demo_v1",
  canceled: false,
};

export const demoPlan: Plan = {
  planVersion: "plan_demo_v1",
  serviceCode: "DEMO-ILS",
  serviceDescription: "Independent living skills (demonstration service)",
  goals: [
    { goalId: "goal_transport", objective: "Practice transportation planning." },
    { goalId: "goal_budget", objective: "Practice budgeting." },
    { goalId: "goal_community", objective: "Practice community interaction." },
  ],
};

export const demoRules: RuleSet = {
  ruleVersion: "rules_demo_v1",
  serviceCode: "DEMO-ILS",
  required: [
    "service_date",
    "provider_identity",
    "client_reference",
    "service_description",
    "goal_addressed",
    "progress_statement",
    "confirmed_duration",
  ],
  allowProviderProgressAttestation: true,
};

export const demoRate: RateRule = {
  rateVersion: "rate_demo_v1",
  currency: "USD",
  hourlyRateCents: 7500,
  maxMinutes: 12 * 60,
};

export const demoConfig: ServiceConfig = { plan: demoPlan, rules: demoRules, rate: demoRate };

const RETRIEVED_AT = "2026-11-13T19:30:00.000Z";
const SRC = "fixture_transcript_2026-11-13";

function line(id: string, at: string, speaker: string, excerpt: string, minutes = 1): EvidenceItem {
  const from = new Date(at);
  const to = new Date(from.getTime() + minutes * 60_000);
  return {
    id,
    sourceId: SRC,
    sourceMode: "fixture",
    observedFrom: from.toISOString(),
    observedTo: to.toISOString(),
    speaker,
    excerpt,
    retrievedAt: RETRIEVED_AT,
  };
}

/** Synthetic transcript lines — 10:05..10:52 local (18:05..18:52Z). */
export const demoEvidence: EvidenceItem[] = [
  line("ev_001", "2026-11-13T18:05:00.000Z", "Provider", "Today we will practice planning the bus route to the library."),
  line("ev_002", "2026-11-13T18:12:00.000Z", "Participant", "I found the route and the transfer stop on this map."),
  line("ev_003", "2026-11-13T18:25:00.000Z", "Provider", "We also reviewed the weekly food budget together."),
  line("ev_004", "2026-11-13T18:47:00.000Z", "Provider", "I will bring another route-planning worksheet next time."),
  line("ev_005", "2026-11-13T18:52:00.000Z", "Provider", "We are finishing the practice for today."),
];

/**
 * Fixture extraction output for the normal variant. Progress is deliberately
 * EMPTY so the demo requires a provider progress attestation.
 */
export const demoFacts: SessionFacts = {
  activities: [
    { id: "fact_act_1", text: "Practiced planning a bus route to the library, including identifying a transfer stop.", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
    { id: "fact_act_2", text: "Reviewed the weekly food budget together.", evidenceIds: ["ev_003"], support: "supported" },
  ],
  observations: [
    { id: "fact_obs_1", text: "Participant located the route and the transfer stop on a map.", evidenceIds: ["ev_002"], support: "supported" },
  ],
  goals: [
    { goalId: "goal_transport", status: "addressed", claims: [{ id: "fact_goal_1", text: "Bus route planning practiced.", evidenceIds: ["ev_001", "ev_002"], support: "supported" }] },
    { goalId: "goal_budget", status: "partially_addressed", claims: [{ id: "fact_goal_2", text: "Weekly food budget reviewed; participant contribution not recorded.", evidenceIds: ["ev_003"], support: "uncertain" }] },
    { goalId: "goal_community", status: "unknown", claims: [] },
  ],
  progress: [],
  followUps: [
    { id: "fact_fu_1", text: "Provider to bring another route-planning worksheet next session.", evidenceIds: ["ev_004"], support: "supported" },
  ],
  missingInformation: [
    "Progress toward goals is not established by the evidence; provider confirmation needed.",
    "No evidence about community interaction.",
  ],
};

/** Expected outcomes (handoff §14.5). */
export const EXPECTED = {
  scheduledMinutes: 60,
  estimateCents60: 7500,
  amountCents60: 7500,
  amountCents90: 11250,
  demoProgressConfirmation: "The participant completed the planning task with verbal prompts.",
  demoApprovalKey: "demo-session-approval-request-001",
} as const;
