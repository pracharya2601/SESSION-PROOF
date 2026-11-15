/**
 * Client-less recordings end to end: a paired phone starts a recording (no client), streams
 * through the shared CaptureSession, stops it, and the partition job splits the transcript into
 * sessions by the provider's (demo) calendar: src/schedule syncCalendarToAppointments → frozen
 * partition rule → one session per event with segments → RecordingEvidenceSource → NEEDS_REVIEW.
 * Also: unassigned / ambiguous segments, two recordings for one event, offline VXREC upload,
 * provider isolation, discovery never creating calendar sessions, the 24 h text sweep, and the
 * device schedule endpoint. Real modules + Miniflare D1 via the v3 harness (WebSocket replaced
 * by direct CaptureSession calls).
 *
 * Demo calendar (America/Los_Angeles, PST = UTC−8 in November):
 *   Fri 2026-11-13  fri2 C-104 10:00–11:00 (18:00–19:00Z, coincides with legacy appointment_demo_001)
 *                   fri3 SD-334-A 11:00–12:00 (19:00–20:00Z)
 *   Thu 2026-11-12  thu1 SD-334-A 09:00–10:00 (17:00–18:00Z), thu2 SD-331-A 11:00–13:00 (19:00–21:00Z)
 * Harness clock: 2026-11-13T20:00:00Z.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { ORIGIN } from "../e2e/harness";
import { createVisitStore } from "../../src/band/store";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import { CaptureSession } from "../../src/band/capture";
import { openSimulated, SIMULATED_SCRIPT } from "../../src/band/transcriber";
import {
  assignSegment,
  calendarSync,
  createRecordingStore,
  driveContextResolver,
  visitContextResolver,
  interiorGaps,
  RecordingEvidenceSource,
  RecordingRoutingEvidenceSource,
  runPartition,
  sweepRecordings,
  type CalendarSync,
  type PartitionDeps,
  type RecordingStore,
} from "../../src/recordings";
import { appointmentIdForEvent, DemoCalendarSource, DemoDriveSource, syncCalendarToAppointments } from "../../src/schedule";
import { runOfflineTranscription, type AudioBucket } from "../../src/offline/job";
import { createOfflineStore } from "../../src/offline/store";
import { buildVxrec } from "../../src/offline/vxrec";
import { oggPackets } from "../../src/ui/vendor/vexo-open/index.js";
import { sessionIdFor, type BandSegment, type CalendarEvent, type OfflineTranscribeJob, type VisitServerMessage } from "../../src/contracts";

const PROVIDER = "provider_demo_001";
const Z = (s: string) => `2026-11-${s}:00.000Z`;
const FRI2 = "demo_c_104_20261113_fri2";
const FRI3 = "demo_sd_334_a_20261113_fri3";
const THU1 = "demo_sd_334_a_20261112_thu1";
const THU2 = "demo_sd_331_a_20261112_thu2";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

class FakeBucket implements AudioBucket {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: ArrayBuffer | Uint8Array) {
    this.objects.set(key, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)).slice());
    return {};
  }
  async get(key: string) {
    const v = this.objects.get(key);
    return v ? { arrayBuffer: async () => v.slice().buffer as ArrayBuffer } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

async function setup(opts: { sync?: (hh: V3Harness) => CalendarSync } = {}) {
  const hh = await createV3Harness();
  const anyH = hh as any;
  const visits = createVisitStore(hh.db);
  const store = createRecordingStore(hh.db);
  const calendar = new DemoCalendarSource({ clock: hh.clock });
  const drive = new DemoDriveSource();
  const enqueue = (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt);
  anyH.apiDeps.visits = { store: visits, enqueueAppointment: enqueue };
  anyH.apiDeps.recordings = { store, calendar };
  // Mirror src/index.ts: calendar appointments → recordings, band visits → their visit, rest → fixtures.
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
    // Mirrors the drafting wiring: calendar sessions draft from the client's (demo) Drive context.
    resolveDriveContext: driveContextResolver(drive),
    resolveVisitContext: visitContextResolver({ store, calendar }),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(wfDeps, params, step);
  const realSync = calendarSync({
    calendar,
    sync: (providerId, from, to) => syncCalendarToAppointments(hh.repo, calendar, providerId, from, to, { now: hh.clock.now() }),
    appointmentIdForEvent,
    getAppointment: (id) => hh.repo.getAppointment(id),
  });
  const partitionDeps = (): PartitionDeps => ({
    store,
    repo: hh.repo,
    queue: hh.queue as any,
    clock: hh.clock,
    syncCalendar: opts.sync ? opts.sync(hh) : realSync,
    enqueueAppointment: enqueue,
  });
  (hh.jobs as any).partitionRecording = (job: any, attempt: number) => runPartition(partitionDeps(), job, attempt);
  const bucket = new FakeBucket();
  (hh.env as any).AUDIO_TMP = bucket;
  (hh.jobs as any).transcribeOffline = (job: OfflineTranscribeJob, attempt: number) =>
    runOfflineTranscription(
      {
        store: createOfflineStore(hh.db),
        visits,
        repo: hh.repo,
        bucket,
        env: hh.env as any,
        clock: hh.clock,
        enqueueAppointment: enqueue,
        recordings: {
          transcriberOf: async (p, id) => (await store.get(p, id))?.recording.transcriber ?? null,
          capture: store.capture,
          enqueuePartition: async (providerId, recordingId) => {
            await hh.queue.send({ kind: "partition_recording", recordingId, providerId } as any);
          },
        },
      },
      job,
      attempt,
    );
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, store, cookie, partitionDeps, bucket };
}

async function pair(hh: V3Harness, cookie: string): Promise<string> {
  const r = await hh.req("/api/devices", { method: "POST", cookie, body: { name: "Field phone" } });
  expect(r.status, r.text).toBe(201);
  return r.json.data.key;
}

/** Device request: bearer key, no cookie, no Origin. */
async function dev(hh: V3Harness, path: string, key: string | null, o: { method?: string; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (key) headers["authorization"] = `Bearer ${key}`;
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.bytes) {
    headers["content-type"] = "application/octet-stream";
    headers["content-length"] = String(o.bytes.length);
    body = o.bytes as unknown as BodyInit;
  }
  const res = await (hh as any).app.request(`${ORIGIN}${path}`, { method: o.method ?? "GET", headers, body }, hh.env);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status as number, json, text };
}

/** A stopped recording with segments placed exactly (bypasses streaming). */
async function makeRecording(store: RecordingStore, o: { id: string; from: string; to: string; segs: [string, number, string][]; providerId?: string; lost?: number }) {
  const providerId = o.providerId ?? PROVIDER;
  await store.create({ id: o.id, providerId, deviceId: null, bandNumber: 7, transport: "ble", transcriber: "simulated", startedAt: o.from, timezone: null, scenario: null, now: o.from });
  const segs: BandSegment[] = o.segs.map(([at, sec, text], i) => ({
    id: `${o.id}:${i + 1}`,
    visitId: o.id,
    index: i + 1,
    observedFrom: at,
    observedTo: new Date(Date.parse(at) + sec * 1000).toISOString(),
    speaker: "Speaker 0",
    text,
    sourceMode: "fixture",
  }));
  await store.capture.saveSegments(providerId, segs, o.from);
  if (o.lost) await store.capture.updateStats(o.id, 1000, o.lost);
  await store.stop(providerId, o.id, o.to);
}

async function sessionFor(hh: V3Harness, cookie: string, sessionId: string) {
  const d = await hh.req(`/api/sessions/${sessionId}`, { cookie });
  expect(d.status, d.text).toBe(200);
  return d.json.data;
}

describe("partition rule (pure)", () => {
  const ev = (eventId: string, start: string, end: string) => ({ eventId, appointmentId: `appt_cal_${eventId}`, startMs: Date.parse(start), endMs: Date.parse(end) });
  const seg = (from: string, to: string) => ({ observedFrom: from, observedTo: to });
  const A = ev("a", Z("13T18:00"), Z("13T19:00"));
  const B = ev("b", Z("13T19:00"), Z("13T20:00"));

  it("boundaries, tie-break and ambiguity", () => {
    expect(assignSegment(seg(Z("13T17:50"), Z("13T17:50")), [A])).toMatchObject({ status: "assigned", event: { eventId: "a" } });
    expect(assignSegment(seg(Z("13T17:49"), Z("13T17:49")), [A])).toEqual({ status: "unassigned" });
    expect(assignSegment(seg(Z("13T19:10"), Z("13T19:10")), [A])).toEqual({ status: "unassigned" }); // end + 10 excluded
    // Back-to-back: 18:55 is in both windows; nearest start is B (5 min) vs A (55 min).
    expect(assignSegment(seg(Z("13T18:54"), Z("13T18:56")), [A, B])).toMatchObject({ status: "assigned", event: { eventId: "b" } });
    // Two events starting 4 min apart: not unambiguous by ≥ 5 min.
    const C = ev("c", Z("13T18:04"), Z("13T19:00"));
    const amb = assignSegment(seg(Z("13T18:20"), Z("13T18:22")), [A, C]);
    expect(amb.status).toBe("ambiguous");
    expect((amb as any).candidates.map((c: any) => c.eventId).sort()).toEqual(["a", "c"]);
    // Exactly 5 min apart: the nearer one wins.
    const D = ev("d", Z("13T18:05"), Z("13T19:00"));
    expect(assignSegment(seg(Z("13T18:00"), Z("13T18:00")), [A, D])).toMatchObject({ status: "assigned", event: { eventId: "a" } });
  });

  it("interior gaps only between recordings", () => {
    const s = Date.parse(Z("13T19:00"));
    const e = Date.parse(Z("13T21:00"));
    expect(interiorGaps([{ from: s + 600_000, to: s + 1800_000 }, { from: s + 2400_000, to: e }], s, e)).toEqual([{ from: s + 1800_000, to: s + 2400_000 }]);
    expect(interiorGaps([{ from: s + 600_000, to: e - 600_000 }], s, e)).toEqual([]);
  });
});

describe("recordings", () => {
  it("one recording across two back-to-back events → two sessions; Friday C-104 slot is not ambiguous with the legacy appointment", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    const key = await pair(hh, cookie);

    // Bad requests.
    expect((await dev(hh, "/api/device/recordings", key, { method: "POST", json: { bandNumber: 7 } })).status).toBe(400);
    expect((await dev(hh, "/api/device/recordings", key, { method: "POST", json: { bandNumber: 7, transport: "ble", clientRef: "C-104" } })).status).toBe(400);
    expect((await dev(hh, "/api/device/recordings", key, { method: "POST", json: { bandNumber: 7, transport: "ble", scenario: "nope" } })).json.error.code).toBe("UNKNOWN_SCENARIO");
    expect((await dev(hh, "/api/device/recordings", null, { method: "POST", json: { bandNumber: 7, transport: "ble" } })).status).toBe(403); // no bearer: origin guard
    expect((await dev(hh, "/api/device/recordings/rec_x", null)).status).toBe(401);

    // Start at 17:55Z (09:55 PT): the calendar says fri2 is next, nothing current yet.
    hh.clock.advance(Date.parse(Z("13T17:55")) - hh.clock.now().getTime());
    const start = await dev(hh, "/api/device/recordings", key, { method: "POST", json: { bandNumber: 7, transport: "ble" } });
    expect(start.status, start.text).toBe(201);
    const rec = start.json.data.recording;
    expect(rec).toMatchObject({ providerId: PROVIDER, transcriber: "simulated", status: "recording", bandNumber: 7, partition: null, segmentCount: 0 });
    expect(rec.id).toMatch(/^rec_[0-9a-f]{32}$/);
    expect(start.json.data.currentEvent).toBeNull();
    expect(start.json.data.streamUrl).toBe(`ws://localhost:8787/api/recordings/${rec.id}/stream`);
    // currentEvent once fri2 is running.
    hh.clock.advance(10 * 60_000);
    const second = await dev(hh, "/api/device/recordings", key, { method: "POST", json: { bandNumber: 8, transport: "sim" } });
    expect(second.json.data.currentEvent).toMatchObject({ eventId: FRI2, clientRef: "C-104" });

    // Stream route: token-only auth, scoped to the recording (deprecated ?token= here; the
    // subprotocol / first-message paths are in stream-auth.test.ts).
    const token: string = start.json.data.streamToken;
    expect((await dev(hh, `/api/recordings/${rec.id}/stream?token=bad`, null)).status).toBe(401);
    expect((await dev(hh, `/api/recordings/${second.json.data.recording.id}/stream?token=${encodeURIComponent(token)}`, null)).status).toBe(401);
    expect((await dev(hh, `/api/recordings/${rec.id}/stream?token=${encodeURIComponent(token)}`, null)).status).toBe(426);

    // Stream through the shared CaptureSession (the visit WS protocol). The script spans both events.
    const audioStart = Date.parse(Z("13T17:58"));
    const at = (iso: string) => (Date.parse(iso) - audioStart) / 1000;
    const script = [
      { at: Z("13T18:10"), text: "We planned the bus route." },
      { at: Z("13T18:40"), text: "We reviewed the food budget." },
      { at: Z("13T19:05"), text: "Now we look at the money worksheet." }, // in both windows: fri3 starts nearer
      { at: Z("13T19:30"), text: "Counting coins for the week." },
    ].map((l) => ({ atSec: at(l.at), durationSec: 4, speaker: "Speaker 0", text: l.text }));
    const sent: VisitServerMessage[] = [];
    const row = (await store.get(PROVIDER, rec.id))!;
    const cap = new CaptureSession({ visit: row.recording, store: store.capture, openTranscriber: async (e) => openSimulated(e, script), send: (m) => sent.push(m), now: () => hh.clock.now() });
    await cap.open();
    expect(sent[0]).toEqual({ type: "ready", transcriber: "simulated" });
    await cap.onText(JSON.stringify({ type: "start", audioStartMs: audioStart }));
    for (let s = 0; s < 10; s++) cap.onBinary(new Uint8Array([0, s, 1, 2, 3]));
    expect(await cap.onText(JSON.stringify({ type: "stop" }))).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "done", segmentCount: 4 });

    hh.clock.advance(Date.parse(Z("13T20:01")) - hh.clock.now().getTime());
    const stop = await dev(hh, `/api/device/recordings/${rec.id}/stop`, key, { method: "POST" });
    expect(stop.status, stop.text).toBe(202);
    expect(stop.json.data.recording).toMatchObject({ status: "stopped", endedAt: Z("13T20:01"), segmentCount: 4 });
    expect(hh.queue.pending).toEqual([{ kind: "partition_recording", recordingId: rec.id, providerId: PROVIDER }]);
    // The stream refuses a stopped recording.
    expect((await dev(hh, `/api/recordings/${rec.id}/stream?token=${encodeURIComponent(token)}`, null, { headers: { upgrade: "websocket" } })).status).toBe(409);
    await hh.settle();

    const got = await dev(hh, `/api/device/recordings/${rec.id}`, key);
    const partition = got.json.data.recording.partition;
    expect(got.json.data.recording.status).toBe("partitioned");
    expect(partition).toMatchObject({ unassignedSegments: 0, ambiguousSegments: 0 });
    expect(partition.sessions.map((s: any) => [s.eventId, s.clientRef, s.segmentCount])).toEqual([
      [FRI2, "C-104", 2],
      [FRI3, "SD-334-A", 2],
    ]);
    // Stop again: idempotent, no new job.
    expect((await dev(hh, `/api/device/recordings/${rec.id}/stop`, key, { method: "POST" })).status).toBe(202);
    expect(hh.queue.pending).toHaveLength(0);

    const [s2, s3] = partition.sessions;
    const d2 = await sessionFor(hh, cookie, s2.sessionId);
    expect(d2.session.status).toBe("NEEDS_REVIEW"); // not AMBIGUOUS_MATCH with appointment_demo_001
    expect(d2.bundle.evidence.map((e: any) => [e.id, e.excerpt])).toEqual([
      ["ev_001", "We planned the bus route."],
      ["ev_002", "We reviewed the food budget."],
    ]);
    expect(d2.bundle.evidence[0].sourceId).toBe(`recording:${rec.id}`);
    expect(d2.bundle.provenance.evidenceMode).toBe("fixture");
    expect(d2.bundle.provenance.evidenceWarnings.join(" ")).toMatch(/Simulated transcript/);
    const d3 = await sessionFor(hh, cookie, s3.sessionId);
    expect(d3.session.status).toBe("NEEDS_REVIEW");
    expect(d3.bundle.evidence.map((e: any) => e.excerpt)).toEqual(["Now we look at the money worksheet.", "Counting coins for the week."]);

    // Events with no segments get no session; discovery never creates calendar sessions.
    await hh.req("/api/sync", { method: "POST", cookie });
    await hh.settle();
    const { results } = await hh.db.prepare(`SELECT id, appointment_id, status FROM sessions WHERE provider_id = ?`).bind(PROVIDER).all<any>();
    const cal = results.filter((r: any) => String(r.appointment_id).startsWith("appt_cal_"));
    expect(cal.map((r: any) => r.appointment_id).sort()).toEqual([`appt_cal_${FRI2}`, `appt_cal_${FRI3}`]);
    expect((await hh.repo.getAppointment(`appt_cal_demo_sd_335_a_20261113_fri1`))?.canceled).toBe(true); // synced, cancelled, no session
    // The legacy fixture appointment still processes on its own (no competitor from the calendar).
    const legacy = results.find((r: any) => r.appointment_id === "appointment_demo_001");
    expect(legacy?.status).toBe("NEEDS_REVIEW");

    // Web view: segments with their session.
    const web = await hh.req(`/api/recordings/${rec.id}`, { cookie });
    expect(web.status).toBe(200);
    expect(web.json.data.segments.map((s: any) => [s.index, s.assignment.status, s.assignment.eventId, s.assignment.sessionId])).toEqual([
      [1, "assigned", FRI2, s2.sessionId],
      [2, "assigned", FRI2, s2.sessionId],
      [3, "assigned", FRI3, s3.sessionId],
      [4, "assigned", FRI3, s3.sessionId],
    ]);
    const all = await hh.req("/api/recordings", { cookie });
    expect(all.json.data.map((r: any) => r.id)).toContain(rec.id);

    // Re-running the partition is idempotent: no new processing revision.
    const before = (await hh.repo.getSession(s2.sessionId))!.processingRevision;
    await hh.queue.send({ kind: "partition_recording", recordingId: rec.id, providerId: PROVIDER } as any);
    await hh.settle();
    expect((await hh.repo.getSession(s2.sessionId))!.processingRevision).toBe(before);
  });

  it("segment between events → unassigned (never evidence); its text is deleted 24 h later, counts stay", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    await makeRecording(store, {
      id: "rec_thu_gap",
      from: Z("12T16:55"),
      to: Z("12T18:40"),
      segs: [
        [Z("12T17:10"), 5, "Practising the budget sheet."],
        [Z("12T18:30"), 5, "Unrelated chat in the car."], // thu1 ends 18:00, thu2 starts 19:00
      ],
    });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_thu_gap", providerId: PROVIDER } as any);
    await hh.settle();
    const rec = (await store.get(PROVIDER, "rec_thu_gap"))!.recording;
    expect(rec.partition).toMatchObject({ unassignedSegments: 1, ambiguousSegments: 0, unassignedMs: 5000 });
    expect(rec.partition!.sessions.map((s) => s.eventId)).toEqual([THU1]);
    const d = await sessionFor(hh, cookie, rec.partition!.sessions[0]!.sessionId);
    expect(d.bundle.evidence.map((e: any) => e.excerpt)).toEqual(["Practising the budget sheet."]);
    // thu2 (no segments) got no session.
    expect(await hh.repo.getSession(await sessionIdFor(PROVIDER, THU2))).toBeNull();

    const web1 = (await hh.req(`/api/recordings/rec_thu_gap`, { cookie })).json.data;
    expect(web1.segments[1]).toMatchObject({ index: 2, text: "Unrelated chat in the car.", textDeleted: false, assignment: { status: "unassigned" } });

    const sweepDeps = { store, clock: hh.clock, enqueuePartition: async () => undefined };
    expect((await sweepRecordings(sweepDeps)).textDeleted).toBe(0);
    hh.clock.advance(24 * 3600_000 + 1000);
    expect((await sweepRecordings(sweepDeps)).textDeleted).toBe(1);
    expect((await sweepRecordings(sweepDeps)).textDeleted).toBe(0);
    const web2 = (await hh.req(`/api/recordings/rec_thu_gap`, { cookie: await hh.login() })).json.data;
    expect(web2.segments[1]).toMatchObject({ index: 2, text: null, textDeleted: true, assignment: { status: "unassigned" } });
    expect(web2.segments[0].text).toBe("Practising the budget sheet."); // assigned text is kept
    expect(web2.recording.segmentCount).toBe(2);
    expect(web2.recording.partition.unassignedSegments).toBe(1);
    const raw = await hh.db.prepare(`SELECT COUNT(*) AS n FROM band_segments WHERE visit_id = 'rec_thu_gap'`).first<{ n: number }>();
    expect(raw!.n).toBe(1);
  });

  it("two recordings for one event → one session with both (re-processed, gap flagged); lost packets warned", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    await makeRecording(store, { id: "rec_thu2_a", from: Z("12T19:00"), to: Z("12T19:30"), segs: [[Z("12T19:10"), 5, "First half one."], [Z("12T19:20"), 5, "First half two."]] });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_thu2_a", providerId: PROVIDER } as any);
    await hh.settle();
    const sid = (await store.get(PROVIDER, "rec_thu2_a"))!.recording.partition!.sessions[0]!.sessionId;
    const first = await sessionFor(hh, cookie, sid);
    expect(first.session.status).toBe("NEEDS_REVIEW");
    expect(first.bundle.evidence).toHaveLength(2);
    const rev1 = first.bundle.bundleRevision;

    // Phone restarted: a second recording for the rest of the visit.
    await makeRecording(store, { id: "rec_thu2_b", from: Z("12T19:40"), to: Z("12T20:50"), lost: 10, segs: [[Z("12T19:45"), 5, "Second half one."], [Z("12T20:30"), 5, "Second half two."]] });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_thu2_b", providerId: PROVIDER } as any);
    await hh.settle();
    const b = (await store.get(PROVIDER, "rec_thu2_b"))!.recording;
    expect(b.partition!.sessions).toEqual([{ eventId: THU2, clientRef: "SD-331-A", sessionId: sid, segmentCount: 2 }]);
    const both = await sessionFor(hh, cookie, sid);
    expect(both.session.status).toBe("NEEDS_REVIEW");
    expect(both.bundle.bundleRevision).toBe(rev1 + 1);
    expect(both.bundle.evidence.map((e: any) => [e.id, e.excerpt, e.sourceId])).toEqual([
      ["ev_001", "First half one.", "recording:rec_thu2_a"],
      ["ev_002", "First half two.", "recording:rec_thu2_a"],
      ["ev_003", "Second half one.", "recording:rec_thu2_b"],
      ["ev_004", "Second half two.", "recording:rec_thu2_b"],
    ]);
    const w = both.bundle.provenance.evidenceWarnings.join(" ");
    expect(w).toMatch(/2 recordings/);
    expect(w).toMatch(/No recording ran for 10 min inside the appointment/);
    expect(w).toMatch(/10 audio packet/);
    expect(both.bundle.provenance.evidenceCompleteness ?? "partial").toBe("partial");

    // Approved = locked: a third recording does not re-process.
    await hh.db.prepare(`UPDATE sessions SET status = 'APPROVED' WHERE id = ?`).bind(sid).run();
    const revBefore = (await hh.repo.getSession(sid))!.processingRevision;
    await makeRecording(store, { id: "rec_thu2_c", from: Z("12T20:51"), to: Z("12T20:58"), segs: [[Z("12T20:55"), 5, "Late extra."]] });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_thu2_c", providerId: PROVIDER } as any);
    await hh.settle();
    expect((await hh.repo.getSession(sid))!).toMatchObject({ status: "APPROVED", processingRevision: revBefore });
  });

  it("ambiguous segments: attached to neither, flagged on the candidate sessions", async () => {
    // Two overlapping calendar events starting 3 min apart (double-booked), fake calendar.
    const events: CalendarEvent[] = [
      { eventId: "evA", clientRef: "C-104", startAt: Z("12T15:00"), endAt: Z("12T16:00") },
      { eventId: "evB", clientRef: "C-104", startAt: Z("12T15:03"), endAt: Z("12T16:00") },
    ].map((e) => ({ ...e, providerId: PROVIDER, title: "t", timezone: "America/Los_Angeles", serviceCode: "DEMO-ILS", location: null, status: "confirmed", source: "demo" }));
    const sync = (hh: V3Harness): CalendarSync => async () => {
      const out = [];
      for (const event of events) {
        const appointment = {
          id: `appt_cal_${event.eventId}`, occurrenceId: event.eventId, providerId: PROVIDER, clientRef: event.clientRef,
          startAt: event.startAt, endAt: event.endAt, timezone: event.timezone, serviceCode: "DEMO-ILS",
          planVersion: "plan_demo_v1", ruleVersion: "rules_demo_v1", rateVersion: "rate_demo_v1", canceled: false,
        };
        await hh.repo.upsertAppointment(appointment);
        out.push({ event, appointment });
      }
      return out;
    };
    const { hh, store, cookie } = await setup({ sync });
    h = hh;
    await makeRecording(store, {
      id: "rec_amb",
      from: Z("12T14:58"),
      to: Z("12T16:05"),
      segs: [
        [Z("12T15:01"), 4, "Hello, starting now."], // mid 15:01: |A| 1 min, |B| 2 min → ambiguous
        [Z("12T15:40"), 4, "Late in the visit."], // |A| 40, |B| 37 → ambiguous
      ],
    });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_amb", providerId: PROVIDER } as any);
    await hh.settle();
    const rec = (await store.get(PROVIDER, "rec_amb"))!.recording;
    expect(rec.partition).toMatchObject({ sessions: [], ambiguousSegments: 2, unassignedSegments: 0 });
    const web = (await hh.req(`/api/recordings/rec_amb`, { cookie })).json.data;
    expect(web.segments[0].assignment).toEqual({ status: "ambiguous", candidateEventIds: ["evA", "evB"] });

    // Add one clear segment for A (≥ 5 min nearer): A gets a session, flagged with the 2 ambiguous ones.
    await makeRecording(store, { id: "rec_amb2", from: Z("12T14:40"), to: Z("12T14:58"), segs: [[Z("12T14:52"), 4, "Before the start."]] });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_amb2", providerId: PROVIDER } as any);
    await hh.settle();
    // 14:52 is in A's window [14:50, 16:10) and not B's [14:53, …): assigned to A.
    const r2 = (await store.get(PROVIDER, "rec_amb2"))!.recording;
    expect(r2.partition!.sessions.map((s) => s.eventId)).toEqual(["evA"]);
    const d = await sessionFor(hh, cookie, r2.partition!.sessions[0]!.sessionId);
    expect(d.bundle.evidence.map((e: any) => e.excerpt)).toEqual(["Before the start."]);
    expect(d.bundle.provenance.evidenceWarnings.join(" ")).toMatch(/2 transcript segment\(s\).*ambiguous/);
  });

  it("offline recording upload (no client) → transcript → partition → session", async () => {
    const { hh, store, cookie, bucket } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const PACKETS = oggPackets(new Uint8Array(readFileSync(resolve(__dirname, "../../src/ui/public/sample-speech.opus"))));
    const from = Date.parse(Z("13T18:15"));
    const to = Date.parse(Z("13T18:35"));
    const run0 = from + 5_000;
    const body = {
      localId: "rec-offline-0001",
      bandNumber: 7,
      recordedFrom: new Date(from).toISOString(),
      recordedTo: new Date(to).toISOString(),
      consentConfirmedAt: new Date(from - 30_000).toISOString(),
    };
    expect((await dev(hh, "/api/device/offline-recordings", key, { method: "POST", json: { ...body, clientRef: "C-104" } })).status).toBe(400);
    const c = await dev(hh, "/api/device/offline-recordings", key, { method: "POST", json: body });
    expect(c.status, c.text).toBe(201);
    const id = c.json.data.recording.id;
    expect(c.json.data).toMatchObject({ status: "awaiting_audio", uploadUrl: `${ORIGIN}/api/device/offline-recordings/${id}/audio` });
    expect(c.json.data.recording).toMatchObject({ status: "stopped", startedAt: body.recordedFrom, endedAt: body.recordedTo, transcriber: "simulated", consentConfirmedAt: body.consentConfirmedAt });
    expect((await dev(hh, "/api/device/offline-recordings", key, { method: "POST", json: body })).json.data.recording.id).toBe(id); // idempotent
    expect((await dev(hh, "/api/device/offline-recordings", key, { method: "POST", json: { ...body, bandNumber: 9 } })).status).toBe(409);
    // Stop before the upload: pending.
    expect((await dev(hh, `/api/device/recordings/${id}/stop`, key, { method: "POST" })).json.error.code).toBe("RECORDING_PENDING_UPLOAD");

    const file = buildVxrec(
      { version: 1, bandNumber: 7, audioRuns: [{ runIndex: 0, audioStartMs: run0 }], recordedFrom: body.recordedFrom, recordedTo: body.recordedTo, localId: body.localId, appVersion: "GlassCam 1.0 (1)" } as any, // no clientRef (recording header)
      PACKETS.slice(0, 400).map((opus, i) => ({ runIndex: 0, seq: i, opus })),
    );
    const up = await dev(hh, `/api/device/offline-recordings/${id}/audio`, key, { method: "PUT", bytes: file });
    expect(up.status, up.text).toBe(202);
    expect((await dev(hh, `/api/device/offline-recordings/${id}`, key)).json.data.status).toBe("transcribing");
    await hh.settle();
    expect(bucket.objects.size).toBe(0);

    const st = await dev(hh, `/api/device/offline-recordings/${id}`, key);
    expect((await dev(hh, `/api/device/recordings/${id}`, key)).json.data.recording).toMatchObject({ status: "partitioned", partition: { unassignedSegments: 0, unassignedMs: 0 } });
    expect(st.json.data).toMatchObject({ recordingId: id, status: "partitioned", segmentCount: SIMULATED_SCRIPT.length, canDeleteLocalFile: true, error: null });
    expect(st.json.data.partition.sessions).toEqual([{ eventId: FRI2, clientRef: "C-104", sessionId: expect.any(String), segmentCount: SIMULATED_SCRIPT.length }]);
    const d = await sessionFor(hh, cookie, st.json.data.partition.sessions[0].sessionId);
    expect(d.session.status).toBe("NEEDS_REVIEW");
    expect(d.bundle.evidence.map((e: any) => e.excerpt)).toEqual(SIMULATED_SCRIPT.map((l) => l.text));
    expect(d.bundle.evidence[0].observedFrom).toBe(new Date(run0).toISOString());
    // The offline-visits routes do not serve a recording's row as a recording.
    expect((await dev(hh, `/api/device/offline-recordings/visit_nope`, key)).status).toBe(404);
  });

  it("provider isolation", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const other = await hh.login("other.provider@example.invalid");
    const otherKey = await pair(hh, other);
    await makeRecording(store, { id: "rec_mine", from: Z("13T18:00"), to: Z("13T18:30"), segs: [[Z("13T18:10"), 5, "Mine."]] });

    expect((await dev(hh, `/api/device/recordings/rec_mine`, key)).status).toBe(200);
    expect((await dev(hh, `/api/device/recordings/rec_mine`, otherKey)).status).toBe(404);
    expect((await dev(hh, `/api/device/recordings/rec_mine/stop`, otherKey, { method: "POST" })).status).toBe(404);
    expect((await hh.req(`/api/recordings/rec_mine`, { cookie: other })).status).toBe(404);
    expect((await hh.req(`/api/recordings`, { cookie: other })).json.data).toEqual([]);
    expect((await hh.req(`/api/recordings/rec_mine`, { cookie: null })).status).toBe(401);
    expect((await hh.req(`/api/device/recordings/rec_mine`, { cookie })).status).toBe(401); // cookie is not a device key

    // A job naming the wrong provider does nothing.
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_mine", providerId: "provider_other" } as any);
    await hh.settle();
    expect((await store.get(PROVIDER, "rec_mine"))!.recording.status).toBe("stopped");

    // The other provider's recording at the same time never reaches my sessions (and their
    // calendar is empty, so nothing is assigned at all).
    const otherId = (await hh.repo.findProviderByIdentity("other.provider@example.invalid"))!;
    await makeRecording(store, { id: "rec_theirs", providerId: otherId, from: Z("13T18:00"), to: Z("13T18:30"), segs: [[Z("13T18:12"), 5, "Theirs."]] });
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_theirs", providerId: otherId } as any);
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_mine", providerId: PROVIDER } as any);
    await hh.settle();
    expect((await store.get(otherId, "rec_theirs"))!.recording.partition).toMatchObject({ sessions: [], unassignedSegments: 1 });
    const mine = (await store.get(PROVIDER, "rec_mine"))!.recording.partition!;
    const d = await sessionFor(hh, cookie, mine.sessions[0]!.sessionId);
    expect(d.bundle.evidence.map((e: any) => e.excerpt)).toEqual(["Mine."]);
  });

  it("discovery never creates sessions for calendar appointments", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const legacy = (await hh.repo.getAppointment("appointment_demo_001"))!;
    await hh.repo.upsertAppointment({ ...legacy, id: "appt_cal_demo_x", occurrenceId: "demo_x", startAt: Z("13T15:00"), endAt: Z("13T16:00") });
    expect((await hh.repo.listDiscoverableAppointments(hh.clock.now(), 7 * 24 * 60, 100, PROVIDER)).some((a) => a.id === "appt_cal_demo_x")).toBe(true);
    await hh.req("/api/sync", { method: "POST", cookie });
    await hh.settle();
    expect(await hh.repo.getSession(await sessionIdFor(PROVIDER, "demo_x"))).toBeNull();
    expect(await hh.repo.getSession(await sessionIdFor(PROVIDER, legacy.occurrenceId))).not.toBeNull(); // legacy still discovered
  });

  it("device schedule endpoint", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const r = await dev(hh, "/api/device/schedule?date=2026-11-13&timezone=America/Los_Angeles", key);
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.events.map((e: any) => [e.eventId, e.status])).toEqual([
      ["demo_sd_335_a_20261113_fri1", "cancelled"],
      [FRI2, "confirmed"],
      [FRI3, "confirmed"],
      ["demo_sd_320_a_20261113_fri4", "confirmed"],
    ]);
    // Without a timezone: events starting on that date in their own zone.
    const own = await dev(hh, "/api/device/schedule?date=2026-11-13", key);
    expect(own.json.data.events.map((e: any) => e.eventId)).toEqual(r.json.data.events.map((e: any) => e.eventId));
    // Default date = today (2026-11-13 12:00 PT).
    expect((await dev(hh, "/api/device/schedule?timezone=America/Los_Angeles", key)).json.data.events).toHaveLength(4);
    expect((await dev(hh, "/api/device/schedule?date=2026-11-31", key)).status).toBe(400);
    expect((await dev(hh, "/api/device/schedule?date=2026-11-13&timezone=Mars/Base", key)).status).toBe(400);
    expect((await dev(hh, "/api/device/schedule?date=2026-11-14", key)).json.data.events).toEqual([]); // Saturday
    expect((await dev(hh, "/api/device/schedule?date=2026-11-13", null)).status).toBe(401);
    // Another provider: an empty calendar.
    const other = await hh.login("other.provider@example.invalid");
    expect((await dev(hh, "/api/device/schedule?date=2026-11-13", await pair(hh, other))).json.data.events).toEqual([]);
  });

  it("partition job retries on a calendar failure and fails after max attempts", async () => {
    let calls = 0;
    const { hh, store, partitionDeps } = await setup({ sync: () => async () => { calls++; throw new Error("calendar down"); } });
    h = hh;
    await makeRecording(store, { id: "rec_fail", from: Z("13T18:00"), to: Z("13T18:30"), segs: [[Z("13T18:10"), 5, "x"]] });
    const job = { kind: "partition_recording" as const, recordingId: "rec_fail", providerId: PROVIDER };
    for (let a = 1; a < 5; a++) expect((await runPartition(partitionDeps(), job, a)).retry).toBe(true);
    expect(await runPartition(partitionDeps(), job, 5)).toEqual({ retry: false });
    expect(calls).toBe(5);
    expect((await store.get(PROVIDER, "rec_fail"))!).toMatchObject({ recording: { status: "failed" }, errorCode: "CALENDAR_UNAVAILABLE" });
  });
});
