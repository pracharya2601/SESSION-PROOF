/**
 * A REAL band transcript (Deepgram relay; here a fake Deepgram session) with no AI key
 * (EXTRACTION_MODE=fixture) and no scenario: extraction is "transcript-only" (no claims,
 * every goal unknown), so r1 is blocked. The provider confirms the addressed goal, writes
 * an activity summary and progress, confirms minutes → approvable → COMPLETED, and the
 * documents label those as provider confirmed / provider written.
 * Real modules + Miniflare D1; the WebSocket is replaced by direct CaptureSession calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createVisitStore } from "../../src/band/store";
import { CaptureSession } from "../../src/band/capture";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import { getScenarioLookup } from "../../src/band/scenarios-registry";
import { TRANSCRIPT_ONLY_NOTICE, TRANSCRIPT_ONLY_PROMPT_VERSION, withScenarioExtraction } from "../../src/band/scenario-extractor";
import type { TranscriberEvents, TranscriberSession } from "../../src/band/transcriber";
import type { VisitServerMessage } from "../../src/contracts";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

function packet(seq: number): Uint8Array {
  const b = new Uint8Array(42);
  b[0] = (seq >> 8) & 0xff;
  b[1] = seq & 0xff;
  b.fill(0xab, 2);
  return b;
}

const LINES = [
  { atSec: 1, text: "Let's look at the bus timetable for the library trip.", speaker: "Speaker 0" },
  { atSec: 4, text: "The number twelve stops right outside.", speaker: "Speaker 1" },
  { atSec: 7, text: "Good, we'll try the trip next week.", speaker: "Speaker 0" },
];

/** Stands in for openDeepgram: emits one final per line once the audio reaches it. */
function fakeDeepgram(events: TranscriberEvents): TranscriberSession {
  let next = 0;
  const emit = () => {
    const l = LINES[next++]!;
    events.onFinal({ startSec: l.atSec, endSec: l.atSec + 2, text: l.text, speaker: l.speaker });
  };
  return {
    kind: "deepgram",
    feed(_opus, i) {
      while (next < LINES.length && i * 0.02 >= LINES[next]!.atSec + 2) emit();
    },
    keepAlive() {},
    async finish() {
      while (next < LINES.length) emit();
    },
    close() {},
  };
}

async function setup() {
  const hh = await createV3Harness();
  const anyH = hh as any;
  const store = createVisitStore(hh.db);
  anyH.apiDeps.visits = { store, enqueueAppointment: (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt) };
  // Deepgram "configured" so a new visit uses the deepgram relay; the socket itself is faked below.
  (hh.env as any).DEEPGRAM_API_KEY = "test-key-not-used";
  const deliveryDeps = { repo: hh.repo, env: hh.env, clock: hh.clock, fetch: anyH.cloud.fetch };
  const deps = {
    repo: hh.repo,
    evidence: new VisitRoutingEvidenceSource(new BandEvidenceSource(store, () => hh.clock.now()), hh.mods.vexo.createEvidenceSource(hh.env)),
    // Mirror src/index.ts: the fixture extractor wrapped for band visits.
    extractor: withScenarioExtraction(hh.mods.ai.createExtractor(hh.env, { retryDelayMs: 0 }), store, getScenarioLookup),
    match: hh.mods.domain.matchEvidence,
    assemble: hh.mods.domain.assembleBundle,
    clock: hh.clock,
    runtimeMode: "local",
    resolveClient: async (appt: { providerId: string; clientRef: string }) => hh.repo.getClient(appt.providerId, appt.clientRef),
    onCompleted: (sessionId: string) => anyH.v2.delivery.onSessionCompleted(deliveryDeps, sessionId),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(deps, params, step);
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, store, cookie };
}

describe("band visit, real transcript, no AI extraction", () => {
  it("transcript-only draft → provider confirms goal + summary + progress + minutes → COMPLETED", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;

    const start = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: 3, transport: "ble" } });
    expect(start.status, start.text).toBe(201);
    const visit = start.json.data.visit;
    expect(visit).toMatchObject({ transcriber: "deepgram", scenario: null });

    const sent: VisitServerMessage[] = [];
    const audioStartMs = hh.clock.now().getTime() + 1000;
    const session = new CaptureSession({
      visit,
      store,
      openTranscriber: async (events) => fakeDeepgram(events),
      send: (m) => sent.push(m),
      now: () => hh.clock.now(),
    });
    await session.open();
    expect(sent[0]).toEqual({ type: "ready", transcriber: "deepgram" });
    await session.onText(JSON.stringify({ type: "start", audioStartMs }));
    for (let seq = 0; seq < 500; seq++) session.onBinary(packet(seq));
    expect(await session.onText(JSON.stringify({ type: "stop" }))).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "done", segmentCount: 3 });

    hh.clock.advance(20_000);
    const stop = await hh.req(`/api/visits/${visit.id}/stop`, { method: "POST", cookie });
    expect(stop.status, stop.text).toBe(200);
    const sessionId: string = stop.json.data.sessionId;
    await hh.settle();

    // ---- r1: transcript-only draft
    const d = await hh.req(`/api/sessions/${sessionId}`, { cookie });
    expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
    const b1 = d.json.data.bundle;
    expect(b1.evidence.map((e: any) => [e.id, e.excerpt, e.speaker, e.sourceMode])).toEqual(
      LINES.map((l, i) => [`ev_00${i + 1}`, l.text, l.speaker, "live"]),
    );
    expect(b1.provenance).toMatchObject({ evidenceMode: "live", evidenceCompleteness: "complete", promptVersion: TRANSCRIPT_ONLY_PROMPT_VERSION, model: null });
    expect(b1.provenance.evidenceWarnings).toEqual([]);
    expect(b1.extractedFacts).toMatchObject({ activities: [], observations: [], progress: [], followUps: [], missingInformation: [TRANSCRIPT_ONLY_NOTICE] });
    expect(b1.extractedFacts.goals.every((g: any) => g.status === "unknown" && g.claims.length === 0)).toBe(true);
    const blocking = (b1.checks.issues as any[]).filter((i) => i.blocking).map((i) => i.code).sort();
    expect(blocking).toEqual(["MISSING_CONFIRMED_DURATION", "MISSING_PROGRESS", "MISSING_SERVICE_DESCRIPTION", "NO_GOAL_ADDRESSED"]);
    const goalId: string = b1.config.plan.goals[0].goalId;
    const objective: string = b1.config.plan.goals[0].objective;

    // ---- review validation: strict ReviewEdits, plan goal ids only
    const bad = async (edits: unknown) =>
      (await hh.req(`/api/sessions/${sessionId}/review`, { method: "PATCH", cookie, body: { expectedRevision: 1, edits } })).status;
    expect(await bad({ goalsAddressed: ["goal_not_in_plan"] })).toBe(422);
    expect(await bad({ goalsAddressed: [goalId, goalId] })).toBe(400);
    expect(await bad({ goalsAddressed: Array.from({ length: 21 }, (_, i) => `g${i}`) })).toBe(400);
    expect(await bad({ activitySummary: "" })).toBe(400);
    expect(await bad({ activitySummary: "x".repeat(2001) })).toBe(400);
    expect(await bad({ goalStatus: "addressed" })).toBe(400);

    // ---- review → no blockers
    hh.clock.advance(60_000);
    const summary = "Planned the bus trip to the library using the timetable.";
    const review = await hh.req(`/api/sessions/${sessionId}/review`, {
      method: "PATCH",
      cookie,
      body: {
        expectedRevision: 1,
        edits: { goalsAddressed: [goalId], progressConfirmation: "Found the right bus stop independently.", confirmedMinutes: 45, activitySummary: summary },
      },
    });
    expect(review.status, review.text).toBe(200);
    const b2 = review.json.data;
    expect(b2.checks.issues.filter((i: any) => i.blocking)).toEqual([]);
    expect(b2.checks.canApprove).toBe(true);
    expect(b2.documents.planCoverage.find((g: any) => g.goalId === goalId)).toMatchObject({ status: "addressed", support: "provider_confirmed" });
    const cov = b2.documents.sections.find((s: any) => s.key === "plan_coverage").lines.find((l: any) => l.text.startsWith(objective));
    expect(cov).toMatchObject({ origin: "provider_attestation", evidenceIds: [] });
    expect(cov.text).toContain("Addressed (provider confirmed)");

    // ---- approve → COMPLETED, files
    hh.clock.advance(60_000);
    const approve = await hh.req(`/api/sessions/${sessionId}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: b2.bundleRevision, idempotencyKey: `band-transcript-only-${b2.bundleRevision}` },
    });
    expect([200, 202], approve.text).toContain(approve.status);
    await hh.settle();
    const fin = await hh.req(`/api/sessions/${sessionId}`, { cookie });
    expect(fin.json.data.session.status).toBe("COMPLETED");

    const pdf = await hh.req(`/api/sessions/${sessionId}/files/invoice`, { cookie });
    expect(pdf.status, pdf.text.slice(0, 200)).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 4))).toBe("%PDF");

    const note = await hh.req(`/api/sessions/${sessionId}/documents/session_note`, { cookie });
    expect(note.status, note.text).toBe(200);
    const items = (note.json.data.blocks as any[]).flatMap((b) => (b.type === "list" ? b.items : []));
    expect(items).toContainEqual({ text: `Goal addressed (provider confirmed): ${objective}`, tag: "Provider confirmed" });
    expect(items).toContainEqual({ text: `Activity summary (provider written): ${summary}`, tag: "Provider written" });
    const table = (note.json.data.blocks as any[]).find((b) => b.type === "table");
    expect(table.rows.find((r: string[]) => r[0] === goalId)[2]).toBe("Addressed (provider confirmed)");
  });
});
