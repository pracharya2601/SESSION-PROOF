/**
 * Schedule sources registry: which CalendarSource / DriveSource the Worker uses
 * (src/contracts/schedule.ts, FROZEN). Today only the demo sources exist; "google" is a
 * stub that throws not_configured until the connectors (src/connections OAuth) are wired.
 *
 * Env (all optional, read structurally so src/env.ts need not change):
 *   CALENDAR_SOURCE = "demo" (default) | "google"
 *   DRIVE_SOURCE    = "demo" (default) | "google"
 *   DEMO_CALENDAR_NOW_SLOT = "1"  → DEMO BEHAVIOUR: inject a C-104 event covering "now"
 *                                   when no demo event does (see demo-calendar.ts).
 */
import type { CalendarEvent, CalendarSource, Clock, DriveClientContext, DriveSource } from "../contracts";
import { DemoCalendarSource } from "./demo-calendar";
import { parseExtraEvents } from "./demo-calendar";
import { DemoDriveSource } from "./demo-drive";
import { addDays, parseYmd, zonedTimeToUtc } from "./time";

export interface ScheduleEnv {
  CALENDAR_SOURCE?: string;
  DRIVE_SOURCE?: string;
  DEMO_CALENDAR_NOW_SLOT?: string;
}

export class ScheduleSourceError extends Error {
  constructor(
    readonly code: "not_configured" | "unknown_source",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleSourceError";
  }
}

/** Placeholder until Google Calendar is wired through src/connections. */
export class GoogleCalendarSource implements CalendarSource {
  readonly kind = "google" as const;
  async listEvents(_providerId: string, _from: Date, _to: Date): Promise<CalendarEvent[]> {
    throw new ScheduleSourceError("not_configured", "Google Calendar source is not configured");
  }
}

/** Placeholder until Google Drive is wired through src/connections. */
export class GoogleDriveSource implements DriveSource {
  readonly kind = "google" as const;
  async getClientContext(_providerId: string, _clientRef: string): Promise<DriveClientContext | null> {
    throw new ScheduleSourceError("not_configured", "Google Drive source is not configured");
  }
}

function pick(value: string | undefined, name: string): "demo" | "google" {
  const v = (value ?? "demo").trim().toLowerCase() || "demo";
  if (v === "demo" || v === "google") return v;
  throw new ScheduleSourceError("unknown_source", `${name} must be "demo" or "google"`);
}

export function createCalendarSource(env: ScheduleEnv, opts: { clock?: Clock } = {}): CalendarSource {
  if (pick(env.CALENDAR_SOURCE, "CALENDAR_SOURCE") === "google") return new GoogleCalendarSource();
  return new DemoCalendarSource({
    nowSlot: env.DEMO_CALENDAR_NOW_SLOT === "1",
    clock: opts.clock,
    extraEvents: parseExtraEvents((env as { DEMO_EXTRA_EVENTS?: string }).DEMO_EXTRA_EVENTS),
  });
}

export function createDriveSource(env: ScheduleEnv): DriveSource {
  if (pick(env.DRIVE_SOURCE, "DRIVE_SOURCE") === "google") return new GoogleDriveSource();
  return new DemoDriveSource();
}

/**
 * The event happening at `now` (for StartRecordingResponse.currentEvent): non-cancelled,
 * covering now; when several do, the latest start wins. Null when none.
 */
export async function findCurrentEvent(calendar: CalendarSource, providerId: string, now: Date): Promise<CalendarEvent | null> {
  const t = now.getTime();
  const events = await calendar.listEvents(providerId, new Date(t - 12 * 3_600_000), new Date(t + 1));
  const covering = events.filter((e) => e.status !== "cancelled" && Date.parse(e.startAt) <= t && t < Date.parse(e.endAt));
  return covering.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))[0] ?? null;
}

/** Events on one local calendar day "YYYY-MM-DD" in `timeZone` (GET /api/device/schedule?date=). */
export async function listEventsForLocalDate(calendar: CalendarSource, providerId: string, date: string, timeZone: string): Promise<CalendarEvent[]> {
  const d = parseYmd(date);
  if (!d) throw new RangeError("date must be YYYY-MM-DD");
  const from = zonedTimeToUtc(d, 0, 0, timeZone);
  const to = zonedTimeToUtc(addDays(d, 1), 0, 0, timeZone);
  return calendar.listEvents(providerId, from, to);
}

export { DemoCalendarSource, demoNowSlot, demoEventId, expandWeeklyPattern, MAX_RANGE_DAYS } from "./demo-calendar";
export { DemoDriveSource, contextFromDocuments } from "./demo-drive";
export { parseGoals, parseAuthorization, parseServiceCode, parseParticipantName } from "./drive-parse";
export {
  syncCalendarToAppointments,
  serviceConfigFromDrive,
  clientInputFromDrive,
  appointmentIdForEvent,
  SDP_INVOICE_REQUIRED,
  SDP_SERVICE_LABELS,
  type SyncResult,
  type SyncSkip,
  type SyncOptions,
} from "./sync";
