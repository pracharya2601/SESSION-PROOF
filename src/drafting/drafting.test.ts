/**
 * Golden tests: three SYNTHETIC calendar/Drive sessions, transcripts built in-test (no real
 * people). Demo drafter → validateExtraction → Drive context frozen into config → assembleBundle
 * → note / checklist / invoice / PDF. Rule-based, deterministic.
 */
import { describe, expect, it } from "vitest";
import type {
  Appointment,
  BundleProvenance,
  DriveClientContext,
  EvidenceItem,
  FactClaim,
  ProviderAttestation,
  ServiceConfig,
  SessionBundle,
  SessionFacts,
} from "../contracts";
import { claimRejectionText, ReviewEdits } from "../contracts";
import { validateExtraction } from "../ai";
import { assembleBundle } from "../domain/bundle";
import { BUILTIN_TEMPLATES, buildDocModel, renderDocModelPdf } from "../documents";
import { applyDraftingContext, planForSession, sdpCodeOf, type VisitContext } from "./context";
import { DEMO_DRAFTER_NOTICE, PROGRESS_LEFT_FOR_PROVIDER, demoDraft } from "./demo";
import { findGeneralisations, unsupportedGeneralisations } from "./language";

// ------------------------------------------------------------------ synthetic builders
const PROVIDER = "provider_demo_001";

function appointment(id: string, clientRef: string, serviceCode: string, startAt: string, endAt: string): Appointment {
  return {
    id,
    occurrenceId: `occ_${id}`,
    providerId: PROVIDER,
    clientRef,
    startAt,
    endAt,
    timezone: "America/Los_Angeles",
    serviceCode,
    planVersion: "plan_cal_v1",
    ruleVersion: "rules_cal_v1",
    rateVersion: "rate_cal_v1",
    canceled: false,
  };
}

function baseConfig(serviceCode: string): ServiceConfig {
  return {
    plan: { planVersion: "plan_cal_v1", serviceCode, serviceDescription: "Community Living Supports (synthetic)", goals: [{ goalId: "goal_placeholder", objective: "Placeholder goal." }] },
    rules: {
      ruleVersion: "rules_cal_v1",
      serviceCode,
      required: ["service_date", "provider_identity", "client_reference", "service_description", "goal_addressed", "progress_statement", "confirmed_duration"],
      allowProviderProgressAttestation: true,
    },
    rate: { rateVersion: "rate_cal_v1", currency: "USD", hourlyRateCents: 3000, maxMinutes: 480 },
  };
}

/** [secondsFromStart, durationSec, speaker, text] → evidence items ev_001.. */
function transcript(startAt: string, lines: [number, number, string, string][]): EvidenceItem[] {
  const t0 = Date.parse(startAt);
  return lines.map(([at, dur, speaker, text], i) => ({
    id: `ev_${String(i + 1).padStart(3, "0")}`,
    sourceId: "rec_synthetic",
    sourceMode: "fixture",
    observedFrom: new Date(t0 + at * 1000).toISOString(),
    observedTo: new Date(t0 + (at + dur) * 1000).toISOString(),
    speaker,
    excerpt: text,
    retrievedAt: "2026-11-13T20:00:00.000Z",
  }));
}

function drive(clientRef: string, serviceCode: string, goals: { goalId: string; objective: string }[], auth: DriveClientContext["authorization"]): DriveClientContext {
  return {
    clientRef,
    folder: `Clients/${clientRef}`,
    goals,
    serviceCode,
    authorization: auth,
    documents: [
      { id: `doc_${clientRef}_plan`, name: "Service plan.gdoc", kind: "service_plan", modifiedAt: "2026-10-01T00:00:00.000Z", text: "Goals..." },
      { id: `doc_${clientRef}_auth`, name: "Authorization.pdf", kind: "authorization", modifiedAt: "2026-10-01T00:00:00.000Z", text: "Auth..." },
      {
        id: `doc_${clientRef}_prev`,
        name: "Previous note 2026-11-06.gdoc",
        kind: "previous_note",
        modifiedAt: "2026-11-06T00:00:00.000Z",
        // Context only: this outcome must NEVER appear in today's note.
        text: "Last week the participant cooked a full dinner and can now shop alone every week.",
      },
    ],
  };
}

const provenance = (promptVersion: string): BundleProvenance => ({
  evidenceMode: "fixture",
  extractionMode: "fixture",
  runtimeMode: "local",
  schemaVersion: "1",
  promptVersion,
  model: null,
  evidenceCompleteness: "complete",
  evidenceWarnings: [],
  drafter: { kind: "demo_rule_based", label: "demo drafter (rule-based, not AI)" },
});

const att = (id: string, field: ProviderAttestation["field"], text: string, rev = 2): ProviderAttestation => ({
  id,
  field,
  text,
  actorProviderId: PROVIDER,
  attestedAt: "2026-11-13T21:00:00.000Z",
  bundleRevision: rev,
});

interface Session {
  appointment: Appointment;
  config: ServiceConfig;
  evidence: EvidenceItem[];
  drive: DriveClientContext;
  visit: VisitContext;
}

function draft(s: Session, opts: { facts?: SessionFacts; attestations?: ProviderAttestation[] } = {}): { bundle: SessionBundle; facts: SessionFacts } {
  const config = applyDraftingContext(s.config, s.appointment, { drive: s.drive, visit: s.visit, warnings: [] });
  const ctx = { appointment: s.appointment, plan: planForSession(s.config.plan, s.drive), evidence: s.evidence, driveContext: s.drive };
  const facts = opts.facts ?? validateExtraction(demoDraft(ctx), ctx);
  const ev = s.evidence;
  const bundle = assembleBundle({
    sessionId: `sess_${s.appointment.id}`,
    bundleRevision: opts.attestations?.length ? 2 : 1,
    processingRevision: 1,
    appointment: s.appointment,
    config,
    evidence: ev,
    evidenceWindow: { from: ev[0]!.observedFrom!, to: ev[ev.length - 1]!.observedTo! },
    facts,
    attestations: opts.attestations ?? [],
    provenance: provenance("demo-drafter-v1"),
    createdAt: "2026-11-13T20:00:00.000Z",
  });
  return { bundle, facts };
}

function claimsOf(f: SessionFacts): FactClaim[] {
  return [...f.activities, ...f.observations, ...f.progress, ...f.followUps, ...f.goals.flatMap((g) => g.claims)];
}

// ------------------------------------------------------------------ the 3 sessions
/** 1. SDP 320 Community Living Supports — meals + laundry, no progress language, a commitment. */
const S320: Session = (() => {
  const a = appointment("cal_320_a", "SD-320-A", "CA-SDP-320", "2026-11-13T17:00:00.000Z", "2026-11-13T18:00:00.000Z");
  return {
    appointment: a,
    config: baseConfig("CA-SDP-320"),
    evidence: transcript(a.startAt, [
      [60, 20, "Speaker 0", "Today let's plan the meals for this week and write the shopping list."],
      [300, 15, "Speaker 1", "I want pasta on Monday and soup on Thursday."],
      [600, 20, "Speaker 0", "Good, let's check the cupboard for what we already have."],
      [1200, 20, "Speaker 1", "We have rice and two cans of beans, so I added tomatoes to the list."],
      [1800, 20, "Speaker 0", "Now let's put the laundry in and pick the right setting together."],
      [2400, 15, "Speaker 1", "I picked the cold setting for the dark clothes."],
      [3000, 20, "Speaker 0", "Next visit we will cook the Monday pasta together."],
    ]),
    drive: drive(
      "SD-320-A",
      "CA-SDP-320",
      [
        { goalId: "goal_meal_planning", objective: "Plan and prepare a simple weekly meal with decreasing prompts." },
        { goalId: "goal_laundry", objective: "Complete a laundry cycle independently." },
        { goalId: "goal_schedule", objective: "Keep a personal weekly schedule up to date." },
      ],
      { number: "AUTH-SYN-320-A", fundingSource: "SDP budget (synthetic)", hourlyRateCents: 3850, authorizedMinutesPerMonth: 1200, validFrom: "2026-07-01", validTo: "2027-06-30" },
    ),
    visit: {
      location: "Participant home (synthetic address)",
      consent: { recordedAt: "2026-11-13T16:59:00.000Z", method: "phone_checkbox", confirmedBy: PROVIDER },
      minutesUsedThisMonth: 540,
    },
  };
})();

/** 2. SDP 334 Training — budgeting; explicit progress language AND a generalising sentence. */
const S334: Session = (() => {
  const a = appointment("cal_334_b", "SD-334-B", "CA-SDP-334", "2026-11-13T19:00:00.000Z", "2026-11-13T19:45:00.000Z");
  return {
    appointment: a,
    config: baseConfig("CA-SDP-334"),
    evidence: transcript(a.startAt, [
      [30, 20, "Speaker 0", "Let's go over your receipts and the budget sheet."],
      [600, 20, "Speaker 0", "You counted the cash and it matched the receipt without any help."],
      [1200, 20, "Speaker 1", "I always pay every bill on time now."],
      [1800, 20, "Speaker 0", "Next week I will bring a bus fare card so we can practise the route."],
    ]),
    drive: drive(
      "SD-334-B",
      "CA-SDP-334",
      [
        { goalId: "goal_budget", objective: "Track spending against a monthly budget using receipts." },
        { goalId: "goal_transit", objective: "Ride the bus route to the community college." },
      ],
      { number: "AUTH-SYN-334-B", fundingSource: "SDP budget (synthetic)", hourlyRateCents: 4200, authorizedMinutesPerMonth: 600, validFrom: "2026-01-01", validTo: "2026-12-31" },
    ),
    visit: { location: null, consent: null, minutesUsedThisMonth: 570 },
  };
})();

/** 3. SDP 313 Homemaker — EVV code, no location / consent stored, no goal matches. */
const S313: Session = (() => {
  const a = appointment("cal_313_c", "SD-313-C", "CA-SDP-313", "2026-11-14T16:00:00.000Z", "2026-11-14T16:30:00.000Z");
  return {
    appointment: a,
    config: baseConfig("CA-SDP-313"),
    evidence: transcript(a.startAt, [
      [10, 10, "Speaker 0", "Hello, how are you feeling today?"],
      [120, 10, "Speaker 1", "Fine thanks, a bit tired."],
    ]),
    drive: drive(
      "SD-313-C",
      "CA-SDP-313",
      [{ goalId: "goal_kitchen", objective: "Keep the kitchen clean and the dishes washed." }],
      { number: "AUTH-SYN-313-C", fundingSource: "SDP budget (synthetic)", hourlyRateCents: 2500, authorizedMinutesPerMonth: null, validFrom: "2026-01-01", validTo: "2026-12-31" },
    ),
    visit: {},
  };
})();

const item = (b: SessionBundle, id: string) => b.checks.checklist!.items.find((i) => i.id === id)!;
const blockingCodes = (b: SessionBundle) => b.checks.issues.filter((i) => i.blocking).map((i) => i.code).sort();

// ------------------------------------------------------------------ tests
describe("demo drafter — every claim cites session evidence", () => {
  for (const s of [S320, S334, S313]) {
    it(`${s.appointment.clientRef}: all claims cite known segments; none cite Drive documents`, () => {
      const { facts } = draft(s);
      const ids = new Set(s.evidence.map((e) => e.id));
      for (const c of claimsOf(facts)) {
        expect(c.evidenceIds.length, c.id).toBeGreaterThan(0);
        expect(c.evidenceIds.every((id) => ids.has(id)), c.id).toBe(true);
        expect(c.support).toBe("supported");
      }
      expect(facts.missingInformation[0]).toBe(DEMO_DRAFTER_NOTICE);
      // Previous notes are context only: their outcomes never reach the note.
      expect(JSON.stringify(facts)).not.toContain("full dinner");
      expect(JSON.stringify(facts)).not.toContain("shop alone");
    });
  }

  it("320: drafts goals, activities, observations and a follow-up; leaves progress to the provider", () => {
    const { facts } = draft(S320);
    const g = Object.fromEntries(facts.goals.map((x) => [x.goalId, x]));
    expect(g.goal_meal_planning!.status).toBe("addressed");
    expect(g.goal_meal_planning!.claims.flatMap((c) => c.evidenceIds)).toEqual(expect.arrayContaining(["ev_001"]));
    expect(g.goal_laundry!.status).toBe("addressed");
    expect(g.goal_laundry!.claims.flatMap((c) => c.evidenceIds).sort()).toEqual(["ev_005", "ev_006"]);
    expect(g.goal_schedule!.status).toBe("unknown");
    expect(facts.activities.length).toBeGreaterThanOrEqual(2);
    expect(facts.observations.map((c) => c.evidenceIds[0])).toEqual(expect.arrayContaining(["ev_006"]));
    expect(facts.followUps).toHaveLength(1);
    expect(facts.followUps[0]!.evidenceIds).toEqual(["ev_007"]);
    expect(facts.progress).toEqual([]);
    expect(facts.missingInformation).toContain(PROGRESS_LEFT_FOR_PROVIDER);
  });

  it("334: explicit progress language is drafted; the generalising sentence is refused", () => {
    const { facts } = draft(S334);
    expect(facts.progress).toHaveLength(1);
    expect(facts.progress[0]!.evidenceIds).toEqual(["ev_002"]);
    expect(JSON.stringify(facts)).not.toContain("every bill");
    expect(facts.missingInformation.some((m) => m.includes("generalises beyond this session") && m.includes("ev_003"))).toBe(true);
    expect(facts.followUps.map((c) => c.evidenceIds[0])).toEqual(["ev_004"]);
  });

  it("313: nothing matches the goal → no goal claim, goal unknown, honest gaps", () => {
    const { facts } = draft(S313);
    expect(facts.goals).toEqual([{ goalId: "goal_kitchen", status: "unknown", claims: [] }]);
    expect(facts.progress).toEqual([]);
    expect(facts.missingInformation.some((m) => m.includes("goal_kitchen"))).toBe(true);
  });
});

describe("CLAIM_EXCEEDS_EVIDENCE — generalisation is refused", () => {
  it("language helpers", () => {
    expect(findGeneralisations("Robin can now plan meals independently every week").map((g) => g.label)).toEqual(["every …", "independently", "can now"]);
    expect(unsupportedGeneralisations("can now do it", ["I can now do it"])).toEqual([]);
    expect(unsupportedGeneralisations("No longer needs prompts", ["needed one prompt"]).map((g) => g.label)).toEqual(["no longer needs"]);
  });

  it("a claim citing a real segment that does not say it → blocking, claim listed, line marked REFUSED", () => {
    const { facts } = draft(S320);
    const bad: FactClaim = { id: "llm_prog_1", text: "Robin can now plan meals independently every week.", evidenceIds: ["ev_001"], support: "supported" };
    const { bundle } = draft(S320, { facts: { ...facts, progress: [bad] } });
    const issue = bundle.checks.issues.find((i) => i.code === "CLAIM_EXCEEDS_EVIDENCE")!;
    expect(issue).toMatchObject({ blocking: true, field: "claim:llm_prog_1" });
    expect(issue.message).toContain("Robin can now plan meals independently every week.");
    expect(issue.message).toContain('"every week"');
    expect(bundle.checks.canApprove).toBe(false);
    const progress = bundle.documents.sections.find((s) => s.key === "progress_record")!.lines;
    expect(progress[0]!.text.startsWith("REFUSED — exceeds the session evidence: ")).toBe(true);
    expect(item(bundle, "doc_claims_within_evidence")).toMatchObject({ status: "fail", value: "llm_prog_1", blocksApproval: true });
    // Even with every other requirement satisfied, the refusal still blocks.
    const { bundle: b2 } = draft(S320, {
      facts: { ...facts, progress: [bad] },
      attestations: [att("a_p", "progress", "Planned two meals with one prompt."), att("a_d", "duration", "55")],
    });
    expect(blockingCodes(b2)).toEqual(["CLAIM_EXCEEDS_EVIDENCE"]);
  });

  it("the same words are fine when the cited segment says them (a quote)", () => {
    const { facts } = draft(S334);
    const quoted: FactClaim = { id: "q1", text: 'Speaker 1: "I always pay every bill on time now."', evidenceIds: ["ev_003"], support: "uncertain" };
    const { bundle } = draft(S334, { facts: { ...facts, observations: [quoted] } });
    expect(bundle.checks.issues.some((i) => i.code === "CLAIM_EXCEEDS_EVIDENCE")).toBe(false);
  });

  it("provider attestations are never refused as evidence, but are labelled and advised", () => {
    const { bundle } = draft(S320, {
      attestations: [att("a_p", "progress", "Robin can now shop alone every week."), att("a_d", "duration", "55")],
    });
    const adv = bundle.checks.issues.find((i) => i.code === "PROVIDER_GENERALISATION")!;
    expect(adv.blocking).toBe(false);
    expect(adv.message.startsWith("Provider-confirmed (not evidence)")).toBe(true);
    expect(bundle.checks.canApprove).toBe(true);
  });
});

describe("checklist states", () => {
  it("320 draft (no attestations): grouped pass/warn/fail; EVV required and complete", () => {
    const { bundle } = draft(S320);
    const cl = bundle.checks.checklist!;
    expect(cl).toMatchObject({ sdpCode: "320", evvRequired: true });
    expect(item(bundle, "invoice_date")).toMatchObject({ status: "pass", value: "2026-11-13" });
    expect(item(bundle, "invoice_sdp_code")).toMatchObject({ status: "pass", value: "320", source: "drive" });
    expect(item(bundle, "invoice_rate")).toMatchObject({ status: "pass", value: "$38.50/hr", source: "drive" });
    expect(item(bundle, "invoice_tasks").status).toBe("pass");
    expect(item(bundle, "invoice_time_per_task")).toMatchObject({ status: "fail", blocksApproval: true });
    expect(item(bundle, "invoice_total")).toMatchObject({ status: "fail", blocksApproval: true });
    expect(item(bundle, "invoice_services_statement")).toMatchObject({ status: "pass", source: "provider_attestation" });
    expect(item(bundle, "doc_goals_addressed")).toMatchObject({ status: "warn", value: "2 of 3" });
    expect(item(bundle, "doc_progress")).toMatchObject({ status: "fail", blocksApproval: true });
    expect(item(bundle, "consent_recorded").status).toBe("pass");
    for (const id of ["evv_service_type", "evv_client_id", "evv_date", "evv_location", "evv_worker_id", "evv_start_end"]) {
      expect(item(bundle, id).status, id).toBe("pass");
    }
    expect(item(bundle, "evv_location").value).toBe("Participant home (synthetic address)");
    expect(item(bundle, "time_billed_vs_recorded").status).toBe("warn");
    expect(blockingCodes(bundle)).toEqual(["MISSING_CONFIRMED_DURATION", "MISSING_PROGRESS"]);
    expect(cl.summary.pass + cl.summary.warn + cl.summary.fail).toBe(cl.items.length);
  });

  it("320 after review: billed > recorded + 10 % warns; within passes", () => {
    const ok = draft(S320, { attestations: [att("a_p", "progress", "Chose two meals with one prompt."), att("a_d", "duration", "55")] }).bundle;
    // recorded span ev_001 start (17:01:00) → ev_007 end (17:50:20) = 49.3 min; 55 ≤ 54.3? no → warn
    expect(item(ok, "time_billed_vs_recorded").status).toBe("warn");
    const fine = draft(S320, { attestations: [att("a_p", "progress", "Chose two meals with one prompt."), att("a_d", "duration", "50")] }).bundle;
    expect(item(fine, "time_billed_vs_recorded").status).toBe("pass");
    expect(fine.checks.canApprove).toBe(true);
    expect(item(fine, "doc_progress")).toMatchObject({ status: "warn", value: "Provider-confirmed (not evidence)", source: "provider_attestation" });
  });

  it("334: not an EVV code; no consent stored → warn; progress from evidence passes", () => {
    const { bundle } = draft(S334);
    expect(bundle.checks.checklist!.evvRequired).toBe(false);
    expect(item(bundle, "evv_not_required").status).toBe("pass");
    expect(item(bundle, "consent_recorded")).toMatchObject({ status: "warn", blocksApproval: false });
    expect(item(bundle, "doc_progress")).toMatchObject({ status: "pass", source: "evidence" });
  });

  it("313: EVV code with no location → EVV location fails (non-blocking); no goal → fail", () => {
    const { bundle } = draft(S313);
    expect(bundle.checks.checklist!.evvRequired).toBe(true);
    expect(item(bundle, "evv_location")).toMatchObject({ status: "fail", value: null, blocksApproval: false });
    expect(item(bundle, "evv_worker_id")).toMatchObject({ status: "pass", value: PROVIDER });
    expect(item(bundle, "doc_goals_addressed")).toMatchObject({ status: "fail", blocksApproval: true });
    expect(item(bundle, "invoice_tasks")).toMatchObject({ status: "fail", blocksApproval: true });
    expect(item(bundle, "time_authorization_remaining").status).toBe("warn");
  });
});

describe("invoice math", () => {
  it("320: authorization rate, lines sum to the total, remaining minutes this month", () => {
    const { bundle } = draft(S320, { attestations: [att("a_p", "progress", "Chose two meals with one prompt."), att("a_d", "duration", "50")] });
    const inv = bundle.billing.invoice!;
    expect(bundle.config.rate).toMatchObject({ hourlyRateCents: 3850, rateVersion: "auth:AUTH-SYN-320-A" });
    expect(inv).toMatchObject({ sdpCode: "320", rateSource: "drive_authorization", hourlyRateCents: 3850, isEstimate: false });
    // 50 min × $38.50/h = $32.0833… → 3208 cents (half-up)
    expect(inv.totalCents).toBe(3208);
    expect(bundle.billing.amountCents).toBe(3208);
    expect(inv.lines.reduce((a, l) => a + (l.amountCents ?? 0), 0)).toBe(3208);
    expect(inv.lines.reduce((a, l) => a + (l.billedMinutes ?? 0), 0)).toBe(50);
    expect(inv.lines.map((l) => l.goalId)).toEqual(expect.arrayContaining(["goal_meal_planning", "goal_laundry"]));
    expect(inv.lines.every((l) => l.serviceCode === "320" && l.serviceDate === "2026-11-13")).toBe(true);
    // 1200 authorized − 540 used − 50 this session
    expect(inv.authorization).toMatchObject({ number: "AUTH-SYN-320-A", serviceDateInRange: true, usedMinutesBeforeSession: 540, remainingMinutesAfterSession: 610 });
    expect(item(bundle, "time_authorization_remaining")).toMatchObject({ status: "pass", value: "610 of 1200 min" });
    expect(inv.attestationStatement).toBe("All services specified in this invoice have been provided to the participant.");
    expect(inv.attestationLabel).toContain("provider-confirmed (not evidence)");
  });

  it("334: over the monthly authorization fails; estimates before confirmation", () => {
    const draft1 = draft(S334).bundle.billing.invoice!;
    expect(draft1).toMatchObject({ isEstimate: true, totalCents: null });
    expect(draft1.lines.every((l) => l.billedMinutes === null && l.amountCents === null)).toBe(true);
    // estimated remaining uses the scheduled 45 min: 600 − 570 − 45
    expect(draft1.authorization!.remainingMinutesAfterSession).toBe(-15);
    const { bundle } = draft(S334, { attestations: [att("a_d", "duration", "40")] });
    expect(bundle.billing.invoice!.totalCents).toBe(2800); // 40 × $42/h
    expect(bundle.billing.invoice!.authorization!.remainingMinutesAfterSession).toBe(-10);
    expect(item(bundle, "time_authorization_remaining")).toMatchObject({ status: "fail" });
  });

  it("rounding rule is configurable (default exact)", () => {
    const s: Session = { ...S320, config: { ...S320.config } };
    const exact = draft(s, { attestations: [att("a_d", "duration", "50")] }).bundle;
    expect(exact.billing.invoice!.rounding).toEqual({ rule: "exact", confirmedMinutes: 50, billedMinutes: 50 });
    const cfg = applyDraftingContext(s.config, s.appointment, { drive: s.drive, visit: s.visit, warnings: [] });
    const rounded = assembleBundle({
      ...{
        sessionId: "sess_r",
        bundleRevision: 2,
        processingRevision: 1,
        appointment: s.appointment,
        evidence: s.evidence,
        evidenceWindow: null,
        facts: draft(s).facts,
        provenance: provenance("demo-drafter-v1"),
        createdAt: "2026-11-13T20:00:00.000Z",
      },
      config: { ...cfg, rate: { ...cfg.rate, minuteRounding: "nearest_15" } },
      attestations: [att("a_d", "duration", "52")],
    });
    expect(rounded.billing.invoice!.rounding).toEqual({ rule: "nearest_15", confirmedMinutes: 52, billedMinutes: 45 });
    expect(rounded.billing.confirmedMinutes).toBe(52);
    expect(rounded.billing.amountCents).toBe(2888); // 45 × $38.50/h = 28.875 → 2888
    expect(rounded.billing.invoice!.totalCents).toBe(2888);
  });

  it("sdpCodeOf", () => {
    expect(sdpCodeOf("CA-SDP-320")).toBe("320");
    expect(sdpCodeOf("320")).toBe("320");
    expect(sdpCodeOf("svc_ils_individual")).toBeNull();
    expect(sdpCodeOf("CA-RC-520")).toBeNull();
  });
});

describe("provider attestation labelling + documents", () => {
  it("note lines, coverage and the invoice line label provider input as provider-confirmed (not evidence)", () => {
    const { bundle } = draft(S313, {
      attestations: [att("a_g", "goal_addressed", "goal_kitchen"), att("a_s", "activity_summary", "Washed dishes together."), att("a_d", "duration", "30")],
    });
    const note = bundle.documents.sections.find((s) => s.key === "session_note")!.lines;
    expect(note).toContainEqual(expect.objectContaining({ text: "Goal addressed (provider-confirmed, not evidence): Keep the kitchen clean and the dishes washed.", origin: "provider_attestation" }));
    expect(note).toContainEqual(expect.objectContaining({ text: "Activity summary (provider-written, not evidence): Washed dishes together." }));
    const cov = bundle.documents.sections.find((s) => s.key === "plan_coverage")!.lines[0]!;
    expect(cov.text).toContain("Addressed (provider-confirmed, not evidence)");
    const line = bundle.billing.invoice!.lines[0]!;
    expect(line).toMatchObject({ source: "provider_attestation", evidenceIds: [] });
    expect(line.taskDescription).toContain("provider-confirmed, not evidence");
    expect(item(bundle, "doc_goals_addressed")).toMatchObject({ status: "pass", source: "provider_attestation" });
  });

  it("session note + invoice DocModels carry the checklist and per-task lines; PDFs render", async () => {
    const { bundle } = draft(S320, { attestations: [att("a_p", "progress", "Chose two meals with one prompt."), att("a_d", "duration", "50")] });
    const base = { bundle, final: null, approval: null, providerIdentity: null, client: null };
    const note = buildDocModel("session_note", { ...base, template: BUILTIN_TEMPLATES.session_note });
    const noteText = JSON.stringify(note.blocks);
    expect(noteText).toContain("Participant home (synthetic address)"); // location from the calendar (test input)
    expect(noteText).toContain("Provider attestation");
    const inv = buildDocModel("invoice", { ...base, template: BUILTIN_TEMPLATES.invoice });
    const invText = JSON.stringify(inv.blocks);
    expect(invText).toContain("Support toward goal: Plan and prepare a simple weekly meal with decreasing prompts.");
    expect(invText).toContain("Authorization # AUTH-SYN-320-A");
    expect(invText).toContain("Remaining after this invoice");
    expect(invText).toContain("All services specified in this invoice have been provided to the participant.");
    const rec = buildDocModel("approval_record", { ...base, template: BUILTIN_TEMPLATES.approval_record });
    expect(JSON.stringify(rec.blocks)).toContain("Session checklist (checklist-v1)");
    expect(JSON.stringify(rec.blocks)).toContain("demo drafter (rule-based, not AI)");
    for (const m of [note, inv, rec]) {
      const pdf = await renderDocModelPdf(m);
      expect(pdf.byteLength).toBeGreaterThan(1000);
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    }
  });
});

describe("provider-rejected claims (claim_rejected attestations)", () => {
  it("a removed claim leaves the note, invoice lines and coverage, clears its refusal, and stays in the audit trail", () => {
    const { facts } = draft(S320);
    const bad: FactClaim = { id: "llm_prog_1", text: "Robin can now plan meals independently every week.", evidenceIds: ["ev_001"], support: "supported" };
    const withBad = { ...facts, progress: [bad] };
    const laundry = facts.goals.find((g) => g.goalId === "goal_laundry")!.claims.map((c) => c.id);
    const rej = (claimId: string, i: number) => att(`a_rej_${i}`, "claim_rejected", claimRejectionText(claimId, "Not what happened"));
    const { bundle } = draft(S320, {
      facts: withBad,
      attestations: [
        rej("llm_prog_1", 1),
        ...laundry.map((id, i) => rej(id, i + 2)),
        rej(facts.activities.find((a) => a.text.includes("laundry"))!.id, 9),
        att("a_p", "progress", "Chose two meals with one prompt."),
        att("a_d", "duration", "50"),
      ],
    });
    expect(bundle.checks.issues.some((i) => i.code === "CLAIM_EXCEEDS_EVIDENCE")).toBe(false);
    expect(bundle.checks.canApprove).toBe(true);
    const text = JSON.stringify(bundle.documents.sections);
    expect(text).not.toContain("can now plan meals");
    const lineClaims = new Set(bundle.documents.sections.flatMap((sec) => sec.lines.flatMap((l) => l.claimIds)));
    for (const id of ["llm_prog_1", ...laundry]) expect(lineClaims.has(id), id).toBe(false);
    expect(bundle.facts.goals.find((g) => g.goalId === "goal_laundry")!.status).toBe("unknown");
    expect(bundle.documents.planCoverage.find((g) => g.goalId === "goal_laundry")!.status).toBe("unknown");
    expect(bundle.billing.invoice!.lines.some((l) => l.goalId === "goal_laundry")).toBe(false);
    expect(item(bundle, "doc_goals_addressed").value).toBe("1 of 3");
    // audit: extracted facts keep the claim; the checklist lists it as removed with the reason
    expect(bundle.extractedFacts.progress[0]!.id).toBe("llm_prog_1");
    expect(bundle.checks.checklist!.rejectedClaims!.map((r) => [r.claimId, r.reason])).toContainEqual(["llm_prog_1", "Not what happened"]);
    const rec = buildDocModel("approval_record", { bundle, final: null, approval: null, providerIdentity: null, client: null, template: BUILTIN_TEMPLATES.approval_record });
    expect(JSON.stringify(rec.blocks)).toContain("llm_prog_1 — removed by provider: Not what happened");
  });

  it("ReviewEdits.rejectedClaims validates shape", () => {
    expect(ReviewEdits.safeParse({ rejectedClaims: [{ claimId: "c1", reason: "Overstated" }] }).success).toBe(true);
    expect(ReviewEdits.safeParse({ rejectedClaims: [{ claimId: "c1", reason: "no" }] }).success).toBe(false);
    expect(ReviewEdits.safeParse({ rejectedClaims: [{ claimId: "c1", reason: "abc" }, { claimId: "c1", reason: "abcd" }] }).success).toBe(false);
    expect(ReviewEdits.safeParse({ rejectedClaims: [{ claimId: "a\nb", reason: "abcd" }] }).success).toBe(false);
  });
});

