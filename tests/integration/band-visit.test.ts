/**
 * Band visits end to end: start a visit for C-104 with the pretend band, stream
 * audio packets through the capture session (simulated transcriber), stop it, and
 * the transcript becomes the evidence of a normal session that reaches NEEDS_REVIEW.
 * Real modules + Miniflare D1; the WebSocket itself is replaced by direct calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createVisitStore } from "../../src/band/store";
import { CaptureSession, decodePacket } from "../../src/band/capture";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import { signStreamToken, verifyStreamToken } from "../../src/band/token";
import { DeepgramAssembler, openSimulated, SIMULATED_SCRIPT, type FinalPiece } from "../../src/band/transcriber";
import type { VisitServerMessage } from "../../src/contracts";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

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
  // Mirror src/index.ts: band appointments route to the band evidence source.
  const workflowMod = hh.mods.workflow;
  const evidence = new VisitRoutingEvidenceSource(new BandEvidenceSource(store, () => hh.clock.now()), hh.mods.vexo.createEvidenceSource(hh.env));
  const deps = {
    repo: hh.repo,
    evidence,
    extractor: hh.mods.ai.createExtractor(hh.env),
    match: hh.mods.domain.matchEvidence,
    assemble: hh.mods.domain.assembleBundle,
    clock: hh.clock,
    runtimeMode: "local",
  };
  hh.workflow.run = (params: any, step: any) => workflowMod.runSessionWorkflow(deps, params, step);
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, store, cookie };
}

describe("band visit", () => {
  it("records with the pretend band, stops, and processes into a reviewable session", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;

    const cs = await hh.req("/api/visits/capture-status", { cookie });
    expect(cs.json.data.transcriber).toBe("simulated");

    expect((await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104" } })).status).toBe(400);
    expect((await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "NOPE-1", bandNumber: 42, transport: "sim" } })).status).toBe(422);

    // An abandoned visit (never stopped) overlaps the next one; band evidence is bound by visit id, so it must not cause ambiguity.
    const abandoned = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: 42, transport: "sim" } });
    expect(abandoned.status).toBe(201);
    const start = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: 42, transport: "sim" } });
    expect(start.status, start.text).toBe(201);
    const visit = start.json.data.visit;
    expect(visit).toMatchObject({ clientRef: "C-104", status: "recording", transcriber: "simulated", bandNumber: 42 });
    expect(visit.appointmentId.startsWith("appt_visit_")).toBe(true);
    expect(start.json.data.streamUrl).toMatch(/^ws:\/\/localhost:8787\/api\/visits\/visit_[0-9a-f]+\/stream\?token=/);

    // While recording, discovery must not pick the visit up (appointment still open).
    await hh.req("/api/sync", { method: "POST", cookie });
    await hh.settle();
    const before = await hh.req("/api/sessions", { cookie });
    expect(before.json.data.sessions.some((s: any) => s.clientRef === "C-104" && s.startAt === visit.startedAt)).toBe(false);

    // Stream: start control, then 16 s of packets with a 2-packet gap.
    const sent: VisitServerMessage[] = [];
    const audioStartMs = hh.clock.now().getTime() + 1000;
    const session = new CaptureSession({
      visit,
      store,
      openTranscriber: async (events) => openSimulated(events),
      send: (m) => sent.push(m),
      now: () => hh.clock.now(),
    });
    await session.open();
    expect(sent[0]).toEqual({ type: "ready", transcriber: "simulated" });
    session.onBinary(packet(0)); // before start → error, ignored
    expect(sent.some((m) => m.type === "error" && m.code === "no_start")).toBe(true);
    await session.onText(JSON.stringify({ type: "start", audioStartMs }));
    for (let seq = 0; seq < 800; seq++) if (seq !== 300 && seq !== 301) session.onBinary(packet(seq));
    expect(await session.onText(JSON.stringify({ type: "stop" }))).toBe(true);

    const finals = sent.filter((m): m is Extract<VisitServerMessage, { type: "final" }> => m.type === "final");
    expect(finals.map((f) => f.segment.text)).toEqual(SIMULATED_SCRIPT.map((l) => l.text));
    expect(finals[0]!.segment.observedFrom).toBe(new Date(audioStartMs).toISOString());
    expect(finals.every((f) => f.segment.sourceMode === "fixture")).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "done", segmentCount: 5 });

    hh.clock.advance?.(20_000);
    const stop = await hh.req(`/api/visits/${visit.id}/stop`, { method: "POST", cookie });
    expect(stop.status, stop.text).toBe(200);
    const sessionId = stop.json.data.sessionId;
    expect(stop.json.data.visit).toMatchObject({ status: "stopped", segmentCount: 5, lostPackets: 2, packets: 798, sessionId });
    // stop is idempotent
    expect((await hh.req(`/api/visits/${visit.id}/stop`, { method: "POST", cookie })).json.data.sessionId).toBe(sessionId);

    await hh.settle();
    const d = await hh.req(`/api/sessions/${sessionId}`, { cookie });
    expect(d.status, d.text).toBe(200);
    expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
    expect(d.json.data.bundle.evidence.map((e: any) => e.id)).toEqual(["ev_001", "ev_002", "ev_003", "ev_004", "ev_005"]);
    expect(d.json.data.bundle.evidence[0].sourceId).toBe(`band_visit:${visit.id}`);
    const prov = d.json.data.bundle.provenance;
    expect(prov.evidenceMode).toBe("fixture"); // simulated transcript is never labelled live
    expect(prov.evidenceCompleteness).toBe("partial"); // packets were lost
    expect(prov.evidenceWarnings.join(" ")).toMatch(/Simulated transcript/);
    expect(prov.evidenceWarnings.join(" ")).toMatch(/2 audio packet/);

    // Detail + isolation
    const det = await hh.req(`/api/visits/${visit.id}`, { cookie });
    expect(det.json.data.segments).toHaveLength(5);
    const other = await hh.login("other.provider@example.invalid").catch(() => null);
    if (other) {
      expect((await hh.req(`/api/visits/${visit.id}`, { cookie: other })).status).toBe(404);
      expect((await hh.req(`/api/visits/${visit.id}/stop`, { method: "POST", cookie: other })).status).toBe(404);
    }
  });

  it("stream route: token auth, origin guard, upgrade required", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const start = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: null, transport: "ble" } });
    const visit = start.json.data.visit;
    const token = new URL(start.json.data.streamUrl.replace(/^ws/, "http")).searchParams.get("token")!;
    const path = `/api/visits/${visit.id}/stream`;

    // valid token, no upgrade header → 426 (auth passed)
    expect((await hh.req(`${path}?token=${encodeURIComponent(token)}`, { origin: null })).status).toBe(426);
    // bad token
    expect((await hh.req(`${path}?token=nope`, { origin: null })).status).toBe(401);
    // token for another visit
    const secret = String(hh.env.SESSION_SECRET);
    const wrong = await signStreamToken({ providerId: "provider_demo_001", visitId: "visit_other", nowMs: hh.clock.now().getTime() }, secret);
    expect((await hh.req(`${path}?token=${encodeURIComponent(wrong.token)}`, { origin: null })).status).toBe(401);
    // cookie without Origin, or cross-origin → 403
    expect((await hh.req(path, { cookie, origin: null })).status).toBe(403);
    expect((await hh.req(path, { cookie, origin: "https://evil.example" })).status).toBe(403);
    // cookie + same origin → passes auth (426)
    expect((await hh.req(path, { cookie })).status).toBe(426);
    // nothing at all
    expect((await hh.req(path, { origin: null })).status).toBe(403);
  });
});

describe("stream token", () => {
  it("is bound to one visit and expires", async () => {
    const secret = "integration-test-session-secret-0123456789abcdef";
    const now = Date.parse("2026-11-14T10:00:00Z");
    const t = await signStreamToken({ providerId: "p1", visitId: "visit_a", nowMs: now }, secret);
    expect(await verifyStreamToken(t.token, "visit_a", secret, now)).toBe("p1");
    expect(await verifyStreamToken(t.token, "visit_b", secret, now)).toBeNull();
    expect(await verifyStreamToken(t.token, "visit_a", secret + "x", now)).toBeNull();
    expect(await verifyStreamToken(t.token, "visit_a", secret, now + 5 * 3600_000)).toBeNull();
  });
});

describe("deepgram assembler", () => {
  it("joins final pieces into one utterance per pause, with the majority speaker", () => {
    const finals: FinalPiece[] = [];
    const interims: string[] = [];
    const a = new DeepgramAssembler({ onFinal: (p) => finals.push(p), onInterim: (t) => interims.push(t), onError: () => undefined });
    const res = (o: object) => JSON.stringify({ type: "Results", ...o });
    a.handle(res({ is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "we will" }] } }));
    a.handle(res({ is_final: true, start: 0, duration: 1.2, channel: { alternatives: [{ transcript: "We will practice", words: [{ speaker: 1 }, { speaker: 1 }, { speaker: 0 }] }] } }));
    a.handle(res({ is_final: true, speech_final: true, start: 1.2, duration: 0.8, channel: { alternatives: [{ transcript: "the bus route.", words: [{ speaker: 1 }] }] } }));
    a.handle(res({ is_final: true, start: 3, duration: 1, channel: { alternatives: [{ transcript: "Okay.", words: [{ speaker: 0 }] }] } }));
    a.handle(JSON.stringify({ type: "UtteranceEnd" }));
    a.handle("not json");
    a.handle(res({ is_final: true, speech_final: true, start: 5, duration: 1, channel: { alternatives: [{ transcript: "" }] } }));
    expect(interims).toEqual(["we will"]);
    expect(finals).toEqual([
      { startSec: 0, endSec: 2, text: "We will practice the bus route.", speaker: "Speaker 1" },
      { startSec: 3, endSec: 4, text: "Okay.", speaker: "Speaker 0" },
    ]);
  });

  it("decodes the 2-byte big-endian seq header", () => {
    const p = decodePacket(packet(0x1234, 3))!;
    expect(p.seq).toBe(0x1234);
    expect(Array.from(p.opus)).toEqual([0xab, 0xab, 0xab]);
    expect(decodePacket(new Uint8Array(2))).toBeNull();
    expect(decodePacket(new Uint8Array(2000))).toBeNull();
  });
});

describe("capture timeline", () => {
  it("a second start after a reconnect jumps the timeline by the gap", async () => {
    const pieces: number[] = [];
    const store = { listSegments: async () => [], setAudioStarted: async () => {}, updateStats: async () => {}, saveSegment: async () => {} } as any;
    const indexes: number[] = [];
    const s = new CaptureSession({
      visit: { id: "visit_t", providerId: "p", packets: 0, lostPackets: 0 } as any,
      store,
      openTranscriber: async () => ({ kind: "simulated", feed: (_o: Uint8Array, i: number) => indexes.push(i), keepAlive() {}, finish: async () => {}, close() {} }),
      send: () => pieces.push(0),
      now: () => new Date(0),
    });
    await s.open();
    await s.onText(JSON.stringify({ type: "start", audioStartMs: 1_000_000 }));
    s.onBinary(packet(0));
    s.onBinary(packet(1));
    // reconnect 10 s later, seq back to 0
    await s.onText(JSON.stringify({ type: "start", audioStartMs: 1_010_000 }));
    s.onBinary(packet(0));
    expect(indexes).toEqual([0, 1, 500]);
  });
});
