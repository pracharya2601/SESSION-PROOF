/**
 * Pass 2 of the recording partition (docs/recordings.md "Content suggestions" and
 * "Conversation type"): leftover segments → blocks → content suggestions the provider accepts or
 * rejects, plus the conversation type of every session / suggestion block. Real modules +
 * Miniflare D1 via the v3 harness, demo calendar + Drive, fake AI providers.
 *
 * Demo calendar (America/Los_Angeles, PST = UTC−8):
 *   Fri 2026-11-13  fri2 C-104 18:00–19:00Z, fri3 SD-334-A 19:00–20:00Z, fri4 SD-320-A 23:45–01:00Z
 *   Sat 2026-11-14  no events
 */
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createVisitStore } from "../../src/band/store";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
import {
  calendarSync,
  createRecordingStore,
  detectBlocks,
  driveContextResolver,
  RecordingEvidenceSource,
  RecordingRoutingEvidenceSource,
  runPartition,
  sweepRecordings,
  validateAiOutput,
  validateConversationOutput,
  visitContextResolver,
  type AcceptDeps,
  type ContentAi,
  type PartitionDeps,
  type RecordingStore,
} from "../../src/recordings";
import { clientKnownTerms } from "../../src/clients";
import { appointmentIdForEvent, DemoCalendarSource, DemoDriveSource, syncCalendarToAppointments } from "../../src/schedule";
import { sessionIdFor, type BandSegment, type InferenceRequest } from "../../src/contracts";

const PROVIDER = "provider_demo_001";
const FRI3 = "demo_sd_334_a_20261113_fri3";
const FRI2 = "demo_c_104_20261113_fri2";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** Fake AI: records every outbound request; answers with `answer(req)`. */
function fakeAi(answer: (req: InferenceRequest) => unknown) {
  const sent: InferenceRequest[] = [];
  const ai: ContentAi = {
    privacy: { redactNames: true, redactContact: true, redactIdentifiers: false, redactAddresses: true, redactDates: false },
    provider: {
      id: "openai",
      model: "fake",
      async generateStructured(req) {
        sent.push(req);
        return { output: answer(req), provider: "openai", model: "fake" };
      },
    },
  };
  return { ai, sent };
}

async function setup(opts: { ai?: ContentAi | null } = {}) {
  const hh = await createV3Harness();
  const anyH = hh as any;
  const visits = createVisitStore(hh.db);
  const store = createRecordingStore(hh.db);
  const calendar = new DemoCalendarSource({ clock: hh.clock });
  const drive = new DemoDriveSource();
  const enqueue = (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt);
  const syncCalendar = calendarSync({
    calendar,
    sync: (providerId, from, to) => syncCalendarToAppointments(hh.repo, calendar, providerId, from, to, { now: hh.clock.now() }),
    appointmentIdForEvent,
    getAppointment: (id) => hh.repo.getAppointment(id),
  });
  const content: AcceptDeps = {
    store,
    clock: hh.clock,
    calendar,
    drive,
    listClientRefs: async (p) => (await hh.repo.listClients(p, { includeInactive: false, limit: 50 })).map((c) => c.client.clientRef),
    knownTerms: async (p, refs) => (await Promise.all(refs.map(async (r) => clientKnownTerms(await hh.repo.getClient(p, r))))).flat(),
    resolveAi: async () => opts.ai ?? null,
    repo: hh.repo,
    queue: hh.queue as any,
    syncCalendar,
    enqueueAppointment: enqueue,
  };
  anyH.apiDeps.recordings = { store, calendar, content };
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
    resolveVisitContext: visitContextResolver({ store, calendar, drive }),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(wfDeps, params, step);
  const partitionDeps = (): PartitionDeps => ({ store, repo: hh.repo, queue: hh.queue as any, clock: hh.clock, syncCalendar, enqueueAppointment: enqueue, content });
  (hh.jobs as any).partitionRecording = (job: any, attempt: number) => runPartition(partitionDeps(), job, attempt);
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, store, cookie, content };
}

type Line = [at: string, speaker: string, text: string];
const at = (s: string) => `2026-11-${s}.000Z`;

/** A stopped recording with exact 8 s segments, partitioned (pass 1 + pass 2). */
async function record(hh: V3Harness, store: RecordingStore, id: string, lines: Line[]) {
  const from = lines[0]![0];
  const to = new Date(Date.parse(lines.at(-1)![0]) + 60_000).toISOString();
  await store.create({ id, providerId: PROVIDER, deviceId: null, bandNumber: 7, transport: "ble", transcriber: "simulated", startedAt: from, timezone: "America/Los_Angeles", scenario: null, now: from });
  const segs: BandSegment[] = lines.map(([t, speaker, text], i) => ({
    id: `${id}:${i + 1}`,
    visitId: id,
    index: i + 1,
    observedFrom: t,
    observedTo: new Date(Date.parse(t) + 8000).toISOString(),
    speaker,
    text,
    sourceMode: "fixture",
  }));
  await store.capture.saveSegments(PROVIDER, segs, from);
  await store.stop(PROVIDER, id, to);
  if (hh.clock.now().getTime() < Date.parse(to)) hh.clock.advance(Date.parse(to) - hh.clock.now().getTime() + 60_000);
  await hh.queue.send({ kind: "partition_recording", recordingId: id, providerId: PROVIDER } as any);
  await hh.settle();
}

// SD-334-A ran 11:00–12:00 PT and overran to 12:14: the last lines' midpoints are past end + 10 min.
const OVERRAN: Line[] = [
  [at("13T19:30:00"), "Speaker 0", "Today we keep working on your money skills."],
  [at("13T19:31:00"), "Speaker 1", "Okay, I brought my receipts."],
  [at("13T20:12:00"), "Speaker 0", "Let's look at the electric bill. Where is the amount due?"],
  [at("13T20:12:20"), "Speaker 1", "The amount due is forty dollars."],
  [at("13T20:12:40"), "Speaker 0", "Good job Jordan. And the due date?"],
  [at("13T20:13:00"), "Speaker 1", "The due date is the twentieth."],
  [at("13T20:13:20"), "Speaker 0", "Now write it in your budget sheet under spending."],
  [at("13T20:13:40"), "Speaker 1", "I tracked my spending for the bill."],
];

// 12:40 PT between fri3 and fri4: small talk, nobody's goals.
const SMALL_TALK: Line[] = [
  [at("13T20:40:00"), "Speaker 0", "I'm going to grab a sandwich before the next one."],
  [at("13T20:40:20"), "Speaker 1", "The traffic on the highway was terrible this morning."],
  [at("13T20:40:40"), "Speaker 0", "Did you see the game last night?"],
  [at("13T20:41:00"), "Speaker 1", "Yeah, what a finish. My kids stayed up for it."],
];

// Saturday (no events): an unscheduled SD-334-A visit.
const SATURDAY: Line[] = [
  [at("14T18:00:00"), "Speaker 0", "Can you find the amount due on this phone bill?"],
  [at("14T18:00:20"), "Speaker 1", "The amount due is thirty two dollars."],
  [at("14T18:00:40"), "Speaker 0", "And when is the due date?"],
  [at("14T18:01:00"), "Speaker 1", "The due date is next Friday."],
  [at("14T18:01:20"), "Speaker 0", "Let's track that in the budget sheet."],
  [at("14T18:01:40"), "Speaker 1", "I added it to my weekly spending."],
];

async function detail(hh: V3Harness, id: string) {
  const r = await hh.req(`/api/recordings/${id}`, { cookie: await hh.login() });
  expect(r.status, r.text).toBe(200);
  return r.json.data;
}

describe("content suggestions (pass 2)", () => {
  it("overran back-to-back visit → suggests the right client + its event; accept assigns, hands off, labels evidence", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_overran", OVERRAN);
    const d = await detail(hh, "rec_overran");
    // Pass 1: the in-slot lines went to fri3 by time; the overrun is unassigned.
    expect(d.recording.partition.sessions.map((s: any) => [s.eventId, s.segmentCount])).toEqual([[FRI3, 2]]);
    expect(d.recording.partition.unassignedSegments).toBe(6);
    expect(d.suggestions).toHaveLength(1);
    const s = d.suggestions[0];
    expect(s).toMatchObject({
      recordingId: "rec_overran",
      segmentIndexes: [3, 4, 5, 6, 7, 8],
      suggestedClientRef: "SD-334-A",
      eventId: FRI3,
      kind: "event",
      method: "rules",
      status: "pending",
      acceptedClientRef: null,
      sessionId: null,
    });
    expect(s.id).toMatch(/^sug_[0-9a-f]{24}$/);
    expect(s.confidence).toBeGreaterThanOrEqual(0.6);
    expect(s.candidateClientRefs).toEqual(expect.arrayContaining(["C-104", "SD-334-A", "SD-320-A"]));
    expect(s.rationale.length).toBeLessThanOrEqual(200);
    expect(s.rationale).toMatch(/bill/);
    expect(s.rationale).not.toMatch(/Jordan|forty|twentieth/i); // no transcript text, no names
    expect(s.conversation).toMatchObject({ conversationType: "client_session", needsConfirmation: false });
    expect(s.conversation.signals.eventTitleHint).toBeNull(); // "Money-management training" is a client service, not a meeting
    // Nothing assigned automatically.
    expect(d.segments.filter((x: any) => x.assignment.status === "assigned").map((x: any) => x.index)).toEqual([1, 2]);
    // Session conversation for fri3.
    expect(d.sessionConversations).toEqual([expect.objectContaining({ eventId: FRI3, segmentCount: 2, needsConfirmation: false })]);

    const sid = d.recording.partition.sessions[0].sessionId;
    const acc = await hh.req(`/api/recordings/rec_overran/suggestions/${s.id}/accept`, { method: "POST", cookie: await hh.login(), body: {} });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.json.data.sessionId).toBe(sid); // same session as the event's pass 1 lines
    expect(acc.json.data.suggestion).toMatchObject({ status: "accepted", acceptedClientRef: "SD-334-A", appointmentId: `appt_cal_${FRI3}`, sessionId: sid });
    await hh.settle();
    const d2 = await detail(hh, "rec_overran");
    expect(d2.recording.partition.sessions).toEqual([expect.objectContaining({ eventId: FRI3, segmentCount: 8 })]);
    expect(d2.recording.partition.unassignedSegments).toBe(0);
    expect(d2.segments[2].assignment).toMatchObject({ status: "assigned", eventId: FRI3, method: "provider_confirmed_content" });
    expect(d2.segments[0].assignment).toMatchObject({ status: "assigned", method: "calendar_time" });
    const sess = (await hh.req(`/api/sessions/${sid}`, { cookie: await hh.login() })).json.data;
    expect(sess.bundle.evidence).toHaveLength(8);
    expect(sess.bundle.provenance.evidenceWarnings).toContain("6 lines assigned by provider from content suggestion.");

    // Deciding twice → 409; re-partitioning keeps the provider's assignment and adds no suggestion.
    expect((await hh.req(`/api/recordings/rec_overran/suggestions/${s.id}/accept`, { method: "POST", cookie: await hh.login(), body: {} })).status).toBe(409);
    await hh.queue.send({ kind: "partition_recording", recordingId: "rec_overran", providerId: PROVIDER } as any);
    await hh.settle();
    const d3 = await detail(hh, "rec_overran");
    expect(d3.segments.filter((x: any) => x.assignment.method === "provider_confirmed_content")).toHaveLength(6);
    expect(d3.suggestions).toHaveLength(1);
    expect(d3.recording.partition.sessions[0].segmentCount).toBe(8);
  });

  it("talk between appointments with no match → none (kind unscheduled, no client); reject; accept without a client → 400", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_talk", SMALL_TALK);
    const d = await detail(hh, "rec_talk");
    expect(d.recording.partition.sessions).toEqual([]);
    expect(d.suggestions).toHaveLength(1);
    const s = d.suggestions[0];
    expect(s).toMatchObject({ suggestedClientRef: null, eventId: null, kind: "unscheduled", method: "rules", status: "pending" });
    expect(s.rationale).toMatch(/^No goal\/plan terms/);
    expect(s.conversation.conversationType).toBe("personal");
    const cookie = await hh.login();
    expect((await hh.req(`/api/recordings/rec_talk/suggestions/${s.id}/accept`, { method: "POST", cookie, body: {} })).json.error.code).toBe("CLIENT_REQUIRED");
    expect((await hh.req(`/api/recordings/rec_talk/suggestions/${s.id}/accept`, { method: "POST", cookie, body: { clientRef: "C-104", providerId: "x" } })).status).toBe(400); // strict
    const rej = await hh.req(`/api/recordings/rec_talk/suggestions/${s.id}/reject`, { method: "POST", cookie });
    expect(rej.status, rej.text).toBe(200);
    expect(rej.json.data.suggestion).toMatchObject({ status: "rejected", acceptedClientRef: null });
    expect((await hh.req(`/api/recordings/rec_talk/suggestions/${s.id}/reject`, { method: "POST", cookie })).status).toBe(409);
    expect((await hh.req(`/api/recordings/rec_talk/suggestions/sug_nope/reject`, { method: "POST", cookie })).status).toBe(404);
  });

  it("unscheduled visit about SD-334-A goals → kind unscheduled; accept creates appt_cal_unsched_… + session; unknown client / other provider rejected", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_sat", SATURDAY);
    const d = await detail(hh, "rec_sat");
    expect(d.recording.partition.sessions).toEqual([]);
    const s = d.suggestions[0];
    expect(s).toMatchObject({ suggestedClientRef: "SD-334-A", eventId: null, kind: "unscheduled", segmentIndexes: [1, 2, 3, 4, 5, 6] });
    expect(s.rationale).toMatch(/unscheduled/);
    // Unknown client override → 400.
    const cookie = await hh.login();
    expect((await hh.req(`/api/recordings/rec_sat/suggestions/${s.id}/accept`, { method: "POST", cookie, body: { clientRef: "ZZ-999" } })).json.error.code).toBe("UNKNOWN_CLIENT");
    // Another provider's recording → 404 (ownership).
    await hh.db.prepare(`UPDATE recordings SET provider_id = 'provider_other' WHERE id = 'rec_sat'`).run();
    expect((await hh.req(`/api/recordings/rec_sat/suggestions/${s.id}/accept`, { method: "POST", cookie, body: {} })).status).toBe(404);
    await hh.db.prepare(`UPDATE recordings SET provider_id = ? WHERE id = 'rec_sat'`).bind(PROVIDER).run();

    const acc = await hh.req(`/api/recordings/rec_sat/suggestions/${s.id}/accept`, { method: "POST", cookie, body: {} });
    expect(acc.status, acc.text).toBe(200);
    const apptId = acc.json.data.suggestion.appointmentId as string;
    expect(apptId).toMatch(/^appt_cal_unsched_[0-9a-f]{12}_1_sd_334_a$/);
    const appt = await hh.repo.getAppointment(apptId);
    expect(appt).toMatchObject({ clientRef: "SD-334-A", serviceCode: "CA-SDP-334", startAt: SATURDAY[0]![0], timezone: "America/Los_Angeles", canceled: false });
    expect(acc.json.data.sessionId).toBe(await sessionIdFor(PROVIDER, appt!.occurrenceId));
    await hh.settle();
    const sess = (await hh.req(`/api/sessions/${acc.json.data.sessionId}`, { cookie })).json.data;
    expect(sess.session.status).toBe("NEEDS_REVIEW");
    expect(sess.bundle.evidence).toHaveLength(6);
    expect(sess.bundle.provenance.evidenceWarnings).toContain("6 lines assigned by provider from content suggestion.");
    const d2 = await detail(hh, "rec_sat");
    expect(d2.recording.partition.sessions).toEqual([expect.objectContaining({ clientRef: "SD-334-A", segmentCount: 6, sessionId: acc.json.data.sessionId })]);
    expect(d2.sessionConversations[0]).toMatchObject({ appointmentId: apptId, conversationType: "client_session" });
  });

  it("AI: a non-candidate pick is ignored (rules only); an agreeing pick → ai+rules; the outbound body carries no names", async () => {
    const bad = fakeAi((req) => (req.tool.name === "pick_client" ? { clientRef: "ZZ-999", confidence: 0.99, rationale: "x", citedSegmentIndexes: [3] } : { conversationType: "client_session", confidence: 0.9 }));
    const one = await setup({ ai: bad.ai });
    h = one.hh;
    await record(one.hh, one.store, "rec_ai_bad", OVERRAN);
    const s1 = (await detail(one.hh, "rec_ai_bad")).suggestions[0];
    expect(s1).toMatchObject({ suggestedClientRef: "SD-334-A", method: "rules" });
    await one.hh.dispose();

    const good = fakeAi((req) =>
      req.tool.name === "pick_client" ? { clientRef: "SD-334-A", confidence: 0.9, rationale: "Bill and budget sheet work in 3-8.", citedSegmentIndexes: [3, 4, 8] } : { conversationType: "client_session", confidence: 0.9 },
    );
    const two = await setup({ ai: good.ai });
    h = two.hh;
    await record(two.hh, two.store, "rec_ai_good", OVERRAN);
    const s2 = (await detail(two.hh, "rec_ai_good")).suggestions[0];
    expect(s2).toMatchObject({ suggestedClientRef: "SD-334-A", method: "ai+rules" });
    expect(s2.confidence).toBeGreaterThan(0.85);
    expect(s2.rationale).toMatch(/AI agreed \(0\.9, cited 3-4,8\)/);
    // Privacy: only scrubbed lines + {clientRef, goals}; no participant / client names anywhere.
    const pick = good.sent.find((r) => r.tool.name === "pick_client")!;
    const body = JSON.stringify(good.sent);
    expect(body).not.toMatch(/Jordan|Mendez|Sampleton|Sam Rivera|Robin|Castillo|Testwell/);
    expect(pick.user).toMatch(/\[NAME_1\]/);
    const payload = JSON.parse(pick.user);
    expect(payload.candidates.map((c: any) => Object.keys(c).sort())).toEqual(payload.candidates.map(() => ["clientRef", "goals"]));
    expect(payload.block.map((b: any) => b.i)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("the provider overrides the client (and may name an event); event/client mismatch → 400", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_ovr", SMALL_TALK);
    const s = (await detail(hh, "rec_ovr")).suggestions[0];
    const cookie = await hh.login();
    expect((await hh.req(`/api/recordings/rec_ovr/suggestions/${s.id}/accept`, { method: "POST", cookie, body: { clientRef: "C-104", eventId: FRI3 } })).json.error.code).toBe("EVENT_CLIENT_MISMATCH");
    const acc = await hh.req(`/api/recordings/rec_ovr/suggestions/${s.id}/accept`, { method: "POST", cookie, body: { eventId: FRI3 } });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.json.data.suggestion).toMatchObject({ status: "accepted", acceptedClientRef: "SD-334-A", appointmentId: `appt_cal_${FRI3}` });
    expect(acc.json.data.sessionId).toBe(await sessionIdFor(PROVIDER, FRI3));
  });

  it("AI output validation is strict", () => {
    const refs = ["C-104", "SD-334-A"];
    const ok = { clientRef: "SD-334-A", confidence: 0.7, rationale: "segs 3,4", citedSegmentIndexes: [3, 4] };
    expect(validateAiOutput(ok, refs, [3, 4, 5])).toEqual({ clientRef: "SD-334-A", confidence: 0.7, citedSegmentIndexes: [3, 4] });
    expect(validateAiOutput({ ...ok, clientRef: "none", citedSegmentIndexes: [] }, refs, [3])).toMatchObject({ clientRef: null });
    expect(validateAiOutput({ ...ok, clientRef: "ZZ-1" }, refs, [3, 4])).toBeNull(); // not a candidate
    expect(validateAiOutput({ ...ok, citedSegmentIndexes: [9] }, refs, [3, 4])).toBeNull(); // index outside the block
    expect(validateAiOutput({ ...ok, citedSegmentIndexes: [] }, refs, [3, 4])).toBeNull(); // a pick must cite
    expect(validateAiOutput({ ...ok, confidence: 1.5 }, refs, [3, 4])).toBeNull();
    expect(validateAiOutput({ ...ok, rationale: "x".repeat(201) }, refs, [3, 4])).toBeNull();
    expect(validateAiOutput({ ...ok, extra: 1 }, refs, [3, 4])).toBeNull();
    expect(validateAiOutput("SD-334-A", refs, [3])).toBeNull();
    expect(validateConversationOutput({ conversationType: "colleague_meeting", confidence: 0.8 })).toEqual({ conversationType: "colleague_meeting", confidence: 0.8 });
    expect(validateConversationOutput({ conversationType: "meeting", confidence: 0.8 })).toBeNull();
    expect(validateConversationOutput({ conversationType: "personal", confidence: 0.8, why: "x" })).toBeNull();
  });

  it("boundaries: silence > 90 s splits; tiny blocks merge into neighbours", () => {
    const seg = (i: number, t: string, text = "budget sheet spending bill") => ({ index: i, observedFrom: at(t), observedTo: new Date(Date.parse(at(t)) + 8000).toISOString(), speaker: "Speaker 0", text });
    const blocks = detectBlocks([seg(1, "13T20:00:00"), seg(2, "13T20:00:20"), seg(3, "13T20:00:40"), seg(4, "13T20:05:00"), seg(5, "13T20:05:20"), seg(6, "13T20:05:40")]);
    expect(blocks.map((b) => b.segments.map((s) => s.index))).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(blocks[1]!.before).toBe("hard");
    // A lone segment 3 min later merges into the previous block (gap ≤ 10 min).
    const tiny = detectBlocks([seg(1, "13T20:00:00"), seg(2, "13T20:00:20"), seg(3, "13T20:00:40"), seg(4, "13T20:03:40")]);
    expect(tiny.map((b) => b.segments.map((s) => s.index))).toEqual([[1, 2, 3, 4]]);
  });

  it("sweep: a pending suggestion with a client keeps the text up to 7 days; none / rejected → 24 h", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_keep", SATURDAY);
    await record(hh, store, "rec_none", SMALL_TALK.map(([t, s, x]) => [t.replace("13T20", "14T21"), s, x] as Line));
    const sweep = () => sweepRecordings({ store, clock: hh.clock, enqueuePartition: async () => undefined });
    hh.clock.advance(24 * 3600_000 + 1000);
    expect((await sweep()).textDeleted).toBe(4); // rec_none ("none" suggestion): normal 24 h
    const keep = await detail(hh, "rec_keep");
    expect(keep.segments.every((x: any) => x.text !== null)).toBe(true);
    hh.clock.advance(3 * 24 * 3600_000);
    expect((await sweep()).textDeleted).toBe(0);
    hh.clock.advance(3 * 24 * 3600_000 + 2000); // > 7 days after partitioning
    expect((await sweep()).textDeleted).toBe(6);
  });

  it("sweep: a rejected suggestion's text follows the normal 24 h", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_rej", SATURDAY);
    const s = (await detail(hh, "rec_rej")).suggestions[0];
    expect((await hh.req(`/api/recordings/rec_rej/suggestions/${s.id}/reject`, { method: "POST", cookie: await hh.login() })).status).toBe(200);
    hh.clock.advance(24 * 3600_000 + 1000);
    expect((await sweepRecordings({ store, clock: hh.clock, enqueuePartition: async () => undefined })).textDeleted).toBe(6);
  });
});

describe("conversation type", () => {
  it("a colleague meeting inside a client slot → session still created, flagged for confirmation; confirm clears it", async () => {
    const { hh, store } = await setup();
    h = hh;
    await record(hh, store, "rec_meeting", [
      [at("13T18:10:00"), "Speaker 0", "Let's go over the caseload and billing for this week."],
      [at("13T18:10:20"), "Speaker 1", "SD-320-A needs coverage on Monday, can you take it?"],
      [at("13T18:10:40"), "Speaker 0", "Did the supervisor approve the timesheets?"],
      [at("13T18:11:00"), "Speaker 1", "Yes, and the invoices go out with the staff meeting notes."],
    ]);
    const d = await detail(hh, "rec_meeting");
    expect(d.recording.partition.sessions.map((s: any) => s.eventId)).toEqual([FRI2]); // never auto-dismissed
    const conv = d.sessionConversations[0];
    expect(conv).toMatchObject({ eventId: FRI2, conversationType: "colleague_meeting", needsConfirmation: true, providerDecision: null });
    expect(conv.confidence).toBeGreaterThanOrEqual(0.6);
    expect(conv.signals).toMatchObject({ speakers: 2, otherClientRefs: 1, participantVoice: false });
    expect(JSON.stringify(conv.signals)).not.toMatch(/SD-320-A|caseload/);

    const resolve = visitContextResolver({ store, calendar: new DemoCalendarSource({ clock: hh.clock }), drive: new DemoDriveSource() });
    const appt = (await hh.repo.getAppointment(`appt_cal_${FRI2}`))!;
    expect(await resolve(appt)).toMatchObject({ conversationType: "colleague_meeting", conversationLabel: "colleague meeting", conversationNeedsConfirmation: true, conversationDecision: null });

    const cookie = await hh.login();
    expect((await hh.req(`/api/recordings/rec_meeting/sessions/${FRI2}/conversation`, { method: "POST", cookie, body: { decision: "maybe" } })).status).toBe(400);
    const ok = await hh.req(`/api/recordings/rec_meeting/sessions/${FRI2}/conversation`, { method: "POST", cookie, body: { decision: "client_session" } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.data.conversation).toMatchObject({ conversationType: "client_session", needsConfirmation: false, providerDecision: "client_session" });
    expect(await resolve(appt)).toMatchObject({ conversationType: "client_session", conversationNeedsConfirmation: false, conversationDecision: "client_session" });
    await hh.settle();
  });
});
