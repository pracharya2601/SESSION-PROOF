/**
 * SYNTHETIC band-visit scenarios (dummy data only). Every person, organisation,
 * authorization number and utterance below is fictional. No real names, addresses,
 * phone numbers or identifiers. The one deliberate exception is `pii-in-transcript`,
 * which speaks OBVIOUSLY FAKE contact details (555 phone number, example.invalid
 * email) to exercise the PII scrubber in live mode.
 *
 * Service codes are the VERIFIED California Self-Determination Program (SDP) codes from
 * docs/research/self-determination-codes.md §1.2 (DDS "SDP Service Codes by Budget
 * Category", table dated 2019-02-14, modified 2019-05-02 [S1]). Units come from the SDP
 * waiver CA.1166.R02.00 Appendix J (estimating units, not binding billing units [S3]).
 * No code here is invented.
 *
 * How the expectations are derived (no guessing):
 * - Evidence ids are ev_001.. in script order (src/band/evidence.ts evidenceIdFor).
 * - completeness = "complete" only when the visit is stopped AND lostPackets = 0, else "partial".
 * - Warnings always include "Simulated transcript" (simulated transcriber); lost packets add
 *   "<n> audio packet(s) (<pct>%) were lost on the Bluetooth link." with
 *   pct = round(lost / (received + lost) * 1000) / 10.
 * - Blocking codes come from src/domain/rules: with no attestations, confirmed_duration is
 *   always MISSING_CONFIRMED_DURATION; progress_statement is MISSING_PROGRESS unless the
 *   extraction has a "supported" progress claim citing known evidence.
 * - Amount = round_half_up(hourlyRateCents × confirmedMinutes / 60) (src/domain/billing),
 *   with the service-config rate because every synthetic client has hourlyRateCents = null.
 * - No script lines → BandEvidenceSource returns zero items → workflow NO_EVIDENCE.
 */
import type { ClientInput, Plan, RateRule, RuleSet } from "../../src/contracts";
import type { BandScenario, ScenarioServiceCode } from "./types";

// ------------------------------------------------------------------ shared pieces
const S1 = "DDS SDP Service Codes by Budget Category, table 2019-02-14 (mod. 2019-05-02) [S1]";
const S3 = "unit per SDP waiver CA.1166.R02.00 App. J estimating units [S3]";
const DOC = "docs/research/self-determination-codes.md §1.2";

function sdpCode(code: string, label: string, unit: string, extra = ""): ScenarioServiceCode {
  return { system: "CA-SDP", code, label, unit, sourceNote: `${S1}; ${S3}; see ${DOC}.${extra ? ` ${extra}` : ""}` };
}

const CODE_320 = sdpCode("320", "Community Living Supports (Individual and Agency)", "hour",
  "ILS-type work maps to 320 or 334 per the spending plan (research note U2); 320 chosen here for the synthetic plan.");
const CODE_331 = sdpCode("331", "Community Integration Supports", "day",
  "Waiver estimates 331 per DAY; our billing model is hourly only (observation point).");
const CODE_334 = sdpCode("334", "Individual Training and Education", "hour");
const CODE_335 = sdpCode("335", "Employment Supports", "hour");

/** Standard documentation requirements (same list as the canonical demo rules). */
const REQUIRED: RuleSet["required"] = [
  "service_date",
  "provider_identity",
  "client_reference",
  "service_description",
  "goal_addressed",
  "progress_statement",
  "confirmed_duration",
];

function rules(ruleVersion: string, serviceCode: string): RuleSet {
  return { ruleVersion, serviceCode, required: [...REQUIRED], allowProviderProgressAttestation: true };
}

function rate(rateVersion: string, hourlyRateCents: number, maxMinutes = 8 * 60): RateRule {
  return { rateVersion, currency: "USD", hourlyRateCents, maxMinutes };
}

function client(clientRef: string, displayName: string, preferredName: string, program: string): ClientInput {
  return {
    clientRef,
    displayName: `${displayName} (synthetic)`,
    preferredName,
    hourlyRateCents: null, // agency rate from the scenario's service config applies
    fundingSource: "Self-Determination Program budget (synthetic)",
    authorizationNumber: `AUTH-SYN-${clientRef}`,
    fiscalIntermediary: "Example FMS (synthetic)",
    authorizedHours: 20,
    caseManager: "Example Service Coordinator (synthetic)",
    customFields: [
      { label: "Program", value: program },
      { label: "Data", value: "SYNTHETIC test data - not a real person" },
    ],
    templates: { session_note: null, invoice: null, approval_record: null },
    notes: "Synthetic band-scenario client. Not a real person.",
    active: true,
  };
}

const SIMULATED = "Simulated transcript";

// ------------------------------------------------------------------ 1. sdp-320-normal
const plan320A: Plan = {
  planVersion: "plan_sdp320_a_v1",
  serviceCode: "CA-SDP-320",
  serviceDescription: "Community Living Supports: personal skill development for daily living (synthetic plan)",
  goals: [
    { goalId: "goal_meal_planning", objective: "Plan and prepare a simple weekly meal with decreasing prompts." },
    { goalId: "goal_laundry", objective: "Complete a laundry cycle independently." },
    { goalId: "goal_schedule", objective: "Keep a personal weekly schedule up to date." },
  ],
};

const sdp320Normal: BandScenario = {
  id: "sdp-320-normal",
  title: "Community Living Supports visit (normal)",
  purpose:
    "Baseline band visit coded CA-SDP 320: two speakers, complete audio, no progress statement in the transcript, so the draft is blocked on progress + duration until the provider review supplies both; then approve → COMPLETED.",
  serviceCode: CODE_320,
  client: client("SD-320-A", "Robin Testwell", "Robin", "SDP 320 Community Living Supports"),
  plan: plan320A,
  rules: rules("rules_sdp320_a_v1", "CA-SDP-320"),
  rate: rate("rate_sdp320_a_v1", 3850), // $38.50/h synthetic
  audio: { seconds: 90 },
  script: [
    { atSec: 2, durationSec: 5, speaker: "Speaker 0", text: "Today let's plan the meals for this week and write the shopping list." },
    { atSec: 10, durationSec: 6, speaker: "Speaker 1", text: "I want pasta on Monday and soup on Thursday." },
    { atSec: 20, durationSec: 5, speaker: "Speaker 0", text: "Good, let's check the cupboard for what we already have." },
    { atSec: 32, durationSec: 6, speaker: "Speaker 1", text: "We have rice and two cans of beans, so I will add tomatoes to the list." },
    { atSec: 46, durationSec: 5, speaker: "Speaker 0", text: "Now let's put the laundry in and pick the right setting together." },
    { atSec: 60, durationSec: 5, speaker: "Speaker 1", text: "I picked the cold setting for the dark clothes." },
    { atSec: 74, durationSec: 5, speaker: "Speaker 0", text: "Next visit we will cook the Monday pasta together." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Planned weekly meals and wrote a shopping list.", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      { id: "fact_act_2", text: "Checked cupboard stock before adding items to the list.", evidenceIds: ["ev_003", "ev_004"], support: "supported" },
      { id: "fact_act_3", text: "Started a laundry load and chose a wash setting together.", evidenceIds: ["ev_005", "ev_006"], support: "supported" },
    ],
    observations: [
      { id: "fact_obs_1", text: "Participant chose meals for two days and identified a missing ingredient.", evidenceIds: ["ev_002", "ev_004"], support: "supported" },
    ],
    goals: [
      { goalId: "goal_meal_planning", status: "addressed", claims: [{ id: "fact_goal_1", text: "Weekly meal plan and shopping list prepared.", evidenceIds: ["ev_001", "ev_002", "ev_004"], support: "supported" }] },
      { goalId: "goal_laundry", status: "partially_addressed", claims: [{ id: "fact_goal_2", text: "Laundry setting chosen; completing the cycle not recorded.", evidenceIds: ["ev_006"], support: "uncertain" }] },
      { goalId: "goal_schedule", status: "unknown", claims: [] },
    ],
    progress: [],
    followUps: [{ id: "fact_fu_1", text: "Cook the planned Monday meal together next visit.", evidenceIds: ["ev_007"], support: "supported" }],
    missingInformation: ["Progress toward goals is not stated in the transcript; provider confirmation needed.", "No evidence about the weekly schedule goal."],
  },
  review: {
    confirmedMinutes: 75,
    progressConfirmation: "Robin chose meals and found the missing ingredient with one verbal prompt, fewer than last visit.",
  },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION", "MISSING_PROGRESS"],
    // 3850 × 75 / 60 = 4812.5 → half up → 4813
    amountCentsAfterReview: 4813,
    final: "COMPLETED",
    warningsInclude: [SIMULATED],
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ 2. sdp-334-training
const plan334A: Plan = {
  planVersion: "plan_sdp334_a_v1",
  serviceCode: "CA-SDP-334",
  serviceDescription: "Individual Training and Education: money-management skills course (synthetic plan)",
  goals: [
    { goalId: "goal_budget_tracking", objective: "Track weekly spending in a simple budget sheet." },
    { goalId: "goal_bill_reading", objective: "Identify the amount due and due date on a bill." },
  ],
};

const sdp334Training: BandScenario = {
  id: "sdp-334-training",
  title: "Individual Training & Education (progress stated)",
  purpose:
    "CA-SDP 334 visit where the provider states progress clearly in the transcript, so the fixture extraction has a supported progress claim and the ONLY blocker at r1 is the confirmed duration.",
  serviceCode: CODE_334,
  client: client("SD-334-A", "Jordan Sampleton", "Jordan", "SDP 334 Individual Training and Education"),
  plan: plan334A,
  rules: rules("rules_sdp334_a_v1", "CA-SDP-334"),
  rate: rate("rate_sdp334_a_v1", 5200), // $52.00/h synthetic
  audio: { seconds: 80 },
  script: [
    { atSec: 3, durationSec: 5, speaker: "Speaker 0", text: "Let's open your budget sheet and enter this week's receipts." },
    { atSec: 12, durationSec: 6, speaker: "Speaker 1", text: "I spent twelve dollars on groceries and four on the bus." },
    { atSec: 24, durationSec: 6, speaker: "Speaker 0", text: "Now find the amount due and the due date on this practice bill." },
    { atSec: 36, durationSec: 5, speaker: "Speaker 1", text: "It says forty dollars, due on the fifteenth." },
    { atSec: 48, durationSec: 8, speaker: "Speaker 0", text: "That's progress: you entered every receipt without prompts today, and last week you needed help with each one." },
    { atSec: 64, durationSec: 5, speaker: "Speaker 0", text: "Next time we will practice with a utility bill." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Entered the week's receipts into a budget sheet.", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      { id: "fact_act_2", text: "Read the amount due and due date on a practice bill.", evidenceIds: ["ev_003", "ev_004"], support: "supported" },
    ],
    observations: [
      { id: "fact_obs_1", text: "Participant stated grocery and bus amounts and the bill's amount and due date.", evidenceIds: ["ev_002", "ev_004"], support: "supported" },
    ],
    goals: [
      { goalId: "goal_budget_tracking", status: "addressed", claims: [{ id: "fact_goal_1", text: "Weekly spending recorded in the budget sheet.", evidenceIds: ["ev_001", "ev_002"], support: "supported" }] },
      { goalId: "goal_bill_reading", status: "addressed", claims: [{ id: "fact_goal_2", text: "Amount due and due date identified on a practice bill.", evidenceIds: ["ev_003", "ev_004"], support: "supported" }] },
    ],
    progress: [
      { id: "fact_prog_1", text: "Entered every receipt without prompts, compared with needing help on each one the previous week.", evidenceIds: ["ev_005"], support: "supported" },
    ],
    followUps: [{ id: "fact_fu_1", text: "Practice with a utility bill next session.", evidenceIds: ["ev_006"], support: "supported" }],
    missingInformation: [],
  },
  review: { confirmedMinutes: 50 },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION"],
    // 5200 × 50 / 60 = 4333.33 → 4333
    amountCentsAfterReview: 4333,
    final: "COMPLETED",
    warningsInclude: [SIMULATED],
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ 3. sdp-331-community
const plan331A: Plan = {
  planVersion: "plan_sdp331_a_v1",
  serviceCode: "CA-SDP-331",
  serviceDescription: "Community Integration Supports: participation in community activities of choice (synthetic plan)",
  goals: [
    { goalId: "goal_library_card", objective: "Use the public library independently, including checking out items." },
    { goalId: "goal_social_group", objective: "Join a community interest group of the participant's choice." },
  ],
};

const sdp331Community: BandScenario = {
  id: "sdp-331-community",
  title: "Community Integration Supports (day unit vs hourly billing)",
  purpose:
    "CA-SDP 331 visit. OBSERVATION POINT: the SDP waiver estimates 331 per DAY, but our billing model is hourly only, so the synthetic config keeps an hourly rate and bills 120 confirmed minutes as 2 hours. Watch how the invoice presents a day-unit service.",
  serviceCode: CODE_331,
  client: client("SD-331-A", "Casey Placeholder", "Casey", "SDP 331 Community Integration Supports"),
  plan: plan331A,
  rules: rules("rules_sdp331_a_v1", "CA-SDP-331"),
  rate: rate("rate_sdp331_a_v1", 4125), // $41.25/h synthetic (hourly stand-in for a day unit)
  audio: { seconds: 100 },
  script: [
    { atSec: 4, durationSec: 5, speaker: "Provider", text: "We're at the library; do you want to ask the desk about the card yourself?" },
    { atSec: 15, durationSec: 5, speaker: "Participant", text: "Yes, I asked and they gave me the form." },
    { atSec: 28, durationSec: 6, speaker: "Provider", text: "You filled in the form and checked out two books on the self-service machine." },
    { atSec: 44, durationSec: 6, speaker: "Participant", text: "I saw a poster for the Tuesday board game club." },
    { atSec: 58, durationSec: 5, speaker: "Provider", text: "We can look at the club schedule together next week." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Visited the public library and applied for a library card.", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      { id: "fact_act_2", text: "Checked out two books on the self-service machine.", evidenceIds: ["ev_003"], support: "supported" },
    ],
    observations: [
      { id: "fact_obs_1", text: "Participant spoke to library staff and noticed a community club poster.", evidenceIds: ["ev_002", "ev_004"], support: "supported" },
    ],
    goals: [
      { goalId: "goal_library_card", status: "addressed", claims: [{ id: "fact_goal_1", text: "Library card form completed and books checked out.", evidenceIds: ["ev_002", "ev_003"], support: "supported" }] },
      { goalId: "goal_social_group", status: "partially_addressed", claims: [{ id: "fact_goal_2", text: "Interest in a board game club noted; not yet joined.", evidenceIds: ["ev_004"], support: "uncertain" }] },
    ],
    progress: [],
    followUps: [{ id: "fact_fu_1", text: "Review the board game club schedule next week.", evidenceIds: ["ev_005"], support: "supported" }],
    missingInformation: ["Progress toward goals is not stated in the transcript; provider confirmation needed."],
  },
  review: {
    confirmedMinutes: 120,
    progressConfirmation: "Casey asked library staff for help without prompting for the first time.",
  },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION", "MISSING_PROGRESS"],
    // 4125 × 120 / 60 = 8250 exactly
    amountCentsAfterReview: 8250,
    final: "COMPLETED",
    warningsInclude: [SIMULATED],
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ 4. lossy-bluetooth
const plan320B: Plan = {
  planVersion: "plan_sdp320_b_v1",
  serviceCode: "CA-SDP-320",
  serviceDescription: "Community Living Supports: household routines (synthetic plan)",
  goals: [
    { goalId: "goal_dishes", objective: "Wash and put away dishes after meals." },
    { goalId: "goal_recycling", objective: "Sort recycling on collection day." },
  ],
};

const LOSSY_SECONDS = 120; // 6000 packets in total
const LOSSY_DROPS: [number, number][] = [
  [500, 575], // 75 packets (10.0–11.5 s)
  [3000, 3150], // 150 packets (60.0–63.0 s)
];

const lossyBluetooth: BandScenario = {
  id: "lossy-bluetooth",
  title: "Bluetooth packet loss",
  purpose:
    "CA-SDP 320 visit with dropped Bluetooth packets mid-stream: evidence completeness must be partial, a nonblocking PARTIAL_EVIDENCE check appears, and the 'audio packet(s) were lost' warning is carried in provenance.",
  serviceCode: CODE_320,
  client: client("SD-320-B", "Avery Mockridge", "Avery", "SDP 320 Community Living Supports"),
  plan: plan320B,
  rules: rules("rules_sdp320_b_v1", "CA-SDP-320"),
  rate: rate("rate_sdp320_b_v1", 3850),
  audio: { seconds: LOSSY_SECONDS, dropPackets: LOSSY_DROPS },
  script: [
    { atSec: 5, durationSec: 4, speaker: "Speaker 0", text: "Let's start with the dishes from lunch." },
    { atSec: 18, durationSec: 5, speaker: "Speaker 1", text: "I washed the plates and put the cups on the rack." },
    { atSec: 40, durationSec: 5, speaker: "Speaker 0", text: "Now the recycling: which bin does the cardboard go in?" },
    { atSec: 70, durationSec: 5, speaker: "Speaker 1", text: "The blue one, and I flattened the boxes first." },
    { atSec: 95, durationSec: 4, speaker: "Speaker 0", text: "Great, collection is tomorrow morning." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Washed lunch dishes and placed cups on the rack.", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      { id: "fact_act_2", text: "Sorted cardboard into the recycling bin after flattening boxes.", evidenceIds: ["ev_003", "ev_004"], support: "supported" },
    ],
    observations: [],
    goals: [
      { goalId: "goal_dishes", status: "addressed", claims: [{ id: "fact_goal_1", text: "Lunch dishes washed by the participant.", evidenceIds: ["ev_002"], support: "supported" }] },
      { goalId: "goal_recycling", status: "addressed", claims: [{ id: "fact_goal_2", text: "Cardboard sorted into the correct bin.", evidenceIds: ["ev_004"], support: "supported" }] },
    ],
    progress: [],
    followUps: [],
    missingInformation: ["Some audio was lost; parts of the conversation may be missing.", "Progress is not stated in the transcript."],
  },
  review: { confirmedMinutes: 60, progressConfirmation: "Avery sorted recycling with no prompts." },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION", "MISSING_PROGRESS"],
    // 3850 × 60 / 60 = 3850 exactly
    amountCentsAfterReview: 3850,
    final: "COMPLETED",
    // lost = 75 + 150 = 225; received = 6000 − 225 = 5775;
    // pct = round(225 / 6000 × 1000) / 10 = round(37.5) / 10 = 3.8
    warningsInclude: [SIMULATED, "audio packet", "225 audio packet(s) (3.8%)"],
    evidenceCompleteness: "partial",
  },
};

// ------------------------------------------------------------------ 5. reconnect-mid-visit
const plan335A: Plan = {
  planVersion: "plan_sdp335_a_v1",
  serviceCode: "CA-SDP-335",
  serviceDescription: "Employment Supports: job coaching at a community workplace (synthetic plan)",
  goals: [
    { goalId: "goal_task_list", objective: "Follow the shift task list with fewer coach prompts." },
    { goalId: "goal_break_time", objective: "Return from breaks on time using a phone timer." },
  ],
};

const reconnectMidVisit: BandScenario = {
  id: "reconnect-mid-visit",
  title: "Band reconnect mid-visit (job coaching)",
  purpose:
    "CA-SDP 335 job-coaching visit where the band reconnects at 50 s (seq restarts at 0, a new start is sent): the timeline has a gap but no packets are counted lost, so completeness stays complete; still NEEDS_REVIEW (duration only, progress is in the transcript).",
  serviceCode: CODE_335,
  client: client("SD-335-A", "Morgan Fictive", "Morgan", "SDP 335 Employment Supports"),
  plan: plan335A,
  rules: rules("rules_sdp335_a_v1", "CA-SDP-335"),
  rate: rate("rate_sdp335_a_v1", 4780), // $47.80/h synthetic
  audio: { seconds: 100, reconnectAtSec: [50] },
  script: [
    { atSec: 3, durationSec: 5, speaker: "Speaker 0", text: "Let's read today's shift task list together." },
    { atSec: 15, durationSec: 5, speaker: "Speaker 1", text: "First I stock the shelves, then I face the products." },
    { atSec: 30, durationSec: 5, speaker: "Speaker 1", text: "I set my phone timer for the fifteen minute break." },
    { atSec: 58, durationSec: 5, speaker: "Speaker 0", text: "You came back from break right when the timer went off." },
    { atSec: 72, durationSec: 7, speaker: "Speaker 0", text: "Progress today: you finished the task list with two prompts, down from five last week." },
    { atSec: 88, durationSec: 4, speaker: "Speaker 0", text: "Next shift we will add the backroom task." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Reviewed the shift task list and stocked and faced shelves.", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      { id: "fact_act_2", text: "Used a phone timer to manage break time.", evidenceIds: ["ev_003", "ev_004"], support: "supported" },
    ],
    observations: [
      { id: "fact_obs_1", text: "Participant returned from break when the timer sounded.", evidenceIds: ["ev_004"], support: "supported" },
    ],
    goals: [
      { goalId: "goal_task_list", status: "addressed", claims: [{ id: "fact_goal_1", text: "Task list followed with two prompts.", evidenceIds: ["ev_002", "ev_005"], support: "supported" }] },
      { goalId: "goal_break_time", status: "addressed", claims: [{ id: "fact_goal_2", text: "Returned from break on time using a timer.", evidenceIds: ["ev_003", "ev_004"], support: "supported" }] },
    ],
    progress: [
      { id: "fact_prog_1", text: "Completed the task list with two prompts, down from five the previous week.", evidenceIds: ["ev_005"], support: "supported" },
    ],
    followUps: [{ id: "fact_fu_1", text: "Add the backroom task next shift.", evidenceIds: ["ev_006"], support: "supported" }],
    missingInformation: [],
  },
  review: { confirmedMinutes: 45 },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION"],
    // 4780 × 45 / 60 = 3585 exactly
    amountCentsAfterReview: 3585,
    final: "COMPLETED",
    warningsInclude: [SIMULATED],
    // A reconnect resets prevSeq (src/band/capture.ts), so no gap is counted as loss.
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ 6. participant-directed
const plan320C: Plan = {
  planVersion: "plan_sdp320_c_v1",
  serviceCode: "CA-SDP-320",
  serviceDescription: "Community Living Supports: participant-directed errands and routines (synthetic plan)",
  goals: [
    { goalId: "goal_errand_planning", objective: "Choose and plan the order of weekly errands." },
    { goalId: "goal_shopping", objective: "Pay at a store checkout independently." },
  ],
};

const participantDirected: BandScenario = {
  id: "participant-directed",
  title: "Participant-directed errands",
  purpose:
    "CA-SDP 320 visit where the participant makes the choices (which errands, in what order, where to shop). The provider review sets participantDirected = true and records participantChoices, plus minutes and progress (self-determination attestations).",
  serviceCode: CODE_320,
  client: client("SD-320-C", "Riley Exampleton", "Riley", "SDP 320 Community Living Supports"),
  plan: plan320C,
  rules: rules("rules_sdp320_c_v1", "CA-SDP-320"),
  rate: rate("rate_sdp320_c_v1", 3975), // $39.75/h synthetic
  audio: { seconds: 90 },
  script: [
    { atSec: 2, durationSec: 4, speaker: "Speaker 0", text: "What would you like to do first today?" },
    { atSec: 9, durationSec: 7, speaker: "Speaker 1", text: "I want to go to the pharmacy first, then the hardware store, not the mall." },
    { atSec: 22, durationSec: 5, speaker: "Speaker 0", text: "Okay, it's your call. Which way do you want to walk?" },
    { atSec: 33, durationSec: 5, speaker: "Speaker 1", text: "The park way, it's quieter." },
    { atSec: 48, durationSec: 6, speaker: "Speaker 1", text: "I paid at the hardware store checkout and kept the receipt." },
    { atSec: 66, durationSec: 5, speaker: "Speaker 0", text: "Next week you can pick the errands again." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Participant chose and ordered the day's errands (pharmacy, then hardware store).", evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      { id: "fact_act_2", text: "Walked a participant-chosen route to the stores.", evidenceIds: ["ev_003", "ev_004"], support: "supported" },
      { id: "fact_act_3", text: "Participant paid at the hardware store checkout.", evidenceIds: ["ev_005"], support: "supported" },
    ],
    observations: [
      { id: "fact_obs_1", text: "Participant declined the mall and chose a quieter route.", evidenceIds: ["ev_002", "ev_004"], support: "supported" },
    ],
    goals: [
      { goalId: "goal_errand_planning", status: "addressed", claims: [{ id: "fact_goal_1", text: "Errands and their order chosen by the participant.", evidenceIds: ["ev_002"], support: "supported" }] },
      { goalId: "goal_shopping", status: "addressed", claims: [{ id: "fact_goal_2", text: "Paid at checkout and kept the receipt.", evidenceIds: ["ev_005"], support: "supported" }] },
    ],
    progress: [],
    followUps: [{ id: "fact_fu_1", text: "Participant to choose next week's errands.", evidenceIds: ["ev_006"], support: "supported" }],
    missingInformation: ["Progress is not stated in the transcript; provider confirmation needed."],
  },
  review: {
    confirmedMinutes: 90,
    progressConfirmation: "Riley planned the full errand sequence without suggestions from me.",
    participantDirected: true,
    participantChoices: "Chose the errands and their order, skipped the mall, and picked the quieter park route.",
  },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION", "MISSING_PROGRESS"],
    // 3975 × 90 / 60 = 5962.5 → half up → 5963
    amountCentsAfterReview: 5963,
    final: "COMPLETED",
    warningsInclude: [SIMULATED],
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ 7. pii-in-transcript
const plan334B: Plan = {
  planVersion: "plan_sdp334_b_v1",
  serviceCode: "CA-SDP-334",
  serviceDescription: "Individual Training and Education: phone and email safety skills (synthetic plan)",
  goals: [
    { goalId: "goal_contact_safety", objective: "Decide when it is safe to share personal contact details." },
    { goalId: "goal_email_basics", objective: "Send a short email to a trusted contact." },
  ],
};

const piiInTranscript: BandScenario = {
  id: "pii-in-transcript",
  title: "OBVIOUSLY FAKE PII spoken in the transcript",
  purpose:
    "SYNTHETIC PII test (CA-SDP 334). The transcript speaks an obviously fake phone number ((555) 555-0100, 555 is the fictional exchange) and an example.invalid email. In live mode the PII scrubber must tokenize them before inference (provenance.privacy.findings counts); in fixture mode they simply flow. The extraction never repeats the values.",
  serviceCode: CODE_334,
  client: client("SD-334-B", "Taylor Notreal", "Taylor", "SDP 334 Individual Training and Education"),
  plan: plan334B,
  rules: rules("rules_sdp334_b_v1", "CA-SDP-334"),
  rate: rate("rate_sdp334_b_v1", 4950), // $49.50/h synthetic
  audio: { seconds: 70 },
  script: [
    { atSec: 2, durationSec: 5, speaker: "Speaker 0", text: "Today we practice deciding who should get your contact details." },
    // SYNTHETIC FAKE PII (exercise the scrubber): 555 exchange + example.invalid domain.
    { atSec: 10, durationSec: 6, speaker: "Speaker 1", text: "A man asked for my phone, I almost said call me at (555) 555-0100." },
    { atSec: 22, durationSec: 6, speaker: "Speaker 0", text: "Good that you stopped. Only share it with people you know and trust." },
    // SYNTHETIC FAKE PII: example.invalid is a reserved, non-routable domain.
    { atSec: 34, durationSec: 6, speaker: "Speaker 1", text: "I sent my sister an email from test.learner@example.invalid saying hello." },
    { atSec: 46, durationSec: 7, speaker: "Speaker 0", text: "Progress: you explained the safety rule in your own words today without any reminder." },
  ],
  extraction: {
    activities: [
      { id: "fact_act_1", text: "Practiced deciding when to share personal contact details.", evidenceIds: ["ev_001", "ev_002", "ev_003"], support: "supported" },
      { id: "fact_act_2", text: "Sent a short email to a family member.", evidenceIds: ["ev_004"], support: "supported" },
    ],
    observations: [
      { id: "fact_obs_1", text: "Participant described nearly sharing a phone number with a stranger and stopping.", evidenceIds: ["ev_002"], support: "supported" },
    ],
    goals: [
      { goalId: "goal_contact_safety", status: "addressed", claims: [{ id: "fact_goal_1", text: "Discussed and applied the rule for sharing contact details.", evidenceIds: ["ev_002", "ev_003"], support: "supported" }] },
      { goalId: "goal_email_basics", status: "addressed", claims: [{ id: "fact_goal_2", text: "Sent an email to a trusted contact.", evidenceIds: ["ev_004"], support: "supported" }] },
    ],
    progress: [
      { id: "fact_prog_1", text: "Explained the contact-safety rule in own words without a reminder.", evidenceIds: ["ev_005"], support: "supported" },
    ],
    followUps: [],
    missingInformation: [],
  },
  review: { confirmedMinutes: 30 },
  expect: {
    afterProcessing: "NEEDS_REVIEW",
    blockingAtR1: ["MISSING_CONFIRMED_DURATION"],
    // 4950 × 30 / 60 = 2475 exactly
    amountCentsAfterReview: 2475,
    final: "COMPLETED",
    warningsInclude: [SIMULATED],
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ 8. empty-recording
const plan320D: Plan = {
  planVersion: "plan_sdp320_d_v1",
  serviceCode: "CA-SDP-320",
  serviceDescription: "Community Living Supports (synthetic plan, empty-recording test)",
  goals: [{ goalId: "goal_morning_routine", objective: "Complete a morning routine checklist." }],
};

const emptyRecording: BandScenario = {
  id: "empty-recording",
  title: "Empty recording (no transcript)",
  purpose:
    "CA-SDP 320 band visit that streams 4 s of audio but produces no transcript lines (script: []). The simulated transcriber flushes remaining lines at stop, so 'too short' alone is not enough: an empty script is. BandEvidenceSource returns zero items → workflow NO_EVIDENCE, no draft, no amount.",
  serviceCode: CODE_320,
  client: client("SD-320-D", "Quinn Dummyfield", "Quinn", "SDP 320 Community Living Supports"),
  plan: plan320D,
  rules: rules("rules_sdp320_d_v1", "CA-SDP-320"),
  rate: rate("rate_sdp320_d_v1", 3850),
  audio: { seconds: 4 },
  script: [],
  extraction: { activities: [], observations: [], goals: [], progress: [], followUps: [], missingInformation: [] },
  expect: {
    afterProcessing: "NO_EVIDENCE",
    blockingAtR1: [], // no bundle is ever drafted
    amountCentsAfterReview: null,
    final: "NO_EVIDENCE",
    // Reported by the evidence step (run event meta); no bundle/provenance exists.
    evidenceCompleteness: "complete",
  },
};

// ------------------------------------------------------------------ exports
export const BAND_SCENARIOS: BandScenario[] = [
  sdp320Normal,
  sdp334Training,
  sdp331Community,
  lossyBluetooth,
  reconnectMidVisit,
  participantDirected,
  piiInTranscript,
  emptyRecording,
];

export function getBandScenario(id: string): BandScenario | null {
  return BAND_SCENARIOS.find((s) => s.id === id) ?? null;
}
