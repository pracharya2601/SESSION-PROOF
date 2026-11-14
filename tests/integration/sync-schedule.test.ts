/**
 * Provider-controlled sync schedule: real D1 (Miniflare), real repository,
 * jobs and API. The fixed heartbeat only runs discovery for providers whose
 * own interval is due; delivery recovery is independent of the settings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PROVIDER_ID, OTHER_PROVIDER_ID, demoAppointment } from "../../fixtures/scenario";
import { runScheduledSync, type JobDeps } from "../../src/jobs";
import { seedDemoData } from "../../src/calendar/seed";
import { createHarness, type Harness } from "../e2e/harness";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

function deps(hh: Harness): JobDeps {
  return { repo: hh.repo, workflow: hh.workflow as never, queue: hh.queue as never, clock: hh.clock };
}

describe("user-controlled sync schedule", () => {
  it("defaults to enabled / 15 min / 7 days for a provider with no saved settings", async () => {
    h = await createHarness();
    await seedDemoData(h.repo);
    const s = await h.repo.getSyncSettings(DEMO_PROVIDER_ID);
    expect(s).toEqual({ settings: { enabled: true, intervalMinutes: 15, lookbackDays: 7 }, lastRunAt: null });
  });

  it("heartbeat runs a never-run provider, then waits for its interval", async () => {
    h = await createHarness();
    await seedDemoData(h.repo);
    await h.repo.saveSyncSettings(DEMO_PROVIDER_ID, { enabled: true, intervalMinutes: 30, lookbackDays: 7 }, h.clock.now());

    const first = await runScheduledSync(deps(h));
    expect(first.enqueued).toBe(1);
    expect(h.queue.sent).toHaveLength(1);

    // 5 minutes later: demo provider is not due (30 min interval).
    h.clock.advance(5 * 60_000);
    const due5 = (await h.repo.listProvidersDueForSync(h.clock.now(), 50)).map((d) => d.providerId);
    expect(due5).not.toContain(DEMO_PROVIDER_ID);

    // 30 minutes after the first run: due again.
    h.clock.advance(25 * 60_000);
    const due30 = (await h.repo.listProvidersDueForSync(h.clock.now(), 50)).map((d) => d.providerId);
    expect(due30).toContain(DEMO_PROVIDER_ID);
  });

  it("disabled provider is never discovered by the heartbeat", async () => {
    h = await createHarness();
    await seedDemoData(h.repo);
    await h.repo.saveSyncSettings(DEMO_PROVIDER_ID, { enabled: false, intervalMinutes: 15, lookbackDays: 7 }, h.clock.now());
    const r = await runScheduledSync(deps(h));
    expect(r.enqueued).toBe(0);
    expect(h.queue.sent).toHaveLength(0);
    const sessions = await h.repo.listSessionsForProvider(DEMO_PROVIDER_ID, 10, null);
    expect(sessions.sessions).toHaveLength(0);
  });

  it("lookback window from settings limits discovery", async () => {
    h = await createHarness();
    await seedDemoData(h.repo);
    // Move the clock 3 days past the appointment; a 1-day lookback must not find it.
    h.clock.advance(3 * 24 * 60 * 60_000);
    await h.repo.saveSyncSettings(DEMO_PROVIDER_ID, { enabled: true, intervalMinutes: 15, lookbackDays: 1 }, h.clock.now());
    expect((await runScheduledSync(deps(h))).enqueued).toBe(0);
    h.clock.advance(15 * 60_000);
    await h.repo.saveSyncSettings(DEMO_PROVIDER_ID, { enabled: true, intervalMinutes: 15, lookbackDays: 7 }, h.clock.now());
    expect((await runScheduledSync(deps(h))).enqueued).toBe(1);
  });

  it("one provider's settings don't affect another provider's appointments", async () => {
    h = await createHarness();
    await seedDemoData(h.repo);
    await h.repo.upsertAppointment({
      ...demoAppointment,
      id: "appointment_other_001",
      occurrenceId: "occurrence_other_001",
      providerId: OTHER_PROVIDER_ID,
      clientRef: "C-205",
    });
    await h.repo.saveSyncSettings(DEMO_PROVIDER_ID, { enabled: false, intervalMinutes: 15, lookbackDays: 7 }, h.clock.now());
    const r = await runScheduledSync(deps(h));
    expect(r.enqueued).toBe(1);
    expect((await h.repo.listSessionsForProvider(OTHER_PROVIDER_ID, 10, null)).sessions).toHaveLength(1);
    expect((await h.repo.listSessionsForProvider(DEMO_PROVIDER_ID, 10, null)).sessions).toHaveLength(0);
  });

  it("API: GET/PUT /api/settings/sync is per-provider, validated, and manual sync is provider-scoped", async () => {
    h = await createHarness();
    const cookie = await h.login();

    const get1 = await h.req("/api/settings/sync", { cookie });
    expect(get1.status).toBe(200);
    expect(get1.json.data.settings).toEqual({ enabled: true, intervalMinutes: 15, lookbackDays: 7 });
    expect(get1.json.data.heartbeatMinutes).toBe(5);

    const bad = await h.req("/api/settings/sync", { method: "PUT", cookie, body: { enabled: true, intervalMinutes: 7, lookbackDays: 7 } });
    expect(bad.status).toBe(400);
    const extra = await h.req("/api/settings/sync", {
      method: "PUT",
      cookie,
      body: { enabled: true, intervalMinutes: 60, lookbackDays: 7, providerId: OTHER_PROVIDER_ID },
    });
    expect(extra.status).toBe(400);

    const put = await h.req("/api/settings/sync", { method: "PUT", cookie, body: { enabled: false, intervalMinutes: 60, lookbackDays: 3 } });
    expect(put.status).toBe(200);
    expect(put.json.data.settings).toEqual({ enabled: false, intervalMinutes: 60, lookbackDays: 3 });
    expect(put.json.data.nextRunAt).toBeNull();

    // Other provider unaffected.
    const other = await h.repo.getSyncSettings(OTHER_PROVIDER_ID);
    expect(other.settings.enabled).toBe(true);

    // Unauthenticated and cross-origin are rejected.
    expect((await h.req("/api/settings/sync", { cookie: null })).status).toBe(401);
    expect(
      (await h.req("/api/settings/sync", { method: "PUT", cookie, origin: "https://evil.example", body: { enabled: true, intervalMinutes: 15, lookbackDays: 7 } }))
        .status,
    ).toBe(403);

    // Manual sync still works with auto-sync off (lookback 3 days covers the fixture).
    const sync = await h.req("/api/sync", { method: "POST", cookie, body: {} });
    expect(sync.status).toBe(202);
    expect(sync.json.data.discovery.enqueued).toBe(1);
  });
});
