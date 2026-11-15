/**
 * DemoCalendarSource: mimics Google Calendar for the SYNTHETIC demo caseload
 * (fixtures/schedule). Expands the weekly recurring pattern into concrete events for ANY
 * date range, in the provider's timezone, so a live test on any weekday matches a slot.
 *
 * Event ids are deterministic: demo_<client>_<YYYYMMDD local>_<slotId>, e.g.
 * "demo_c_104_20261113_fri2" (Google's equivalent is eventId + originalStartTime).
 *
 * DEMO BEHAVIOUR ("now" slot): with `nowSlot: true` (env DEMO_CALENDAR_NOW_SLOT=1, dev/demo
 * only) and no non-cancelled event covering the current time, a 60-minute C-104 event is
 * injected starting at the top of the current half hour (trimmed so it never overlaps the
 * next real event). This exists only so a live band recording always has an appointment to
 * land on during a demo. A real calendar never invents events.
 */
import type { CalendarEvent, CalendarSource, Clock } from "../contracts";
import { systemClock } from "../contracts";
import {
  CASELOAD,
  NOW_SLOT_CLIENT_REF,
  NOW_SLOT_MINUTES,
  SCHEDULE_PROVIDER_ID,
  SCHEDULE_TIMEZONE,
  WEEKLY_PATTERN,
  caseloadClient,
  type WeeklySlot,
} from "../../fixtures/schedule/caseload";
import { addDays, compareLocalDate, isoWeekday, localDateOf, ymd, zonedTimeToUtc, type LocalDate } from "./time";

export interface DemoCalendarOptions {
  /** Inject the dev/demo "now" slot (see file header). Default false. */
  nowSlot?: boolean;
  clock?: Clock;
}

/** Max span one listEvents call will expand (keeps a bad request cheap). */
export const MAX_RANGE_DAYS = 92;

export function slugRef(clientRef: string): string {
  return clientRef.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

export function demoEventId(clientRef: string, date: LocalDate, slotId: string): string {
  return `demo_${slugRef(clientRef)}_${ymd(date, "")}_${slotId}`;
}

function eventFor(slot: WeeklySlot, date: LocalDate): CalendarEvent {
  const client = caseloadClient(slot.clientRef);
  if (!client) throw new Error(`schedule fixture: unknown client ${slot.clientRef}`);
  const [h, m] = slot.start.split(":").map(Number) as [number, number];
  const start = zonedTimeToUtc(date, h, m, SCHEDULE_TIMEZONE);
  const end = new Date(start.getTime() + slot.minutes * 60_000);
  return {
    eventId: demoEventId(slot.clientRef, date, slot.slotId),
    providerId: SCHEDULE_PROVIDER_ID,
    clientRef: slot.clientRef,
    title: `${client.clientRef} ${client.shortTitle}`,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    timezone: SCHEDULE_TIMEZONE,
    serviceCode: client.serviceCode,
    location: client.location,
    status: slot.status,
    source: "demo",
  };
}

function overlaps(e: CalendarEvent, from: Date, to: Date): boolean {
  return Date.parse(e.startAt) < to.getTime() && Date.parse(e.endAt) > from.getTime();
}

/** Expands the weekly pattern over [from, to). Pure and deterministic. */
export function expandWeeklyPattern(from: Date, to: Date): CalendarEvent[] {
  if (!(to.getTime() > from.getTime())) return [];
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw new RangeError(`calendar range exceeds ${MAX_RANGE_DAYS} days`);
  }
  // Pad a day on each side so events whose local date differs from the UTC date are seen.
  const first = addDays(localDateOf(from, SCHEDULE_TIMEZONE), -1);
  const last = addDays(localDateOf(to, SCHEDULE_TIMEZONE), 1);
  const out: CalendarEvent[] = [];
  for (let d = first; compareLocalDate(d, last) <= 0; d = addDays(d, 1)) {
    const wd = isoWeekday(d);
    for (const slot of WEEKLY_PATTERN) {
      if (slot.weekday !== wd) continue;
      const e = eventFor(slot, d);
      if (overlaps(e, from, to)) out.push(e);
    }
  }
  return sortEvents(out);
}

function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.eventId.localeCompare(b.eventId));
}

/**
 * DEMO ONLY: the injected "now" event for `now`, or null when a non-cancelled pattern event
 * already covers it. Starts at the top of the current half hour; 60 min, trimmed to the next
 * real event's start.
 */
export function demoNowSlot(now: Date): CalendarEvent | null {
  const t = now.getTime();
  const around = expandWeeklyPattern(new Date(t - 6 * 3_600_000), new Date(t + 6 * 3_600_000)).filter((e) => e.status !== "cancelled");
  if (around.some((e) => Date.parse(e.startAt) <= t && t < Date.parse(e.endAt))) return null;
  const start = Math.floor(t / 1_800_000) * 1_800_000;
  let end = start + NOW_SLOT_MINUTES * 60_000;
  // Don't run into the previous event (it ended before now) or the next one.
  const prevEnd = Math.max(0, ...around.map((e) => Date.parse(e.endAt)).filter((x) => x <= t));
  const s = Math.max(start, prevEnd);
  const nextStart = Math.min(...around.map((e) => Date.parse(e.startAt)).filter((x) => x > t));
  if (Number.isFinite(nextStart)) end = Math.min(end, nextStart);
  const client = caseloadClient(NOW_SLOT_CLIENT_REF)!;
  const local = localDateOf(new Date(s), SCHEDULE_TIMEZONE);
  const startIso = new Date(s).toISOString();
  return {
    eventId: `demo_now_${slugRef(client.clientRef)}_${ymd(local, "")}_${startIso.slice(11, 16).replace(":", "")}z`,
    providerId: SCHEDULE_PROVIDER_ID,
    clientRef: client.clientRef,
    title: `${client.clientRef} ${client.shortTitle} (demo now-slot)`,
    startAt: startIso,
    endAt: new Date(end).toISOString(),
    timezone: SCHEDULE_TIMEZONE,
    serviceCode: client.serviceCode,
    location: client.location,
    status: "confirmed",
    source: "demo",
  };
}

/** One-off appointments added through configuration (env DEMO_EXTRA_EVENTS, JSON array). */
export interface ExtraEventInput {
  clientRef: string;
  startAt: string;
  endAt: string;
}

export function parseExtraEvents(raw: string | undefined): ExtraEventInput[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is ExtraEventInput =>
        !!e && typeof e.clientRef === "string" && !Number.isNaN(Date.parse(e.startAt)) && Date.parse(e.endAt) > Date.parse(e.startAt),
    );
  } catch {
    return [];
  }
}

function extraEvent(e: ExtraEventInput): CalendarEvent | null {
  const client = caseloadClient(e.clientRef);
  if (!client) return null;
  const startIso = new Date(e.startAt).toISOString();
  const local = localDateOf(new Date(startIso), SCHEDULE_TIMEZONE);
  return {
    eventId: `demo_extra_${slugRef(client.clientRef)}_${ymd(local, "")}_${startIso.slice(11, 16).replace(":", "")}z`,
    providerId: SCHEDULE_PROVIDER_ID,
    clientRef: client.clientRef,
    title: `${client.clientRef} ${client.shortTitle}`,
    startAt: startIso,
    endAt: new Date(e.endAt).toISOString(),
    timezone: SCHEDULE_TIMEZONE,
    serviceCode: client.serviceCode,
    location: client.location,
    status: "confirmed",
    source: "demo",
  };
}

export class DemoCalendarSource implements CalendarSource {
  readonly kind = "demo" as const;
  private readonly nowSlot: boolean;
  private readonly clock: Clock;
  private readonly extra: CalendarEvent[];

  constructor(opts: DemoCalendarOptions & { extraEvents?: ExtraEventInput[] } = {}) {
    this.nowSlot = opts.nowSlot ?? false;
    this.clock = opts.clock ?? systemClock;
    this.extra = (opts.extraEvents ?? []).map(extraEvent).filter((e): e is CalendarEvent => e !== null);
  }

  async listEvents(providerId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    if (providerId !== SCHEDULE_PROVIDER_ID) return [];
    const events = expandWeeklyPattern(from, to);
    for (const e of this.extra) if (overlaps(e, from, to)) events.push(e);
    if (this.nowSlot) {
      const slot = demoNowSlot(this.clock.now());
      // Never let the now-slot overlap a configured appointment (± 15 min), so splits stay unambiguous.
      const buffer = 15 * 60_000;
      const clash =
        slot &&
        this.extra.some((e) => Date.parse(slot.startAt) < Date.parse(e.endAt) + buffer && Date.parse(e.startAt) - buffer < Date.parse(slot.endAt));
      if (slot && !clash && overlaps(slot, from, to)) events.push(slot);
    }
    return sortEvents(events);
  }
}

/** Clients that appear in the demo calendar (for UIs / seeds). */
export const DEMO_CALENDAR_CLIENT_REFS = CASELOAD.map((c) => c.clientRef);
