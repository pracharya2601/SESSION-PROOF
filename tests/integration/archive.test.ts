/**
 * Archive / delete (src/archive, src/api/archive.ts, migrations/0013_archive.sql) over the v3
 * harness + Miniflare D1, with the recordings partitioner wired as in src/index.ts (calendar pass
 * wrapped by withDismissedEvents).
 *
 * Demo calendar: Thu 2026-11-12 thu2 SD-331-A 19:00–21:00Z. Harness clock: 2026-11-13T20:00:00Z.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createVisitStore } from "../../src/band/store";
import { BandEvidenceSource, VisitRoutingEvidenceSource } from "../../src/band/evidence";
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
import { withDismissedEvents } from "../../src/archive";
import { sessionIdFor, type BandSegment } from "../../src/contracts";

const PROVIDER = "provider_demo_001";
const Z = (s: string) => `2026-11-${s}:00.000Z`;
const THU2 = "demo_sd_331_a_20261112_thu2";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function setup() {
  const hh = await createV3Harness();
  const anyH = hh as any;
  const visits = createVisitStore(hh.db);
  const store = createRecordingStore(hh.db);
  const calendar = new DemoCalendarSource({ clock: hh.clock });
  const drive = new DemoDriveSource();
  const enqueue = (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt);
  anyH.apiDeps.visits = { store: visits, enqueueAppointment: enqueue };
  anyH.apiDeps.recordings = { store, calendar };
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
    resolveVisitContext: visitContextResolver({ store, calendar }),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(wfDeps, params, step);
  // Mirrors src/index.ts partitionDeps.
  const syncCalendar = withDismissedEvents(
    hh.db,
    calendarSync({
      calendar,
      sync: (providerId, from, to) => syncCalendarToAppointments(hh.repo, calendar, providerId, from, to, { now: hh.clock.now() }),
      appointmentIdForEvent,
      getAppointment: (id) => hh.repo.getAppointment(id),
    }),
  );
  const partitionDeps = (): PartitionDeps => ({ store, repo: hh.repo, queue: hh.queue as any, clock: hh.clock, syncCalendar, enqueueAppointment: enqueue });
  (hh.jobs as any).partitionRecording = (job: any, attempt: number) => runPartition(partitionDeps(), job, attempt);
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, store, cookie };
}

/** A stopped recording with exact segments. `createdAt` defaults to its start. */
async function makeRecording(store: RecordingStore, o: { id: string; from: string; to: string; segs: [string, number, string][]; createdAt?: string; providerId?: string }) {
  const providerId = o.providerId ?? PROVIDER;
  await store.create({ id: o.id, providerId, deviceId: null, bandNumber: 7, transport: "ble", transcriber: "simulated", startedAt: o.from, timezone: null, scenario: null, now: o.createdAt ?? o.from });
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
  await store.stop(providerId, o.id, o.to);
}

async function partition(hh: V3Harness, recordingId: string, providerId = PROVIDER) {
  await hh.queue.send({ kind: "partition_recording", recordingId, providerId } as any);
  await hh.settle();
}

async function count(hh: V3Harness, sql: string, ...binds: unknown[]): Promise<number> {
  return Number((await hh.db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);
}

async function legacySession(hh: V3Harness, cookie: string): Promise<string> {
  await hh.req("/api/sync", { method: "POST", cookie });
  await hh.settle();
  const list = (await hh.req("/api/sessions", { cookie })).json.data.sessions;
  expect(list.length).toBeGreaterThan(0);
  return list[0].id as string;
}

describe("archive", { timeout: 60_000 }, () => {
  it("archive hides sessions / runs / recordings from lists; Show archived; unarchive restores; scoped", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    const sid = await legacySession(hh, cookie);
    const runsBefore = (await hh.req("/api/runs", { cookie })).json.data.runs.filter((r: any) => r.sessionId === sid);
    expect(runsBefore.length).toBeGreaterThan(0);

    const a = await hh.req(`/api/archive/session/${sid}`, { method: "POST", cookie, body: { reason: "duplicate" } });
    expect(a.status, a.text).toBe(200);
    expect(a.json.data.item).toMatchObject({ kind: "session", id: sid, archivedBy: PROVIDER, reason: "duplicate" });
    // Idempotent: archiving again keeps the first row.
    expect((await hh.req(`/api/archive/session/${sid}`, { method: "POST", cookie })).json.data.item.archivedAt).toBe(a.json.data.item.archivedAt);

    expect((await hh.req("/api/sessions", { cookie })).json.data.sessions.map((s: any) => s.id)).not.toContain(sid);
    expect((await hh.req("/api/sessions?includeArchived=1", { cookie })).json.data.sessions.map((s: any) => s.id)).toContain(sid);
    expect((await hh.req("/api/runs", { cookie })).json.data.runs.filter((r: any) => r.sessionId === sid)).toEqual([]);
    expect((await hh.req("/api/runs?includeArchived=1", { cookie })).json.data.runs.filter((r: any) => r.sessionId === sid).length).toBe(runsBefore.length);
    expect((await hh.req(`/api/sessions/${sid}`, { cookie })).status).toBe(200); // still readable by id
    expect((await hh.req("/api/archive?kind=session", { cookie })).json.data.items.map((i: any) => i.id)).toEqual([sid]);

    // A single run archived on its own.
    const runId = runsBefore[0].runId;
    expect((await hh.req(`/api/archive/session/${sid}`, { method: "DELETE", cookie })).json.data).toEqual({ unarchived: true });
    expect((await hh.req(`/api/archive/run/${encodeURIComponent(runId)}`, { method: "POST", cookie })).status).toBe(200);
    expect((await hh.req("/api/runs", { cookie })).json.data.runs.map((r: any) => r.runId)).not.toContain(runId);
    expect((await hh.req(`/api/runs/${encodeURIComponent(runId)}`, { cookie })).status).toBe(200);
    expect((await hh.req(`/api/archive/run/${encodeURIComponent(runId)}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await hh.req("/api/runs", { cookie })).json.data.runs.map((r: any) => r.runId)).toContain(runId);
    expect((await hh.req("/api/sessions", { cookie })).json.data.sessions.map((s: any) => s.id)).toContain(sid);

    // Recordings.
    await makeRecording(store, { id: "rec_arch", from: Z("12T19:00"), to: Z("12T19:30"), segs: [[Z("12T19:10"), 5, "Budget talk."]] });
    expect((await hh.req(`/api/archive/recording/rec_arch`, { method: "POST", cookie })).status).toBe(200);
    expect((await hh.req("/api/recordings", { cookie })).json.data.map((r: any) => r.id)).not.toContain("rec_arch");
    const arch = (await hh.req("/api/archive?kind=recording", { cookie })).json.data.items;
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatchObject({ kind: "recording", id: "rec_arch", recording: { id: "rec_arch", segmentCount: 1 } });
    expect((await hh.req(`/api/recordings/rec_arch`, { cookie })).status).toBe(200);

    // Bad kind, unknown id, another provider: 404 / 400.
    expect((await hh.req(`/api/archive/nope/${sid}`, { method: "POST", cookie })).status).toBe(404);
    expect((await hh.req(`/api/archive/session/sess_missing`, { method: "POST", cookie })).status).toBe(404);
    expect((await hh.req(`/api/archive?kind=nope`, { cookie })).status).toBe(400);
    expect((await hh.req(`/api/archive/session/${sid}`, { method: "POST", cookie, body: { reason: "x", providerId: "p" } })).status).toBe(400);
    const other = await hh.login("other.provider@example.invalid");
    expect((await hh.req(`/api/archive/session/${sid}`, { method: "POST", cookie: other })).status).toBe(404);
    expect((await hh.req(`/api/archive/recording/rec_arch`, { method: "DELETE", cookie: other })).status).toBe(404);
    expect((await hh.req(`/api/archive?kind=recording`, { cookie: other })).json.data.items).toEqual([]);
    expect((await hh.req(`/api/archive/recording/rec_arch`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await hh.req("/api/recordings", { cookie })).json.data.map((r: any) => r.id)).toContain("rec_arch");

    // Audit: archive / unarchive rows, ids only.
    const audit = (await hh.req("/api/audit", { cookie })).json.data.entries;
    expect(audit.map((e: any) => `${e.action}:${e.itemKind}`).sort()).toEqual(
      ["archive:recording", "archive:run", "archive:session", "unarchive:recording", "unarchive:run", "unarchive:session"].sort(),
    );
    expect(JSON.stringify(audit)).not.toMatch(/Budget talk|duplicate/);
    expect((await hh.req("/api/audit", { cookie: other })).json.data.entries).toEqual([]);
  });
});

describe("delete", { timeout: 60_000 }, () => {
  it("session: approved → 409 ARCHIVE_ONLY; busy → 409; draft → gone with its rows; discovery does not recreate it; audit", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const sid = await legacySession(hh, cookie);
    const rec = (await hh.repo.getSession(sid))!;

    await hh.db.prepare(`UPDATE sessions SET status = 'COMPLETED' WHERE id = ?`).bind(sid).run();
    const locked = await hh.req(`/api/sessions/${sid}`, { method: "DELETE", cookie });
    expect(locked.status).toBe(409);
    expect(locked.json.error.code).toBe("ARCHIVE_ONLY");
    await hh.db.prepare(`UPDATE sessions SET status = 'QUEUED' WHERE id = ?`).bind(sid).run();
    expect((await hh.req(`/api/sessions/${sid}`, { method: "DELETE", cookie })).json.error.code).toBe("SESSION_BUSY");
    await hh.db.prepare(`UPDATE sessions SET status = 'NEEDS_REVIEW' WHERE id = ?`).bind(sid).run();

    // Another provider: 404, nothing removed.
    const other = await hh.login("other.provider@example.invalid");
    expect((await hh.req(`/api/sessions/${sid}`, { method: "DELETE", cookie: other })).status).toBe(404);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM bundles WHERE session_id = ?`, sid)).toBeGreaterThan(0);
    // Seed a review link + notification for the session (as the approval hand-off would).
    await hh.db
      .prepare(`INSERT INTO review_links (id, provider_id, session_id, token_hash, created_at, expires_at) VALUES ('rl_t', ?, ?, 'h', ?, ?)`)
      .bind(PROVIDER, sid, Z("13T20:00"), Z("20T20:00"))
      .run();
    await hh.db
      .prepare(`INSERT INTO notifications (id, provider_id, kind, session_id, client_ref, title, dedupe_key, created_at) VALUES ('n_t', ?, 'ready', ?, 'C-104', 't', 'dk_t', ?)`)
      .bind(PROVIDER, sid, Z("13T20:00"))
      .run();

    const del = await hh.req(`/api/sessions/${sid}`, { method: "DELETE", cookie });
    expect(del.status, del.text).toBe(200);
    expect(del.json.data).toEqual({ deleted: true, kind: "session", id: sid });
    expect((await hh.req(`/api/sessions/${sid}`, { cookie })).status).toBe(404);
    for (const t of ["bundles", "evidence", "pending_deliveries"]) expect(await count(hh, `SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`, sid)).toBe(0);
    for (const t of ["run_events", "review_links", "notifications"]) expect(await count(hh, `SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`, sid)).toBe(0);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM dismissed_events WHERE event_id = ? AND last_processing_revision = ?`, rec.occurrenceId, rec.processingRevision)).toBe(1);

    // Discovery skips the dismissed appointment.
    await hh.req("/api/sync", { method: "POST", cookie });
    await hh.settle();
    expect(await hh.repo.getSession(sid)).toBeNull();

    const audit = (await hh.req("/api/audit", { cookie })).json.data.entries;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "delete", itemKind: "session", itemId: sid, actor: PROVIDER, detail: { status: "NEEDS_REVIEW" } });
    expect(audit[0].detail.runEvents).toBeGreaterThan(0);
  });

  it("session from a recording: delete unassigns its segments, the event is dismissed (re-partition skips it); a newer recording recreates it with a fresh revision", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    await makeRecording(store, { id: "rec_a", from: Z("12T19:00"), to: Z("12T19:30"), segs: [[Z("12T19:10"), 5, "First half."], [Z("12T19:20"), 5, "Second bit."]] });
    await partition(hh, "rec_a");
    const sid = await sessionIdFor(PROVIDER, THU2);
    expect((await hh.repo.getSession(sid))!.status).toBe("NEEDS_REVIEW");
    const revBefore = (await hh.repo.getSession(sid))!.processingRevision;

    expect((await hh.req(`/api/sessions/${sid}`, { method: "DELETE", cookie })).status).toBe(200);
    const after = (await store.get(PROVIDER, "rec_a"))!.recording;
    expect(after.partition).toMatchObject({ sessions: [], unassignedSegments: 2, unassignedMs: 10_000 });
    const web = (await hh.req(`/api/recordings/rec_a`, { cookie })).json.data;
    expect(web.segments.map((s: any) => s.assignment.status)).toEqual(["unassigned", "unassigned"]);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM recording_sessions WHERE session_id = ?`, sid)).toBe(0);

    // Re-partitioning the same recording: pass 1 skips the dismissed event, no session.
    await partition(hh, "rec_a");
    expect(await hh.repo.getSession(sid)).toBeNull();
    expect((await store.get(PROVIDER, "rec_a"))!.recording.partition).toMatchObject({ sessions: [], unassignedSegments: 2 });

    // A NEW recording (created after the delete) covering the event lifts it.
    hh.clock.advance(60_000);
    await makeRecording(store, {
      id: "rec_b",
      from: Z("12T20:00"),
      to: Z("12T20:30"),
      createdAt: hh.clock.now().toISOString(),
      segs: [[Z("12T20:10"), 5, "Back for more."]],
    });
    await partition(hh, "rec_b");
    const re = (await hh.repo.getSession(sid))!;
    expect(re.status).toBe("NEEDS_REVIEW");
    expect(re.processingRevision).toBeGreaterThan(revBefore); // workflow ids are never reused
    const d = (await hh.req(`/api/sessions/${sid}`, { cookie })).json.data;
    expect(d.bundle.evidence.map((e: any) => e.excerpt)).toEqual(["Back for more."]);
  });

  it("recording: text, assignments and pending suggestions removed; sessions keep frozen evidence; scoped; audit", async () => {
    const { hh, store, cookie } = await setup();
    h = hh;
    await makeRecording(store, { id: "rec_del", from: Z("12T19:00"), to: Z("12T19:30"), segs: [[Z("12T19:10"), 5, "Keep me in the note."], [Z("12T19:20"), 5, "Also kept."]] });
    await partition(hh, "rec_del");
    const sid = await sessionIdFor(PROVIDER, THU2);
    // Content suggestions (migration 0014): the pending one goes, a decided one stays (ids only).
    const sug = (id: string, status: string) =>
      hh.db
        .prepare(
          `INSERT INTO recording_assignment_suggestions (id, recording_id, provider_id, segment_indexes, observed_from, observed_to,
             suggested_client_ref, event_id, kind, confidence, method, rationale, status, created_at)
           VALUES (?, 'rec_del', ?, '[2]', ?, ?, 'C-104', NULL, 'unscheduled', 0.7, 'rules', 'r', ?, ?)`,
        )
        .bind(id, PROVIDER, Z("12T19:20"), Z("12T19:21"), status, Z("13T20:00"));
    await hh.db.batch([sug("sg_p", "pending"), sug("sg_a", "accepted")]);

    // Running recordings cannot be deleted.
    await store.create({ id: "rec_live", providerId: PROVIDER, deviceId: null, bandNumber: 1, transport: "ble", transcriber: "simulated", startedAt: Z("13T19:00"), timezone: null, scenario: null, now: Z("13T19:00") });
    expect((await hh.req(`/api/recordings/rec_live`, { method: "DELETE", cookie })).json.error.code).toBe("RECORDING_ACTIVE");

    const other = await hh.login("other.provider@example.invalid");
    expect((await hh.req(`/api/recordings/rec_del`, { method: "DELETE", cookie: other })).status).toBe(404);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM band_segments WHERE visit_id = 'rec_del'`)).toBe(2);

    const del = await hh.req(`/api/recordings/rec_del`, { method: "DELETE", cookie });
    expect(del.status, del.text).toBe(200);
    expect((await hh.req(`/api/recordings/rec_del`, { cookie })).status).toBe(404);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM band_segments WHERE visit_id = 'rec_del'`)).toBe(0);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM recording_segment_assignments WHERE recording_id = 'rec_del'`)).toBe(0);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM recording_sessions WHERE recording_id = 'rec_del'`)).toBe(0);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM recording_assignment_suggestions WHERE recording_id = 'rec_del' AND status = 'pending'`)).toBe(0);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM recording_assignment_suggestions WHERE recording_id = 'rec_del'`)).toBe(1);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM recording_conversations WHERE recording_id = 'rec_del'`)).toBe(0);
    // The session built from it keeps its frozen evidence.
    const d = (await hh.req(`/api/sessions/${sid}`, { cookie })).json.data;
    expect(d.bundle.evidence.map((e: any) => e.excerpt)).toEqual(["Keep me in the note.", "Also kept."]);

    const audit = (await hh.req("/api/audit", { cookie })).json.data.entries;
    expect(audit).toEqual([expect.objectContaining({ action: "delete", itemKind: "recording", itemId: "rec_del", detail: { segments: 2, assignments: 2, sessionsKept: 1 } })]);
    expect(JSON.stringify(audit)).not.toMatch(/Keep me/);
  });

  it("run: processing run of a live session → 409 ARCHIVE_ONLY; delivery run or orphaned run → deleted", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const sid = await legacySession(hh, cookie);
    const runs = (await hh.req("/api/runs", { cookie })).json.data.runs;
    const proc = runs.find((r: any) => r.sessionId === sid && r.runKind === "processing");
    expect(proc).toBeTruthy();
    const r409 = await hh.req(`/api/runs/${encodeURIComponent(proc.runId)}`, { method: "DELETE", cookie });
    expect(r409.status).toBe(409);
    expect(r409.json.error.code).toBe("ARCHIVE_ONLY");

    const ev = (runId: string, sessionId: string, runKind: "processing" | "delivery") => ({
      id: `${runId}:files:succeeded`, runId, runKind, sessionId, providerId: PROVIDER, stage: "files" as const, status: "succeeded" as const,
      label: "x", detail: null, meta: {}, at: Z("13T19:59"),
    });
    await hh.repo.appendRunEvent(ev("dlv-1", sid, "delivery"));
    await hh.repo.appendRunEvent(ev("wf-gone-r1", "sess_gone", "processing"));
    const other = await hh.login("other.provider@example.invalid");
    expect((await hh.req(`/api/runs/dlv-1`, { method: "DELETE", cookie: other })).status).toBe(404);
    expect((await hh.req(`/api/runs/dlv-1`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await hh.req(`/api/runs/wf-gone-r1`, { method: "DELETE", cookie })).status).toBe(200);
    expect(await count(hh, `SELECT COUNT(*) AS n FROM run_events WHERE run_id IN ('dlv-1', 'wf-gone-r1')`)).toBe(0);
    expect((await hh.req(`/api/runs/dlv-1`, { method: "DELETE", cookie })).status).toBe(404);
    const audit = (await hh.req("/api/audit", { cookie })).json.data.entries;
    expect(audit.map((e: any) => e.itemId).sort()).toEqual(["dlv-1", "wf-gone-r1"]);
  });
});
