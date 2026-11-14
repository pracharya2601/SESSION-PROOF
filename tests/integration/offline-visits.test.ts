/**
 * Offline recordings end to end: a paired phone creates an offline visit (real past times),
 * uploads a VXREC1 file built from real band Opus packets, the queue job reads it from a fake R2,
 * muxes Ogg Opus, calls a fake Deepgram pre-recorded endpoint, stores segments on the wall clock,
 * deletes the audio, and the session reaches NEEDS_REVIEW. Plus auth, isolation, idempotency,
 * discovery safety, retries / failure, and the audio sweep.
 * Real modules + Miniflare D1 via the v3 harness.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { ORIGIN } from "../e2e/harness";
import { createVisitStore } from "../../src/band/store";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import { SIMULATED_SCRIPT } from "../../src/band/transcriber";
import { oggPackets } from "../../src/ui/vendor/vexo-open/index.js";
import { buildVxrec } from "../../src/offline/vxrec";
import { createOfflineStore } from "../../src/offline/store";
import {
  DEEPGRAM_PRERECORDED_URL,
  runOfflineTranscription,
  sweepOfflineAudio,
  type AudioBucket,
  type OfflineJobDeps,
} from "../../src/offline/job";
import type { OfflineTranscribeJob, VxrecHeader } from "../../src/contracts";

const PACKETS = oggPackets(new Uint8Array(readFileSync(resolve(__dirname, "../../src/ui/public/sample-speech.opus"))));

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

class FakeBucket implements AudioBucket {
  objects = new Map<string, Uint8Array>();
  failPut = false;
  async put(key: string, value: ArrayBuffer | Uint8Array) {
    if (this.failPut) throw new Error("r2 down");
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

interface DgCall {
  url: string;
  auth: string | null;
  type: string | null;
  packets: number;
}

/** Fake Deepgram pre-recorded: checks the body is Ogg Opus and returns utterances. */
function fakeDeepgram(utterances: unknown[], status = 200) {
  const calls: DgCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = new Uint8Array(init?.body as Uint8Array);
    calls.push({ url, auth: headers.get("authorization"), type: headers.get("content-type"), packets: oggPackets(body).length });
    if (status !== 200) return new Response("secret echo that must not be logged", { status });
    return new Response(JSON.stringify({ metadata: {}, results: { channels: [], utterances } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

async function setup(opts: { deepgram?: boolean } = {}) {
  const hh = await createV3Harness();
  const anyH = hh as any;
  const store = createVisitStore(hh.db);
  anyH.apiDeps.visits = { store, enqueueAppointment: (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt) };
  // Mirror src/index.ts: band appointments read their own transcript.
  const evidence = new VisitRoutingEvidenceSource(new BandEvidenceSource(store, () => hh.clock.now()), hh.mods.vexo.createEvidenceSource(hh.env));
  const wfDeps = {
    repo: hh.repo,
    evidence,
    extractor: hh.mods.ai.createExtractor(hh.env),
    match: hh.mods.domain.matchEvidence,
    assemble: hh.mods.domain.assembleBundle,
    clock: hh.clock,
    runtimeMode: "local",
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(wfDeps, params, step);
  if (opts.deepgram !== false) (hh.env as any).DEEPGRAM_API_KEY = "dg-test-key";
  const bucket = new FakeBucket();
  (hh.env as any).AUDIO_TMP = bucket;
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  const offline = createOfflineStore(hh.db);
  let dgFetch: typeof fetch = fakeDeepgram([]).fn;
  const jobDeps = (): OfflineJobDeps => ({
    store: offline,
    visits: store,
    repo: hh.repo,
    bucket,
    env: hh.env as any,
    clock: hh.clock,
    fetch: dgFetch,
    enqueueAppointment: (appt) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt),
  });
  (hh.jobs as any).transcribeOffline = (job: OfflineTranscribeJob, attempt: number) => runOfflineTranscription(jobDeps(), job, attempt);
  return { hh, store, cookie, bucket, offline, jobDeps, setFetch: (f: typeof fetch) => (dgFetch = f) };
}

async function pair(hh: V3Harness, cookie: string): Promise<string> {
  const r = await hh.req("/api/devices", { method: "POST", cookie, body: { name: "Field phone" } });
  expect(r.status, r.text).toBe(201);
  return r.json.data.key;
}

/** Device request: bearer key, no cookie, no Origin (like URLSession). */
async function dev(hh: V3Harness, path: string, key: string | null, o: { method?: string; json?: unknown; bytes?: Uint8Array; type?: string } = {}) {
  const headers: Record<string, string> = {};
  if (key) headers["authorization"] = `Bearer ${key}`;
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.bytes) {
    headers["content-type"] = o.type ?? "application/octet-stream";
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

function times(hh: V3Harness) {
  // Recorded 3 hours before "now", 20 minutes long; run 1 starts 2 minutes after run 0.
  const from = hh.clock.now().getTime() - 3 * 3600_000;
  return { from, to: from + 20 * 60_000, run0: from + 5_000, run1: from + 125_000 };
}

function createBody(hh: V3Harness, over: Record<string, unknown> = {}) {
  const t = times(hh);
  return {
    localId: "rec-2026-0001",
    clientRef: "C-104",
    bandNumber: 7,
    recordedFrom: new Date(t.from).toISOString(),
    recordedTo: new Date(t.to).toISOString(),
    timezone: "America/Chicago",
    consentConfirmedAt: new Date(t.from - 30_000).toISOString(),
    ...over,
  };
}

/** Run 0: packets 0..399 (seq 100.., with 5 lost), run 1: packets 400..795 (seq 0..). */
function recording(hh: V3Harness, over: Partial<VxrecHeader> = {}) {
  const t = times(hh);
  const header: VxrecHeader = {
    version: 1,
    bandNumber: 7,
    audioRuns: [
      { runIndex: 0, audioStartMs: t.run0 },
      { runIndex: 1, audioStartMs: t.run1 },
    ],
    recordedFrom: new Date(t.from).toISOString(),
    recordedTo: new Date(t.to).toISOString(),
    clientRef: "C-104",
    localId: "rec-2026-0001",
    appVersion: "GlassCam 1.0 (1)",
    ...over,
  };
  const recs: { runIndex: number; seq: number; opus: Uint8Array }[] = [];
  for (let i = 0; i < 400; i++) if (i < 50 || i >= 55) recs.push({ runIndex: 0, seq: 100 + i, opus: PACKETS[i]! });
  for (let i = 400; i < 796; i++) recs.push({ runIndex: 1, seq: i - 400, opus: PACKETS[i]! });
  return buildVxrec(header, recs);
}

/** 3 utterances in run 0 (395 packets = 7.9 s of stream), 2 in run 1. */
const UTTERANCES = [
  { start: 0.5, end: 1.5, transcript: SIMULATED_SCRIPT[0]!.text, speaker: 0 }, // crosses the 5 lost packets at 1.0 s
  { start: 1.6, end: 3.0, transcript: SIMULATED_SCRIPT[1]!.text, speaker: 1 },
  { start: 4.0, end: 6.0, transcript: SIMULATED_SCRIPT[2]!.text, speaker: 0 },
  { start: 8.4, end: 10.0, transcript: SIMULATED_SCRIPT[3]!.text, speaker: 0 }, // run 1 starts at stream 7.9 s
  { start: 12.0, end: 14.5, transcript: SIMULATED_SCRIPT[4]!.text, speaker: 1 },
  { start: 15.0, end: 15.2, transcript: "   ", speaker: 0 }, // empty: skipped
];

describe("offline recordings", () => {
  it("create → upload → Deepgram → segments on the wall clock → audio deleted → NEEDS_REVIEW", async () => {
    const { hh, cookie, bucket, setFetch } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const dg = fakeDeepgram(UTTERANCES);
    setFetch(dg.fn);
    const t = times(hh);

    const c1 = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    expect(c1.status, c1.text).toBe(201);
    const visit = c1.json.data.visit;
    expect(visit).toMatchObject({
      clientRef: "C-104",
      status: "stopped",
      transcriber: "deepgram",
      bandNumber: 7,
      sessionId: null,
      startedAt: new Date(t.from).toISOString(),
      endedAt: new Date(t.to).toISOString(),
    });
    expect(c1.json.data.status).toBe("awaiting_audio");
    expect(c1.json.data.uploadUrl).toBe(`${ORIGIN}/api/device/offline-visits/${visit.id}/audio`);
    expect(c1.json.data.statusUrl).toBe(`${ORIGIN}/api/device/offline-visits/${visit.id}`);
    expect(c1.json.data.maxUploadBytes).toBe(50 * 1024 * 1024);
    const appt = await hh.repo.getAppointment(visit.appointmentId);
    expect(appt).toMatchObject({ startAt: new Date(t.from).toISOString(), endAt: new Date(t.to).toISOString(), canceled: true, timezone: "America/Chicago" });

    // Idempotent on (device, localId); a different recording under the same localId is a conflict.
    const c2 = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    expect(c2.status, c2.text).toBe(200);
    expect(c2.json.data.visit.id).toBe(visit.id);
    const clash = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh, { clientRef: "C-200" }) });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe("LOCAL_ID_CONFLICT");

    // Discovery must not process the pending visit, and a stop call must not hand it off early.
    expect((await hh.repo.listDiscoverableAppointments(hh.clock.now(), 7 * 24 * 60, 100)).some((a) => a.id === visit.appointmentId)).toBe(false);
    await hh.req("/api/sync", { method: "POST", cookie });
    await hh.settle();
    const early = await dev(hh, `/api/device/visits/${visit.id}/stop`, key, { method: "POST" });
    expect(early.status, early.text).toBe(409);
    expect(early.json.error.code).toBe("VISIT_PENDING_UPLOAD");
    expect((await hh.req(`/api/visits/${visit.id}/stop`, { method: "POST", cookie })).status).toBe(409);

    const s0 = await dev(hh, `/api/device/offline-visits/${visit.id}`, key);
    expect(s0.json.data).toEqual({ visitId: visit.id, status: "awaiting_audio", sessionId: null, segmentCount: 0, canDeleteLocalFile: false, error: null });

    // Upload validation.
    const file = recording(hh);
    expect((await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, { method: "PUT", bytes: file, type: "audio/ogg" })).status).toBe(415);
    const magic = await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, { method: "PUT", bytes: new TextEncoder().encode("hello world") });
    expect(magic.status).toBe(400);
    expect(magic.json.error.code).toBe("FILE_BAD_MAGIC");
    const wrong = await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, { method: "PUT", bytes: recording(hh, { localId: "rec-other-0001" }) });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("FILE_MISMATCH");
    const outside = await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, {
      method: "PUT",
      bytes: recording(hh, { audioRuns: [{ runIndex: 0, audioStartMs: t.to + 3600_000 }, { runIndex: 1, audioStartMs: t.to + 3700_000 }] }),
    });
    expect(outside.json.error.code).toBe("FILE_MISMATCH");
    expect(bucket.objects.size).toBe(0);

    const up = await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, { method: "PUT", bytes: file });
    expect(up.status, up.text).toBe(202);
    expect(up.json.data).toEqual({ status: "queued" });
    const r2key = `audio-tmp/provider_demo_001/${visit.id}.bin`;
    expect([...bucket.objects.keys()]).toEqual([r2key]);
    expect(bucket.objects.get(r2key)!.length).toBe(file.length);
    expect(hh.queue.pending).toEqual([{ kind: "transcribe_offline", schemaVersion: "1", visitId: visit.id, providerId: "provider_demo_001" }]);
    expect((await dev(hh, `/api/device/offline-visits/${visit.id}`, key)).json.data.status).toBe("transcribing");
    // Re-upload while queued: no second job.
    expect((await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, { method: "PUT", bytes: file })).status).toBe(202);
    expect(hh.queue.pending).toHaveLength(1);

    await hh.settle();

    expect(dg.calls).toHaveLength(1);
    expect(dg.calls[0]).toEqual({ url: DEEPGRAM_PRERECORDED_URL, auth: "Token dg-test-key", type: "audio/ogg", packets: 791 });
    expect(bucket.objects.size).toBe(0); // audio never kept

    const det = await dev(hh, `/api/device/visits/${visit.id}`, key);
    const segs = det.json.data.segments;
    expect(segs.map((s: any) => s.text)).toEqual(SIMULATED_SCRIPT.map((l) => l.text));
    expect(segs.map((s: any) => s.speaker)).toEqual(["Speaker 0", "Speaker 1", "Speaker 0", "Speaker 0", "Speaker 1"]);
    expect(segs.every((s: any) => s.sourceMode === "live")).toBe(true);
    const iso = (ms: number) => new Date(ms).toISOString();
    // run 0: stream sec → run0 + sec, plus 100 ms after the 5 lost packets (stream 1.0 s = band packet 55)
    expect([segs[0].observedFrom, segs[0].observedTo]).toEqual([iso(t.run0 + 500), iso(t.run0 + 1600)]);
    expect([segs[1].observedFrom, segs[1].observedTo]).toEqual([iso(t.run0 + 1700), iso(t.run0 + 3100)]);
    expect(segs[2].observedFrom).toBe(iso(t.run0 + 4100));
    // run 1 begins at stream 7.9 s
    expect([segs[3].observedFrom, segs[3].observedTo]).toEqual([iso(t.run1 + 500), iso(t.run1 + 2100)]);
    expect(segs[4].observedFrom).toBe(iso(t.run1 + 4100));
    expect(det.json.data.visit).toMatchObject({ packets: 791, lostPackets: 5, audioStartedAt: iso(t.run0) });

    const st = await dev(hh, `/api/device/offline-visits/${visit.id}`, key);
    expect(st.json.data).toMatchObject({ status: "needs_review", segmentCount: 5, canDeleteLocalFile: true, error: null });
    const sessionId = st.json.data.sessionId;
    expect(sessionId).toBeTruthy();
    const d = await hh.req(`/api/sessions/${sessionId}`, { cookie });
    expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
    expect(d.json.data.bundle.evidence.map((e: any) => e.id)).toEqual(["ev_001", "ev_002", "ev_003", "ev_004", "ev_005"]);
    expect(d.json.data.bundle.provenance.evidenceMode).toBe("live");
    expect(d.json.data.bundle.provenance.evidenceWarnings.join(" ")).toMatch(/5 audio packet/);
    expect((await hh.repo.getAppointment(visit.appointmentId))!.canceled).toBe(false);

    // Upload after transcription: nothing to do.
    const again = await dev(hh, `/api/device/offline-visits/${visit.id}/audio`, key, { method: "PUT", bytes: file });
    expect(again.status).toBe(200);
    expect(again.json.data).toEqual({ status: "already_transcribed" });
    expect(hh.queue.pending).toHaveLength(0);
    // Stop is now a no-op returning the same session.
    expect((await dev(hh, `/api/device/visits/${visit.id}/stop`, key, { method: "POST" })).json.data.sessionId).toBe(sessionId);
  });

  it("device key auth, provider isolation, validation", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const c = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    const id = c.json.data.visit.id;

    // No key / cookie only → 401; cookie POST without bearer still hits the origin guard.
    expect((await dev(hh, `/api/device/offline-visits/${id}`, null)).status).toBe(401);
    expect((await dev(hh, "/api/device/offline-visits", "vfad_" + "x".repeat(43), { method: "POST", json: createBody(hh) })).status).toBe(401);
    expect((await hh.req(`/api/device/offline-visits/${id}`, { cookie })).status).toBe(401);

    // Another provider's phone: 404 on GET and PUT; its own localId space.
    const other = await hh.login("other.provider@example.invalid");
    const otherKey = await pair(hh, other);
    expect((await dev(hh, `/api/device/offline-visits/${id}`, otherKey)).status).toBe(404);
    expect((await dev(hh, `/api/device/offline-visits/${id}/audio`, otherKey, { method: "PUT", bytes: recording(hh) })).status).toBe(404);
    expect((await dev(hh, `/api/device/visits/${id}`, otherKey)).status).toBe(404);
    // A second phone of the same provider has its own localId space (same localId → new visit).
    const key2 = await pair(hh, cookie);
    const c2 = await dev(hh, "/api/device/offline-visits", key2, { method: "POST", json: createBody(hh) });
    expect(c2.status).toBe(201);
    expect(c2.json.data.visit.id).not.toBe(id);

    // Revoked device → 401 DEVICE_REVOKED.
    const devices = (await hh.req("/api/devices", { cookie })).json.data;
    await hh.req(`/api/devices/${devices[0].id}`, { method: "DELETE", cookie });
    const revoked = await dev(hh, `/api/device/offline-visits/${c2.json.data.visit.id}`, key2);
    expect(revoked.status).toBe(401);
    expect(revoked.json.error.code).toBe("DEVICE_REVOKED");

    // Validation.
    const bad = async (over: Record<string, unknown>) => (await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh, { localId: "rec-new-00001", ...over }) })).status;
    const now = hh.clock.now().getTime();
    expect(await bad({ providerId: "x" })).toBe(400);
    expect(await bad({ localId: "short" })).toBe(400);
    expect(await bad({ recordedTo: new Date(now - 4 * 3600_000).toISOString() })).toBe(400); // before recordedFrom
    expect(await bad({ recordedFrom: new Date(now - 6 * 3600_000).toISOString(), recordedTo: new Date(now - 1000).toISOString() })).toBe(400); // > 4 h
    expect(await bad({ recordedFrom: new Date(now + 3600_000).toISOString(), recordedTo: new Date(now + 7200_000).toISOString() })).toBe(400); // future
    expect(await bad({ recordedFrom: new Date(now - 40 * 86_400_000).toISOString(), recordedTo: new Date(now - 40 * 86_400_000 + 60_000).toISOString() })).toBe(400); // too old
    expect(await bad({ consentConfirmedAt: new Date(now).toISOString() })).toBe(400); // consent after the end
    expect(await bad({ clientRef: "NOPE-1" })).toBe(422);
    // Too large (declared) → 413.
    const big = await dev(hh, `/api/device/offline-visits/${id}/audio`, key, { method: "PUT", bytes: new Uint8Array(10) });
    expect(big.status).toBe(400); // FILE_BAD_MAGIC (small but wrong)
    const res = await (hh as any).app.request(
      `${ORIGIN}/api/device/offline-visits/${id}/audio`,
      { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/octet-stream", "content-length": String(60 * 1024 * 1024) }, body: new Uint8Array(4) },
      hh.env,
    );
    expect(res.status).toBe(413);
  });

  it("deployed without Deepgram: create is 503; no R2 binding: 503", async () => {
    const { hh, cookie } = await setup({ deepgram: false });
    h = hh;
    const key = await pair(hh, cookie);
    (hh.env as any).RUNTIME_MODE = "deployed";
    const r = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("TRANSCRIPTION_NOT_CONFIGURED");
    (hh.env as any).RUNTIME_MODE = "local";
    delete (hh.env as any).AUDIO_TMP;
    const n = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    expect(n.status).toBe(503);
    expect(n.json.error.code).toBe("OFFLINE_NOT_CONFIGURED");
  });

  it("local dev without a key: the simulated script, labelled fixture", async () => {
    const { hh, cookie } = await setup({ deepgram: false });
    h = hh;
    const key = await pair(hh, cookie);
    const c = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    expect(c.json.data.visit.transcriber).toBe("simulated");
    const id = c.json.data.visit.id;
    expect((await dev(hh, `/api/device/offline-visits/${id}/audio`, key, { method: "PUT", bytes: recording(hh) })).status).toBe(202);
    await hh.settle();
    const det = await dev(hh, `/api/device/visits/${id}`, key);
    expect(det.json.data.segments.map((s: any) => s.text)).toEqual(SIMULATED_SCRIPT.map((l) => l.text));
    expect(det.json.data.segments.every((s: any) => s.sourceMode === "fixture")).toBe(true);
    expect(det.json.data.segments[0].observedFrom).toBe(new Date(times(hh).run0).toISOString());
    expect((await dev(hh, `/api/device/offline-visits/${id}`, key)).json.data.status).toBe("needs_review");
  });

  it("retries transient Deepgram errors, fails after max attempts, deletes the audio 24 h later", async () => {
    const { hh, cookie, bucket, jobDeps, setFetch, offline } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const c = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh) });
    const id = c.json.data.visit.id;
    const file = recording(hh);
    expect((await dev(hh, `/api/device/offline-visits/${id}/audio`, key, { method: "PUT", bytes: file })).status).toBe(202);
    const job = hh.queue.pending.splice(0)[0] as unknown as OfflineTranscribeJob;

    const down = fakeDeepgram([], 503);
    setFetch(down.fn);
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      for (let attempt = 1; attempt < 5; attempt++) {
        const r = await runOfflineTranscription(jobDeps(), job, attempt);
        expect(r.retry).toBe(true);
        expect((await dev(hh, `/api/device/offline-visits/${id}`, key)).json.data.status).toBe("transcribing");
      }
      expect(await runOfflineTranscription(jobDeps(), job, 5)).toEqual({ retry: false });
    } finally {
      Object.assign(console, orig);
    }
    expect(down.calls).toHaveLength(5);
    expect(logs.join("\n")).not.toContain("secret echo");
    expect(logs.join("\n")).not.toContain("dg-test-key");
    const st = await dev(hh, `/api/device/offline-visits/${id}`, key);
    expect(st.json.data).toMatchObject({ status: "failed", canDeleteLocalFile: false, error: { code: "DEEPGRAM_UNAVAILABLE", retryable: true } });
    expect(bucket.objects.size).toBe(1); // kept for 24 h after the failure

    expect(await sweepOfflineAudio(jobDeps())).toEqual({ deleted: 0, stuck: 0 });
    hh.clock.advance(24 * 3600_000 + 1000);
    expect(await sweepOfflineAudio(jobDeps())).toEqual({ deleted: 1, stuck: 0 });
    expect(bucket.objects.size).toBe(0);
    expect((await offline.get("provider_demo_001", id))!.audioKey).toBeNull();

    // The phone uploads the same file again later: works once Deepgram is back.
    setFetch(fakeDeepgram(UTTERANCES).fn);
    expect((await dev(hh, `/api/device/offline-visits/${id}/audio`, key, { method: "PUT", bytes: file })).status).toBe(202);
    await hh.settle();
    expect((await dev(hh, `/api/device/offline-visits/${id}`, key)).json.data).toMatchObject({ status: "needs_review", segmentCount: 5 });
    expect(bucket.objects.size).toBe(0);
  });

  it("permanent errors fail at once; stuck jobs are failed by the sweep; queue send failure reverts", async () => {
    const { hh, cookie, bucket, jobDeps, setFetch } = await setup();
    h = hh;
    const key = await pair(hh, cookie);
    const mk = async (localId: string) => {
      const c = await dev(hh, "/api/device/offline-visits", key, { method: "POST", json: createBody(hh, { localId }) });
      expect(c.status, c.text).toBe(201);
      return c.json.data.visit.id as string;
    };
    const file = (localId: string) => recording(hh, { localId });

    // Deepgram 400 → failed, not retryable, no queue retry.
    const a = await mk("rec-perm-0001");
    await dev(hh, `/api/device/offline-visits/${a}/audio`, key, { method: "PUT", bytes: file("rec-perm-0001") });
    const jobA = hh.queue.pending.splice(0)[0] as unknown as OfflineTranscribeJob;
    setFetch(fakeDeepgram([], 400).fn);
    expect(await runOfflineTranscription(jobDeps(), jobA, 1)).toEqual({ retry: false });
    expect((await dev(hh, `/api/device/offline-visits/${a}`, key)).json.data.error).toMatchObject({ code: "DEEPGRAM_REJECTED", retryable: false });

    // Queue send failure → 503 and back to awaiting_audio (object swept in 24 h).
    const b = await mk("rec-queue-0001");
    hh.queue.failNextSend = 1;
    const up = await dev(hh, `/api/device/offline-visits/${b}/audio`, key, { method: "PUT", bytes: file("rec-queue-0001") });
    expect(up.status).toBe(503);
    expect(up.json.error).toMatchObject({ code: "QUEUE_UNAVAILABLE", retryable: true });
    expect((await dev(hh, `/api/device/offline-visits/${b}`, key)).json.data.status).toBe("awaiting_audio");

    // R2 put failure → 503, nothing queued.
    const c = await mk("rec-r2-00001");
    bucket.failPut = true;
    expect((await dev(hh, `/api/device/offline-visits/${c}/audio`, key, { method: "PUT", bytes: file("rec-r2-00001") })).status).toBe(503);
    bucket.failPut = false;
    expect(hh.queue.pending).toHaveLength(0);

    // Stuck: uploaded, but the job never ran.
    const d = await mk("rec-stuck-001");
    await dev(hh, `/api/device/offline-visits/${d}/audio`, key, { method: "PUT", bytes: file("rec-stuck-001") });
    hh.queue.pending.splice(0);
    hh.clock.advance(7 * 3600_000);
    const sw = await sweepOfflineAudio(jobDeps());
    expect(sw.stuck).toBe(1);
    expect((await dev(hh, `/api/device/offline-visits/${d}`, key)).json.data.error).toMatchObject({ code: "TRANSCRIPTION_TIMEOUT", retryable: true });
    hh.clock.advance(25 * 3600_000);
    await sweepOfflineAudio(jobDeps());
    expect(bucket.objects.size).toBe(0); // a's, b's and d's audio all gone
  });
});
