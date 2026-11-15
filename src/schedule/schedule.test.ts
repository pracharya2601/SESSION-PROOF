import { describe, expect, it } from "vitest";
import { CalendarEvent, DriveClientContext, ServiceConfig } from "../contracts";
import { CASELOAD, WEEKLY_PATTERN } from "../../fixtures/schedule/caseload";
import { DEMO_DRIVE_FOLDERS } from "../../fixtures/schedule/drive";
import { BAND_SCENARIOS } from "../../fixtures/band/scenarios";
import { demoPlan } from "../../fixtures/scenario";
import {
  DemoCalendarSource,
  DemoDriveSource,
  createCalendarSource,
  createDriveSource,
  demoNowSlot,
  expandWeeklyPattern,
  parseAuthorization,
  parseGoals,
  parseServiceCode,
  serviceConfigFromDrive,
  ScheduleSourceError,
  findCurrentEvent,
  listEventsForLocalDate,
} from "./index";
import { zonedTimeToUtc } from "./time";

const P = "provider_demo_001";
const TZ = "America/Los_Angeles";
const d = (s: string) => new Date(s);

describe("fixtures/schedule", () => {
  it("is a 5-client fictional caseload, Mon–Fri, 2–4 per day, 45–120 min, 08:30–17:00", () => {
    expect(CASELOAD).toHaveLength(5);
    // Names read like real paperwork (no "(synthetic)" suffix); all fixture people are fictional.
    for (const c of CASELOAD) expect(`${c.displayName} ${c.location ?? ""}`).not.toMatch(/synthetic|demo|fixture/i);
    expect(new Set(CASELOAD.map((c) => c.serviceCode))).toEqual(new Set(["CA-SDP-320", "CA-SDP-331", "CA-SDP-334", "CA-SDP-335"]));
    for (let wd = 1; wd <= 5; wd++) {
      const n = WEEKLY_PATTERN.filter((s) => s.weekday === wd).length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
    }
    for (const s of WEEKLY_PATTERN) {
      expect(s.minutes).toBeGreaterThanOrEqual(45);
      expect(s.minutes).toBeLessThanOrEqual(120);
      const [h, m] = s.start.split(":").map(Number) as [number, number];
      expect(h * 60 + m).toBeGreaterThanOrEqual(8 * 60 + 30);
      expect(h * 60 + m + s.minutes).toBeLessThanOrEqual(17 * 60);
    }
    expect(WEEKLY_PATTERN.filter((s) => s.status === "tentative")).toHaveLength(1);
    expect(WEEKLY_PATTERN.filter((s) => s.status === "cancelled")).toHaveLength(1);
    expect(new Set(WEEKLY_PATTERN.map((s) => s.slotId)).size).toBe(WEEKLY_PATTERN.length);
  });

  it("drive docs contain no obviously real contact details", () => {
    const all = DEMO_DRIVE_FOLDERS.flatMap((f) => f.documents.map((x) => x.text)).join("\n");
    expect(all).not.toMatch(/\(\d{3}\)\s*\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/); // phones
    expect(all).not.toMatch(/@(?!example\.invalid)\w+\.\w+/); // emails
    expect(all).not.toMatch(/\b\d{2,5}\s+\w+\s+(Street|St|Ave|Avenue|Blvd|Road|Rd)\b/i); // street addresses
    for (const f of DEMO_DRIVE_FOLDERS) for (const doc of f.documents) expect(doc.text).toContain("Fictional participant");
    expect(all).not.toMatch(/\(synthetic\)|SYNTHETIC/);
  });
});

describe("time helpers", () => {
  it("converts LA wall time across DST (2026-03-08 and 2026-11-01)", () => {
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 6 }, 9, 0, TZ).toISOString()).toBe("2026-03-06T17:00:00.000Z"); // PST
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 9 }, 9, 0, TZ).toISOString()).toBe("2026-03-09T16:00:00.000Z"); // PDT
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8 }, 2, 30, TZ).toISOString()).toBe("2026-03-08T10:30:00.000Z"); // gap → 03:30 PDT
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1 }, 1, 30, TZ).toISOString()).toBe("2026-11-01T08:30:00.000Z"); // ambiguous → first (PDT)
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 2 }, 9, 0, TZ).toISOString()).toBe("2026-11-02T17:00:00.000Z"); // PST
  });
});

describe("DemoCalendarSource", () => {
  const cal = new DemoCalendarSource();

  it("expands the weekly pattern deterministically into valid, sorted events", async () => {
    const a = await cal.listEvents(P, d("2026-11-09T00:00:00Z"), d("2026-11-16T00:00:00Z"));
    const b = await cal.listEvents(P, d("2026-11-09T00:00:00Z"), d("2026-11-16T00:00:00Z"));
    expect(a).toEqual(b);
    expect(a).toHaveLength(WEEKLY_PATTERN.length);
    for (const e of a) CalendarEvent.parse(e);
    const starts = a.map((e) => Date.parse(e.startAt));
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
    // Friday 2026-11-13 10:00 PST C-104 lines up with the canonical demo appointment.
    const fri = a.find((e) => e.eventId === "demo_c_104_20261113_fri2")!;
    expect(fri).toMatchObject({ clientRef: "C-104", startAt: "2026-11-13T18:00:00.000Z", endAt: "2026-11-13T19:00:00.000Z", timezone: TZ, status: "confirmed", source: "demo" });
    expect(a.find((e) => e.eventId === "demo_sd_335_a_20261113_fri1")!.status).toBe("cancelled");
    expect(a.find((e) => e.eventId === "demo_sd_334_a_20261110_tue1")!.status).toBe("tentative");
  });

  it("keeps local wall-clock times across the fall-back DST boundary", async () => {
    const before = await cal.listEvents(P, d("2026-10-26T00:00:00Z"), d("2026-10-27T00:00:00Z")); // Mon, PDT
    const after = await cal.listEvents(P, d("2026-11-02T00:00:00Z"), d("2026-11-03T00:00:00Z")); // Mon, PST
    const mon1Before = before.find((e) => e.eventId.endsWith("_mon1"))!;
    const mon1After = after.find((e) => e.eventId.endsWith("_mon1"))!;
    expect(mon1Before.startAt).toBe("2026-10-26T16:00:00.000Z");
    expect(mon1After.startAt).toBe("2026-11-02T17:00:00.000Z");
    expect(mon1Before.eventId).toBe("demo_c_104_20261026_mon1");
  });

  it("keeps local wall-clock times across spring-forward (2027-03-14)", async () => {
    const ev = await cal.listEvents(P, d("2027-03-08T00:00:00Z"), d("2027-03-20T00:00:00Z"));
    const mon = ev.filter((e) => e.eventId.endsWith("_mon1")).map((e) => e.startAt);
    expect(mon).toEqual(["2027-03-08T17:00:00.000Z", "2027-03-15T16:00:00.000Z"]);
  });

  it("returns overlap only, nothing on weekends, nothing for other providers", async () => {
    // 10:30 PST Monday: inside mon2 (10:00–11:30) only.
    const ov = await cal.listEvents(P, d("2026-11-16T18:30:00Z"), d("2026-11-16T18:31:00Z"));
    expect(ov.map((e) => e.eventId)).toEqual(["demo_sd_320_a_20261116_mon2"]);
    // Back-to-back: [10:00, 10:00) boundary — mon1 ends exactly when mon2 starts.
    const edge = await cal.listEvents(P, d("2026-11-16T18:00:00Z"), d("2026-11-16T18:00:01Z"));
    expect(edge.map((e) => e.eventId)).toEqual(["demo_sd_320_a_20261116_mon2"]);
    expect(await cal.listEvents(P, d("2026-11-14T08:00:00Z"), d("2026-11-16T08:00:00Z"))).toEqual([]);
    expect(await cal.listEvents("provider_other_002", d("2026-11-09T00:00:00Z"), d("2026-11-16T00:00:00Z"))).toEqual([]);
  });

  it("rejects ranges that are too long", () => {
    expect(() => expandWeeklyPattern(d("2026-01-01T00:00:00Z"), d("2026-12-01T00:00:00Z"))).toThrow(RangeError);
  });
});

describe("demo now-slot (DEMO_CALENDAR_NOW_SLOT=1)", () => {
  it("injects a 60-min C-104 event at the top of the current half hour when nothing covers now", async () => {
    const now = d("2026-11-14T21:47:12Z"); // Saturday 13:47 PST: no pattern events
    const cal = new DemoCalendarSource({ nowSlot: true, clock: { now: () => now } });
    const ev = await cal.listEvents(P, d("2026-11-14T08:00:00Z"), d("2026-11-15T08:00:00Z"));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ clientRef: "C-104", startAt: "2026-11-14T21:30:00.000Z", endAt: "2026-11-14T22:30:00.000Z", status: "confirmed", serviceCode: "CA-SDP-320" });
    expect(ev[0]!.eventId).toBe("demo_now_c_104_20261114_2130z");
    CalendarEvent.parse(ev[0]);
    // Deterministic for any "now" in the same half hour.
    expect(demoNowSlot(d("2026-11-14T21:59:59Z"))!.eventId).toBe(ev[0]!.eventId);
  });

  it("adds nothing when a real event covers now, and is off by default", async () => {
    const now = d("2026-11-13T18:20:00Z"); // Fri 10:20 PST inside fri2
    expect(demoNowSlot(now)).toBeNull();
    const off = new DemoCalendarSource({ clock: { now: () => d("2026-11-14T21:47:00Z") } });
    expect(await off.listEvents(P, d("2026-11-14T08:00:00Z"), d("2026-11-15T08:00:00Z"))).toEqual([]);
  });

  it("covers now but is trimmed so it never overlaps the next or previous event", () => {
    // Fri 2026-11-13 08:30 PST fri1 is CANCELLED, so 08:40 is uncovered; next is fri2 at 10:00.
    const s = demoNowSlot(d("2026-11-13T16:40:00Z"))!;
    expect(s).toMatchObject({ startAt: "2026-11-13T16:30:00.000Z", endAt: "2026-11-13T17:30:00.000Z" });
    // Mon 2026-11-16 11:40 PST: mon2 ended 11:30, next mon3 13:30 → starts 11:30.
    const t = demoNowSlot(d("2026-11-16T19:40:00Z"))!;
    expect(t.startAt).toBe("2026-11-16T19:30:00.000Z");
    // Thu 2026-11-19 10:40 PST: thu1 ended 10:00, thu2 starts 11:00 → 10:30–11:00.
    const u = demoNowSlot(d("2026-11-19T18:40:00Z"))!;
    expect(u).toMatchObject({ startAt: "2026-11-19T18:30:00.000Z", endAt: "2026-11-19T19:00:00.000Z" });
  });

  it("registry enables it only with DEMO_CALENDAR_NOW_SLOT=1", async () => {
    const clock = { now: () => d("2026-11-14T21:47:00Z") };
    const range = [d("2026-11-14T08:00:00Z"), d("2026-11-15T08:00:00Z")] as const;
    expect(await createCalendarSource({ DEMO_CALENDAR_NOW_SLOT: "1" }, { clock }).listEvents(P, ...range)).toHaveLength(1);
    expect(await createCalendarSource({}, { clock }).listEvents(P, ...range)).toHaveLength(0);
  });
});

describe("drive parsing", () => {
  it("parses tolerant goal lines", () => {
    expect(
      parseGoals(`GOALS
1. [goal_a] First objective.
- goal_b: Second.
Goal goal_c — Third.
  goal_d) Fourth.
• goal_e – Fifth.
Goals addressed: goal_a, goal_b
see (goal_f) inline
- goal_g:
`),
    ).toEqual([
      { goalId: "goal_a", objective: "First objective." },
      { goalId: "goal_b", objective: "Second." },
      { goalId: "goal_c", objective: "Third." },
      { goalId: "goal_d", objective: "Fourth." },
      { goalId: "goal_e", objective: "Fifth." },
    ]);
  });

  it("parses service codes and authorizations in several formats", () => {
    expect(parseServiceCode("Service code: CA-SDP 320 (Community Living Supports)")).toBe("CA-SDP-320");
    expect(parseServiceCode("Plan period: 2026-07-01\nCode: 334")).toBe("CA-SDP-334");
    expect(parseServiceCode("no code here 2026")).toBeNull();
    expect(
      parseAuthorization("Auth #: A-1\nFunding: Regional Center — SDP spending plan\nRate: $38.50 per hour\nAuthorized minutes per month: 1800\nValid: 08/01/2026 - 07/31/2027"),
    ).toEqual({ number: "A-1", fundingSource: "Regional Center — SDP spending plan", hourlyRateCents: 3850, authorizedMinutesPerMonth: 1800, validFrom: "2026-08-01", validTo: "2027-07-31" });
    expect(
      parseAuthorization("Authorization No.: B-2\nFunding source: X\nHourly rate: 52 USD/hr\nAuthorized hours per month: 12\nValid from 2026-09-01 through 2027-08-31"),
    ).toMatchObject({ number: "B-2", hourlyRateCents: 5200, authorizedMinutesPerMonth: 720, validFrom: "2026-09-01", validTo: "2027-08-31" });
    // Missing rate → null (never half-read billing data).
    expect(parseAuthorization("Authorization number: C-3\nFunding source: X\nValid from: 2026-01-01\nValid to: 2026-12-31")).toBeNull();
  });

  it("DemoDriveSource reads every folder into a valid context whose goals match the existing plans", async () => {
    const drive = new DemoDriveSource();
    const expected: Record<string, { goals: string[]; code: string; rate: number; minutes: number }> = {
      "C-104": { goals: demoPlan.goals.map((g) => g.goalId), code: "CA-SDP-320", rate: 7500, minutes: 2400 },
      "SD-320-A": { goals: ["goal_meal_planning", "goal_laundry", "goal_schedule"], code: "CA-SDP-320", rate: 3850, minutes: 1800 },
      "SD-334-A": { goals: ["goal_budget_tracking", "goal_bill_reading"], code: "CA-SDP-334", rate: 5200, minutes: 720 },
      "SD-331-A": { goals: ["goal_library_card", "goal_social_group"], code: "CA-SDP-331", rate: 4125, minutes: 1920 },
      "SD-335-A": { goals: ["goal_task_list", "goal_break_time"], code: "CA-SDP-335", rate: 4780, minutes: 1440 },
    };
    for (const c of CASELOAD) {
      const ctx = await drive.getClientContext(P, c.clientRef);
      expect(ctx, c.clientRef).not.toBeNull();
      DriveClientContext.parse(ctx);
      const e = expected[c.clientRef]!;
      expect(ctx!.goals.map((g) => g.goalId)).toEqual(e.goals);
      expect(ctx!.serviceCode).toBe(e.code);
      expect(ctx!.serviceCode).toBe(c.serviceCode);
      expect(ctx!.authorization).toMatchObject({ hourlyRateCents: e.rate, authorizedMinutesPerMonth: e.minutes, fundingSource: "Regional Center — SDP spending plan" });
      expect(ctx!.authorization!.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ctx!.documents.map((x) => x.kind)).toEqual(expect.arrayContaining(["service_plan", "authorization", "previous_note", "assessment"]));
      // Objectives match the existing band-scenario plans word for word.
      const band = BAND_SCENARIOS.find((s) => s.client.clientRef === c.clientRef);
      if (band) expect(ctx!.goals).toEqual(band.plan.goals);
    }
    expect(await drive.getClientContext(P, "NOPE")).toBeNull();
    expect(await drive.getClientContext("provider_other_002", "C-104")).toBeNull();
  });

  it("builds a valid ServiceConfig whose rules require the SDP invoice minimums", async () => {
    const ctx = (await new DemoDriveSource().getClientContext(P, "SD-334-A"))!;
    const cfg = ServiceConfig.parse(serviceConfigFromDrive(ctx));
    expect(cfg.rate.hourlyRateCents).toBe(5200);
    expect(cfg.rules.required).toEqual(expect.arrayContaining(["service_date", "service_description", "confirmed_duration", "goal_addressed"]));
    expect(cfg.plan.serviceCode).toBe("CA-SDP-334");
    expect(serviceConfigFromDrive(ctx)).toEqual(serviceConfigFromDrive(ctx));
  });
});

describe("helpers", () => {
  it("findCurrentEvent / listEventsForLocalDate", async () => {
    const cal = new DemoCalendarSource();
    expect((await findCurrentEvent(cal, P, d("2026-11-13T18:20:00Z")))!.eventId).toBe("demo_c_104_20261113_fri2");
    expect(await findCurrentEvent(cal, P, d("2026-11-13T16:40:00Z"))).toBeNull(); // only the cancelled fri1
    // Back-to-back boundary: at 11:00 fri2 has ended, fri3 has started.
    expect((await findCurrentEvent(cal, P, d("2026-11-13T19:00:00Z")))!.eventId).toBe("demo_sd_334_a_20261113_fri3");
    const fri = await listEventsForLocalDate(cal, P, "2026-11-13", TZ);
    expect(fri.map((e) => e.eventId.split("_").pop())).toEqual(["fri1", "fri2", "fri3", "fri4"]);
    await expect(listEventsForLocalDate(cal, P, "2026-13-01", TZ)).rejects.toThrow(RangeError);
  });
});

describe("registry", () => {
  it("defaults to demo; google is a not_configured stub; junk is rejected", async () => {
    expect(createCalendarSource({}).kind).toBe("demo");
    expect(createDriveSource({}).kind).toBe("demo");
    const g = createCalendarSource({ CALENDAR_SOURCE: "google" });
    await expect(g.listEvents(P, new Date(), new Date())).rejects.toMatchObject({ code: "not_configured" });
    await expect(createDriveSource({ DRIVE_SOURCE: "google" }).getClientContext(P, "C-104")).rejects.toBeInstanceOf(ScheduleSourceError);
    expect(() => createCalendarSource({ CALENDAR_SOURCE: "outlook" })).toThrow(ScheduleSourceError);
  });
});
