/**
 * SYNTHETIC day scripts through the recordings path (dev only): POST /api/device/recordings
 * { scenario } plays a fixtures/schedule day script on the simulated transcriber (even when a
 * Deepgram key is configured), the shared CaptureSession stores the lines, and the partition job
 * (scoped DayScriptCalendarSource over the demo calendar, real D1) splits them by the script's own
 * calendar. Two demo runs started minutes apart never see each other's events.
 * Real modules + Miniflare D1 via the v3 harness (mirrors src/index.ts wiring for these parts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { ORIGIN } from "../e2e/harness";
import { createVisitStore } from "../../src/band/store";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import { CaptureSession } from "../../src/band/capture";
import { openSimulated } from "../../src/band/transcriber";
import {
  calendarSync,
  createRecordingStore,
  driveContextResolver,
  RecordingEvidenceSource,
  RecordingRoutingEvidenceSource,
  runPartition,
  visitContextResolver,
  type PartitionDeps,
  type RecordingStore,
} from "../../src/recordings";
import { appointmentIdForEvent, DemoCalendarSource, DemoDriveSource, syncCalendarToAppointments } from "../../src/schedule";
import { DayScriptCalendarSource, d1DayScriptRecordings } from "../../src/schedule/day-script-overlay";
import { dayScriptEventId, dayScriptOverlay, getDayScript } from "../../fixtures/schedule/day-scripts";

const PROVIDER = "provider_demo_001";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function setup(o: { dayScripts?: boolean; deepgram?: boolean; content?: boolean } = {}) {
  const hh = await createV3Harness();
  const anyH = hh as any;
  if (o.deepgram) (hh.env as any).DEEPGRAM_API_KEY = "dg_test_key_not_used";
  const visits = createVisitStore(hh.db);
  const store = createRecordingStore(hh.db);
  const base = new DemoCalendarSource({ clock: hh.clock, nowSlot: true });
  const calendarOf = (recordingId?: string) =>
    new DayScriptCalendarSource({
      base,
      ...d1DayScriptRecordings(hh.db),
      overlayFor: async (_p, rec) => dayScriptOverlay(rec.scenario, rec.anchorMs, rec.id),
      onlyRecordingId: recordingId,
    });
  const drive = new DemoDriveSource();
  const enqueue = (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt);
  anyH.apiDeps.visits = { store: visits, enqueueAppointment: enqueue };
  anyH.apiDeps.recordings = {
    store,
    calendar: calendarOf(),
    ...(o.dayScripts === false ? {} : { dayScript: (id: string) => getDayScript(id)?.script ?? null }),
  };
  const evidence = new RecordingRoutingEvidenceSource(
    new RecordingEvidenceSource(store, () => hh.clock.now()),
    new VisitRoutingEvidenceSource(new BandEvidenceSource(visits, () => hh.clock.now()), hh.mods.vexo.createEvidenceSource(hh.env)),
  );
  const wfDeps = {
    repo: hh.repo,
    evidence,
    extractor: hh.mods.ai.createExtractor(hh.env),
    match: hh.mods.domain.matchEvidence,
    assemble: hh.mods.domain.assembleBundle,
    clock: hh.clock,
    runtimeMode: "local",
    resolveDriveContext: driveContextResolver(drive),
    resolveVisitContext: visitContextResolver({ store, calendar: calendarOf(), ...(o.content ? { drive } : {}) }),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(wfDeps, params, step);
  const partitionDeps = (recordingId: string): PartitionDeps => {
    const calendar = calendarOf(recordingId);
    return {
      store,
      repo: hh.repo,
      queue: hh.queue as any,
      clock: hh.clock,
      syncCalendar: calendarSync({
        calendar,
        sync: (providerId, from, to) => syncCalendarToAppointments(hh.repo, calendar, providerId, from, to, { now: hh.clock.now() }),
        appointmentIdForEvent,
        getAppointment: (id) => hh.repo.getAppointment(id),
      }),
      enqueueAppointment: enqueue,
      // Pass 2 (rules only, no AI): conversation types + content suggestions.
      ...(o.content
        ? {
            content: {
              store,
              clock: hh.clock,
              calendar,
              drive,
              listClientRefs: async (p: string) => (await hh.repo.listClients(p, { includeInactive: false, limit: 50 })).map((c) => c.client.clientRef),
              resolveAi: async () => null,
            },
          }
        : {}),
    };
  };
  (hh.jobs as any).partitionRecording = (job: any, attempt: number) => runPartition(partitionDeps(job.recordingId), job, attempt);
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  const pair = await hh.req("/api/devices", { method: "POST", cookie, body: { name: "Demo phone" } });
  expect(pair.status, pair.text).toBe(201);
  return { hh, store, cookie, key: pair.json.data.key as string };
}

async function dev(hh: V3Harness, path: string, key: string, json?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await (hh as any).app.request(`${ORIGIN}${path}`, { method: json !== undefined ? "POST" : "GET", headers, body: json !== undefined ? JSON.stringify(json) : undefined }, hh.env);
  const text = await res.text();
  return { status: res.status as number, json: text ? JSON.parse(text) : null, text };
}

/** Start a recording with a day script, play it through CaptureSession (finish() flushes the rest), stop. */
async function playDay(hh: V3Harness, store: RecordingStore, key: string, scenario: string) {
  const start = await dev(hh, "/api/device/recordings", key, { bandNumber: null, transport: "sim", scenario });
  expect(start.status, start.text).toBe(201);
  const rec = start.json.data.recording;
  expect(rec.transcriber).toBe("simulated");
  const row = (await store.get(PROVIDER, rec.id))!;
  expect(row.scenario).toBe(scenario);
  const script = getDayScript(scenario)!.script;
  const sent: any[] = [];
  const cap = new CaptureSession({ visit: row.recording, store: store.capture, openTranscriber: async (e) => openSimulated(e, script), send: (m) => sent.push(m), now: () => hh.clock.now() });
  await cap.open();
  await cap.onText(JSON.stringify({ type: "start", audioStartMs: hh.clock.now().getTime() }));
  for (let s = 0; s < 50; s++) cap.onBinary(new Uint8Array([0, s, 1, 2, 3]));
  expect(await cap.onText(JSON.stringify({ type: "stop" }))).toBe(true);
  expect(sent.at(-1)).toEqual({ type: "done", segmentCount: script.length });
  const stop = await dev(hh, `/api/device/recordings/${rec.id}/stop`, key, {});
  expect(stop.status, stop.text).toBe(202);
  return rec.id as string;
}

describe("day scripts on the recordings path", () => {
  it("scenario guards: unknown id, no dev lookup with Deepgram configured", async () => {
    const a = await setup({ deepgram: true });
    h = a.hh;
    expect((await dev(a.hh, "/api/device/recordings", a.key, { bandNumber: null, transport: "sim", scenario: "nope" })).json.error.code).toBe("UNKNOWN_SCENARIO");
    // Without a scenario the configured transcriber (Deepgram) is used.
    expect((await dev(a.hh, "/api/device/recordings", a.key, { bandNumber: null, transport: "sim" })).json.data.recording.transcriber).toBe("deepgram");
    await a.hh.dispose();
    const b = await setup({ deepgram: true, dayScripts: false });
    h = b.hh;
    expect((await dev(b.hh, "/api/device/recordings", b.key, { bandNumber: null, transport: "sim", scenario: "day-handoff" })).json.error.code).toBe("SCENARIO_DEV_ONLY");
    (b.hh.env as any).RUNTIME_MODE = "deployed";
    expect((await dev(b.hh, "/api/device/recordings", b.key, { bandNumber: null, transport: "sim", scenario: "day-handoff" })).json.error.code).toBe("SCENARIO_DEV_ONLY");
  });

  it("day-handoff + day-overrun started 6 min apart: each partitions on its own script calendar", async () => {
    const { hh, store, cookie, key } = await setup({ deepgram: true });
    h = hh;
    const recA = await playDay(hh, store, key, "day-handoff");
    hh.clock.advance(6 * 60_000);
    const recB = await playDay(hh, store, key, "day-overrun");
    await hh.settle();

    const a = (await store.get(PROVIDER, recA))!.recording;
    expect(a.status).toBe("partitioned");
    expect(a.partition).toMatchObject({ unassignedSegments: 0, ambiguousSegments: 0 });
    expect(a.partition!.sessions.map((s) => [s.eventId, s.clientRef, s.segmentCount])).toEqual([
      [dayScriptEventId(recA, "c104"), "C-104", 12],
      [dayScriptEventId(recA, "sd320a"), "SD-320-A", 24],
    ]);
    const b = (await store.get(PROVIDER, recB))!.recording;
    expect(b.partition).toMatchObject({ unassignedSegments: 2, ambiguousSegments: 0 });
    expect(b.partition!.sessions.map((s) => [s.eventId, s.clientRef, s.segmentCount])).toEqual([[dayScriptEventId(recB, "sd334a"), "SD-334-A", 22]]);

    for (const s of [...a.partition!.sessions, ...b.partition!.sessions]) {
      const d = await hh.req(`/api/sessions/${s.sessionId}`, { cookie });
      expect(d.status, d.text).toBe(200);
      expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
      expect(d.json.data.bundle.provenance.evidenceWarnings.join(" ")).toMatch(/Simulated transcript/);
    }
    const sd320 = (await hh.req(`/api/sessions/${a.partition!.sessions[1]!.sessionId}`, { cookie })).json.data.bundle;
    expect(sd320.evidence[0].excerpt).toBe("Hi Robin, sorry, traffic. Ready to plan meals for the week?");
    expect(sd320.evidence[0].speaker ?? "Speaker 0").toBe("Speaker 0");
    expect(sd320.appointment.clientRef).toBe("SD-320-A");
  });

  it("day-guardian-call: the C-104 slot's session block is assessed before hand-off → NOT_CLIENT_SESSION blocks the bundle", async () => {
    const { hh, store, cookie, key } = await setup({ content: true });
    h = hh;
    const id = await playDay(hh, store, key, "day-guardian-call");
    await hh.settle();
    const r = (await store.get(PROVIDER, id))!.recording;
    expect(r.partition).toMatchObject({ unassignedSegments: 0, ambiguousSegments: 0 });
    expect(r.partition!.sessions.map((s) => [s.clientRef, s.segmentCount])).toEqual([["C-104", 9]]);
    const d = (await hh.req(`/api/recordings/${id}`, { cookie })).json.data;
    expect(d.sessionConversations).toEqual([
      expect.objectContaining({ eventId: dayScriptEventId(id, "c104"), conversationType: "guardian_or_family", needsConfirmation: true, segmentCount: 9 }),
    ]);
    expect(d.sessionConversations[0].confidence).toBeGreaterThanOrEqual(0.6);
    const bundle = (await hh.req(`/api/sessions/${r.partition!.sessions[0]!.sessionId}`, { cookie })).json.data.bundle;
    expect(bundle.config.context.conversation).toMatchObject({ type: "guardian_or_family", needsConfirmation: true, decision: null });
    expect(bundle.checks.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NOT_CLIENT_SESSION", blocking: true })]));
    expect(bundle.checks.canApprove).toBe(false);
  });

  it("day-overrun: the goodbye past the slot is suggested as kind event for THAT SD-334-A event (extend), not unscheduled", async () => {
    const { hh, store, cookie, key } = await setup({ content: true });
    h = hh;
    const id = await playDay(hh, store, key, "day-overrun");
    await hh.settle();
    const d = (await hh.req(`/api/recordings/${id}`, { cookie })).json.data;
    expect(d.recording.partition.unassignedSegments).toBe(2);
    expect(d.suggestions).toEqual([expect.objectContaining({ suggestedClientRef: "SD-334-A", eventId: dayScriptEventId(id, "sd334a"), kind: "event", segmentIndexes: [23, 24] })]);
    expect(d.suggestions[0].rationale).not.toMatch(/Jordan/);
    expect(d.sessionConversations).toEqual([expect.objectContaining({ conversationType: "client_session", needsConfirmation: false })]);
  });

  it("day-colleague: no slot → everything unassigned, no session", async () => {
    const { hh, store, key } = await setup();
    h = hh;
    const id = await playDay(hh, store, key, "day-colleague");
    await hh.settle();
    const r = (await store.get(PROVIDER, id))!.recording;
    expect(r.partition).toMatchObject({ sessions: [], unassignedSegments: 12, ambiguousSegments: 0 });
  });
});
