/**
 * Every SYNTHETIC band scenario (fixtures/band) through the whole pipeline, in-process:
 * start visit → stream packets (CaptureSession, simulated transcriber playing the
 * scenario script) → stop → queue → workflow (run history recorded) → evidence →
 * scenario fixture extraction → checks → billing → provider review → approval →
 * finalization → files. Each scenario is compared against its own `expect`.
 *
 * Real modules + Miniflare D1; the WebSocket is replaced by direct CaptureSession calls.
 * Wiring mirrors src/index.ts: VisitRoutingEvidenceSource, withScenarioExtraction around
 * the extractor, a scenario lookup registered from fixtures/band, seedBandScenarios, and
 * a RunRecorder on workflow + api + jobs.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createVisitStore } from "../../src/band/store";
import { CaptureSession } from "../../src/band/capture";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import { openSimulated } from "../../src/band/transcriber";
import { getScenarioLookup, setScenarioLookup } from "../../src/band/scenarios-registry";
import { SCENARIO_PROMPT_VERSION, withScenarioExtraction } from "../../src/band/scenario-extractor";
import { createRunRecorder } from "../../src/history";
import { BAND_SCENARIOS, getBandScenario, seedBandScenarios, type BandScenario } from "../../fixtures/band";
import type { VisitServerMessage } from "../../src/contracts";

const PACKETS_PER_SEC = 50;

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});
afterAll(() => setScenarioLookup(null));

function packet(seq: number, bytes = 40): Uint8Array {
  const b = new Uint8Array(2 + bytes);
  b[0] = (seq >> 8) & 0xff;
  b[1] = seq & 0xff;
  b.fill(0xab, 2);
  return b;
}

async function setup() {
  const hh = await createV3Harness();
  const anyH = hh as any;
  const store = createVisitStore(hh.db);
  anyH.apiDeps.visits = {
    store,
    enqueueAppointment: (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt),
  };

  // Mirror src/index.ts ensureDevScenarios: the lookup comes from fixtures/band.
  setScenarioLookup((id) => {
    const s = getBandScenario(id);
    return s ? { script: s.script, extraction: s.extraction } : null;
  });

  // Run history with strictly increasing timestamps, so GET /api/runs/:id order = record order
  // (the store orders by at_ms, then id; the fake clock would otherwise tie every event).
  let last = 0;
  const tickClock = {
    now: () => {
      last = Math.max(hh.clock.now().getTime(), last + 1);
      return new Date(last);
    },
  };
  const recorder = createRunRecorder(hh.repo, tickClock);
  anyH.apiDeps.recorder = recorder;
  anyH.jobs.recorder = recorder;

  const resolveClient = async (appt: { providerId: string; clientRef: string }) => hh.repo.getClient(appt.providerId, appt.clientRef);
  const extractor = withScenarioExtraction(
    hh.mods.ai.createExtractor(hh.env, {
      retryDelayMs: 0,
      resolveSettings: async (pid: string) => (await hh.repo.getAiSettings(pid)) ?? anyH.v2.settings.defaultAiSettings(hh.env),
      resolveKnownTerms: async (appt: any) => hh.v3.clients.clientKnownTerms(await hh.repo.getClient(appt.providerId, appt.clientRef)),
    }),
    store,
    getScenarioLookup, // same registry src/index.ts reads
  );
  const deliveryDeps = { repo: hh.repo, env: hh.env, clock: hh.clock, fetch: anyH.cloud.fetch, recorder };
  const deps = {
    repo: hh.repo,
    evidence: new VisitRoutingEvidenceSource(new BandEvidenceSource(store, () => hh.clock.now()), hh.mods.vexo.createEvidenceSource(hh.env)),
    extractor,
    match: hh.mods.domain.matchEvidence,
    assemble: hh.mods.domain.assembleBundle,
    clock: hh.clock,
    runtimeMode: "local",
    recorder,
    resolveClient,
    onCompleted: (sessionId: string) => anyH.v2.delivery.onSessionCompleted(deliveryDeps, sessionId),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(deps, params, step);

  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  await seedBandScenarios(hh.repo, { now: hh.clock.now() });
  const cookie = await hh.login();
  return { hh, store, cookie };
}

/** Streams scenario.audio through one CaptureSession: 50 packets/s, drops skipped, reconnects re-start. */
async function stream(s: BandScenario, session: CaptureSession, audioStartMs: number) {
  const total = s.audio.seconds * PACKETS_PER_SEC;
  const drops = s.audio.dropPackets ?? [];
  const reconnects = new Set((s.audio.reconnectAtSec ?? []).map((sec) => sec * PACKETS_PER_SEC));
  await session.onText(JSON.stringify({ type: "start", audioStartMs }));
  let seq = 0;
  for (let i = 0; i < total; i++) {
    if (reconnects.has(i)) {
      // Band reconnected: seq restarts at 0, start carries the wall clock of the new packet 0.
      await session.onText(JSON.stringify({ type: "start", audioStartMs: audioStartMs + i * 20 }));
      seq = 0;
    }
    const dropped = drops.some(([from, to]) => i >= from && i < to);
    if (!dropped) session.onBinary(packet(seq & 0xffff));
    seq++;
  }
  return session.onText(JSON.stringify({ type: "stop" }));
}

function expectedStages(s: BandScenario): string[] {
  if (s.expect.afterProcessing === "NO_EVIDENCE") {
    return ["discovered", "queued", "workflow_started", "load", "evidence", "failed"];
  }
  const base = ["discovered", "queued", "workflow_started", "load", "evidence", "match", "extraction", "assemble", "draft_saved", "approval_wait"];
  if (!s.review) return base;
  return [...base, "review_saved", "approved", "client_snapshot", "finalize", "files", "completed"];
}

/** Consecutive duplicates collapsed (evidence started/succeeded → one "evidence"). */
function stageSequence(events: { stage: string }[]): string[] {
  const out: string[] = [];
  for (const e of events) if (out.at(-1) !== e.stage) out.push(e.stage);
  return out;
}

const FAKE_PII = ["555-0100", "(555) 555-0100", "test.learner@example.invalid"];

describe("band scenarios through the whole pipeline", () => {
  it("covers every scenario id exactly once", () => {
    const ids = BAND_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(8);
  });

  it.each(BAND_SCENARIOS.map((s) => [s.id, s] as const))("%s", async (_id, s) => {
    const { hh, store, cookie } = await setup();
    h = hh;

    // ---- start (no discovery: the visit creates its own open appointment)
    const start = await hh.req("/api/visits", {
      method: "POST",
      cookie,
      body: { clientRef: s.client.clientRef, bandNumber: null, transport: "sim", scenario: s.id },
    });
    expect(start.status, start.text).toBe(201);
    const visit = start.json.data.visit;
    expect(visit).toMatchObject({ clientRef: s.client.clientRef, status: "recording", transcriber: "simulated", scenario: s.id });

    // ---- stream
    const sent: VisitServerMessage[] = [];
    const audioStartMs = hh.clock.now().getTime() + 1000;
    const session = new CaptureSession({
      visit,
      store,
      openTranscriber: async (events) => openSimulated(events, s.script),
      send: (m) => sent.push(m),
      now: () => hh.clock.now(),
    });
    await session.open();
    expect(sent[0]).toEqual({ type: "ready", transcriber: "simulated" });
    expect(await stream(s, session, audioStartMs)).toBe(true);

    const finals = sent.filter((m): m is Extract<VisitServerMessage, { type: "final" }> => m.type === "final");
    expect(finals.map((f) => f.segment.text)).toEqual(s.script.map((l) => l.text));
    expect(sent.at(-1)).toEqual({ type: "done", segmentCount: s.script.length });

    // ---- stop (after the audio has really elapsed) → queue → workflow
    hh.clock.advance(s.audio.seconds * 1000 + 5000);
    const stop = await hh.req(`/api/visits/${visit.id}/stop`, { method: "POST", cookie });
    expect(stop.status, stop.text).toBe(200);
    const sessionId: string = stop.json.data.sessionId;
    const total = s.audio.seconds * PACKETS_PER_SEC;
    const lost = (s.audio.dropPackets ?? []).reduce((n, [a, b]) => n + (b - a), 0);
    expect(stop.json.data.visit).toMatchObject({ status: "stopped", segmentCount: s.script.length, packets: total - lost, lostPackets: lost });
    await hh.settle();

    const d = await hh.req(`/api/sessions/${sessionId}`, { cookie });
    expect(d.status, d.text).toBe(200);
    expect(d.json.data.session.status).toBe(s.expect.afterProcessing);

    // ---- run history (processing run r1)
    const runs = await hh.req(`/api/runs?sessionId=${encodeURIComponent(sessionId)}`, { cookie });
    expect(runs.status, runs.text).toBe(200);
    expect(runs.json.data.runs.length).toBeGreaterThanOrEqual(1);
    const runId: string = runs.json.data.runs.find((r: any) => r.runKind === "processing").runId;
    expect(runId).toBe(`wf-${sessionId}-r1`);

    const evRun = async () => {
      const r = await hh.req(`/api/runs/${encodeURIComponent(runId)}`, { cookie });
      expect(r.status, r.text).toBe(200);
      return r.json.data as { summary: any; events: any[] };
    };

    if (s.expect.afterProcessing === "NO_EVIDENCE") {
      expect(d.json.data.bundle).toBeNull();
      const run = await evRun();
      expect(stageSequence(run.events)).toEqual(expectedStages(s));
      const evOk = run.events.find((e) => e.stage === "evidence" && e.status === "succeeded");
      expect(evOk.meta).toMatchObject({ items: 0, completeness: s.expect.evidenceCompleteness });
      expect(run.summary.status).toBe("failed");
      expect(s.expect.final).toBe("NO_EVIDENCE");
      expect(s.expect.amountCentsAfterReview).toBeNull();
      assertNoTranscriptInEvents(run.events, s);
      return;
    }

    // ---- r1 draft: evidence, provenance, checks
    const b1 = d.json.data.bundle;
    expect(b1.bundleRevision).toBe(1);
    expect(b1.evidence).toHaveLength(s.script.length);
    expect(b1.evidence.map((e: any) => e.id)).toEqual(s.script.map((_l, i) => `ev_${String(i + 1).padStart(3, "0")}`));
    expect(b1.provenance.evidenceCompleteness).toBe(s.expect.evidenceCompleteness);
    expect(b1.provenance.evidenceMode).toBe("fixture");
    if (s.script.length > 0) expect(b1.provenance.promptVersion).toBe(SCENARIO_PROMPT_VERSION);
    const warnings = (b1.provenance.evidenceWarnings as string[]).join(" | ");
    for (const w of s.expect.warningsInclude ?? []) expect(warnings).toContain(w);
    // Each warning once (duplicates were observed before 1c36cc1 de-duplicated them in src/workflow/run.ts).
    expect(new Set(b1.provenance.evidenceWarnings).size).toBe(b1.provenance.evidenceWarnings.length);
    const blocking = (b1.checks.issues as any[]).filter((i) => i.blocking).map((i) => i.code).sort();
    expect(blocking).toEqual([...s.expect.blockingAtR1].sort());
    expect(b1.checks.canApprove).toBe(s.expect.blockingAtR1.length === 0);

    if (!s.review) {
      expect(s.expect.final).toBe(s.expect.afterProcessing);
      return;
    }

    // ---- provider review → approve
    hh.clock.advance(60_000);
    const review = await hh.req(`/api/sessions/${sessionId}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: s.review },
    });
    expect(review.status, review.text).toBe(200);
    const b2 = review.json.data;
    expect(b2.checks.issues.filter((i: any) => i.blocking)).toEqual([]);
    expect(b2.checks.canApprove).toBe(true);
    expect(b2.billing.amountCents).toBe(s.expect.amountCentsAfterReview);

    hh.clock.advance(60_000);
    const approve = await hh.req(`/api/sessions/${sessionId}/approve`, {
      method: "POST",
      cookie,
      body: { expectedRevision: b2.bundleRevision, idempotencyKey: `band-scn-${s.id}-${b2.bundleRevision}` },
    });
    expect([200, 202], approve.text).toContain(approve.status);
    await hh.settle();

    const fin = await hh.req(`/api/sessions/${sessionId}`, { cookie });
    expect(fin.json.data.session.status).toBe(s.expect.final);
    expect(fin.json.data.finalized).toBe(true);
    expect(fin.json.data.bundle.billing.amountCents).toBe(s.expect.amountCentsAfterReview);
    if (s.review.participantDirected !== undefined) {
      const att = (fin.json.data.bundle.attestations ?? []) as any[];
      expect(att.some((a) => a.field === "participant_direction")).toBe(true);
    }

    // ---- run history: every stage, in order
    const run = await evRun();
    expect(stageSequence(run.events)).toEqual(expectedStages(s));
    expect(run.summary.status).toBe("succeeded");
    const ext = run.events.find((e) => e.stage === "extraction" && e.status === "succeeded");
    expect(ext.meta.promptVersion).toBe(SCENARIO_PROMPT_VERSION);
    const asm = run.events.find((e) => e.stage === "assemble");
    expect(asm.meta.blocking).toBe(s.expect.blockingAtR1.length);
    assertNoTranscriptInEvents(run.events, s);

    // ---- files
    const pdf = await hh.req(`/api/sessions/${sessionId}/files/invoice`, { cookie });
    expect(pdf.status, pdf.text.slice(0, 200)).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 4))).toBe("%PDF");
  });
});

function assertNoTranscriptInEvents(events: unknown[], s: BandScenario) {
  const blob = JSON.stringify(events);
  for (const line of s.script) expect(blob).not.toContain(line.text);
  for (const p of FAKE_PII) expect(blob).not.toContain(p);
  expect(blob).not.toContain(s.client.displayName);
}
