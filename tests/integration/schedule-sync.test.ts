/**
 * syncCalendarToAppointments over Miniflare D1 with every migration applied (as
 * tests/e2e/harness.ts does): appointments + service configs + insert-only clients from
 * the demo Calendar/Drive, idempotent across repeated syncs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../../src/db/d1";
import type { Repository } from "../../src/db/repository";
import type { CalendarEvent, CalendarSource, DriveSource } from "../../src/contracts";
import { DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY } from "../../fixtures/scenario";
import { demoClientInput, seedDemoData } from "../../src/calendar/seed";
import { DemoCalendarSource, DemoDriveSource, syncCalendarToAppointments } from "../../src/schedule";

const MIG_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const NOW = new Date("2026-11-14T20:00:00.000Z");
const FROM = new Date("2026-11-09T08:00:00.000Z"); // Mon 00:00 PST
const TO = new Date("2026-11-16T08:00:00.000Z");

const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
afterAll(() => mf.dispose());

/** Same statement splitter as tests/e2e/harness.ts (keeps trigger BEGIN…END bodies whole). */
function splitSql(sql: string): string[] {
  const noComments = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const part of noComments.split(/(;)/)) {
    if (part === ";") {
      buf += ";";
      if (depth === 0) {
        if (buf.trim() !== ";") out.push(buf.trim());
        buf = "";
      }
      continue;
    }
    depth += (part.match(/\bBEGIN\b/gi) ?? []).length;
    depth -= (part.match(/\bEND\b/gi) ?? []).length;
    if (depth < 0) depth = 0;
    buf += part;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

let db: D1Database;
let repo: Repository;

beforeEach(async () => {
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  for (const { name } of results) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  for (const f of readdirSync(MIG_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of splitSql(readFileSync(resolve(MIG_DIR, f), "utf8"))) await db.prepare(stmt).run();
  }
  repo = createRepository(db);
  await repo.upsertProvider(DEMO_PROVIDER_ID, DEMO_PROVIDER_IDENTITY);
}, 60_000);

async function count(table: string): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

describe("syncCalendarToAppointments", { timeout: 60_000 }, () => {
  it("upserts one appointment per event with Drive-derived config, and is idempotent", async () => {
    const cal = new DemoCalendarSource();
    const r1 = await syncCalendarToAppointments(repo, cal, DEMO_PROVIDER_ID, FROM, TO, { now: NOW });
    expect(r1).toMatchObject({ events: 17, appointmentsUpserted: 17, canceled: 1, configsUpserted: 5, clientsInserted: 5, skipped: [] });

    const appt = (await repo.getAppointment("appt_cal_demo_c_104_20261113_fri2"))!;
    expect(appt).toMatchObject({
      occurrenceId: "demo_c_104_20261113_fri2",
      providerId: DEMO_PROVIDER_ID,
      clientRef: "C-104",
      startAt: "2026-11-13T18:00:00.000Z",
      serviceCode: "CA-SDP-320",
      canceled: false,
    });
    const cfg = (await repo.getServiceConfig(appt.planVersion, appt.ruleVersion, appt.rateVersion))!;
    expect(cfg.rate.hourlyRateCents).toBe(7500);
    expect(cfg.plan.goals.map((g) => g.goalId)).toEqual(["goal_transport", "goal_budget", "goal_community"]);
    expect(cfg.rules.required).toContain("confirmed_duration");

    expect((await repo.getAppointment("appt_cal_demo_sd_335_a_20261113_fri1"))!.canceled).toBe(true);
    expect((await repo.getAppointment("appt_cal_demo_sd_334_a_20261110_tue1"))!.canceled).toBe(false); // tentative

    const client = (await repo.getClient(DEMO_PROVIDER_ID, "SD-331-A"))!;
    expect(client).toMatchObject({ displayName: "Casey Nguyen", authorizationNumber: "AUTH-SYN-SD331A-02", hourlyRateCents: null, authorizedHours: 32 });

    const before = { a: await count("appointments"), s: await count("service_configs"), c: await count("clients") };
    const r2 = await syncCalendarToAppointments(repo, cal, DEMO_PROVIDER_ID, FROM, TO, { now: NOW });
    expect(r2.appointmentIds).toEqual(r1.appointmentIds);
    expect(r2.clientsInserted).toBe(0);
    expect({ a: await count("appointments"), s: await count("service_configs"), c: await count("clients") }).toEqual(before);
    expect(before).toEqual({ a: 17, s: 5, c: 5 });
  });

  it("never overwrites an existing client (insert-only) and coexists with the demo seed", async () => {
    await seedDemoData(repo, { now: NOW });
    await repo.upsertClient(DEMO_PROVIDER_ID, { ...demoClientInput, notes: "provider edit" }, NOW);
    const r = await syncCalendarToAppointments(repo, new DemoCalendarSource(), DEMO_PROVIDER_ID, FROM, TO, { now: NOW });
    expect(r.clientsInserted).toBe(4);
    const c = (await repo.getClient(DEMO_PROVIDER_ID, "C-104"))!;
    expect(c.notes).toBe("provider edit");
    expect(c.displayName).toBe("Sam Rivera");
    expect(await repo.getAppointment("appointment_demo_001")).not.toBeNull();
  });

  it("a cancelled-later event flips canceled on re-sync; missing Drive context is skipped", async () => {
    const base = new DemoCalendarSource();
    let cancelFri2 = false;
    const cal: CalendarSource = {
      kind: "demo",
      async listEvents(p, f, t) {
        const ev = await base.listEvents(p, f, t);
        const extra: CalendarEvent = { ...ev[0]!, eventId: "demo_x_9_20261109_mon9", clientRef: "X-9" };
        return [...ev.map((e) => (cancelFri2 && e.eventId.endsWith("20261113_fri2") ? { ...e, status: "cancelled" as const } : e)), extra];
      },
    };
    const r1 = await syncCalendarToAppointments(repo, cal, DEMO_PROVIDER_ID, FROM, TO, { now: NOW });
    expect(r1.skipped).toEqual([{ eventId: "demo_x_9_20261109_mon9", clientRef: "X-9", reason: "no_drive_context" }]);
    expect((await repo.getAppointment("appt_cal_demo_c_104_20261113_fri2"))!.canceled).toBe(false);
    cancelFri2 = true;
    await syncCalendarToAppointments(repo, cal, DEMO_PROVIDER_ID, FROM, TO, { now: NOW });
    expect((await repo.getAppointment("appt_cal_demo_c_104_20261113_fri2"))!.canceled).toBe(true);
  });

  it("an authorization without a rate yields no appointment (no_authorization)", async () => {
    const drive: DriveSource = {
      kind: "demo",
      async getClientContext(p, ref) {
        const ctx = await new DemoDriveSource().getClientContext(p, ref);
        return ctx && ref === "SD-335-A" ? { ...ctx, authorization: null } : ctx;
      },
    };
    const r = await syncCalendarToAppointments(repo, new DemoCalendarSource(), DEMO_PROVIDER_ID, FROM, TO, { drive, now: NOW });
    expect(r.skipped.map((s) => s.reason)).toEqual(["no_authorization", "no_authorization", "no_authorization"]);
    expect(r.appointmentsUpserted).toBe(14);
  });

  it("syncs the injected now-slot and returns nothing for another provider", async () => {
    const now = new Date("2026-11-14T21:47:00.000Z");
    const cal = new DemoCalendarSource({ nowSlot: true, clock: { now: () => now } });
    const r = await syncCalendarToAppointments(repo, cal, DEMO_PROVIDER_ID, new Date("2026-11-14T08:00:00Z"), new Date("2026-11-15T08:00:00Z"), { now });
    expect(r.appointmentIds).toEqual(["appt_cal_demo_now_c_104_20261114_2130z"]);
    const other = await syncCalendarToAppointments(repo, cal, "provider_other_002", FROM, TO, { now });
    expect(other.events).toBe(0);
  });
});
