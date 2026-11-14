/** Timezone helpers for selecting an appointment's local day(s). No deps; uses Intl. */

function partsIn(instantMs: number, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
export function tzOffsetMs(instantMs: number, timeZone: string): number {
  const p = partsIn(instantMs, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDate(instantMs: number, timeZone: string): string {
  const p = partsIn(instantMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC instant (ms) of local midnight starting `date` (YYYY-MM-DD) in `timeZone`. DST-safe. */
export function localMidnightUtc(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - tzOffsetMs(guess, timeZone);
  const corrected = guess - tzOffsetMs(result, timeZone);
  if (corrected !== result) result = corrected;
  return result;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export interface LocalDayBounds {
  /** Local date YYYY-MM-DD. */
  date: string;
  /** Request bounds: the local day intersected with the requested window (UTC ms). */
  fromMs: number;
  toMs: number;
}

/**
 * Local days touched by [fromMs, toMs] in `timeZone`, each clipped to the window.
 * A cross-midnight window yields two (or more) days.
 */
export function localDaysForWindow(fromMs: number, toMs: number, timeZone: string): LocalDayBounds[] {
  const days: LocalDayBounds[] = [];
  let date = localDate(fromMs, timeZone);
  const last = localDate(toMs, timeZone);
  for (let guard = 0; guard < 7; guard++) {
    const dayStart = localMidnightUtc(date, timeZone);
    const dayEnd = localMidnightUtc(nextDate(date), timeZone);
    days.push({ date, fromMs: Math.max(dayStart, fromMs), toMs: Math.min(dayEnd, toMs) });
    if (date === last) break;
    date = nextDate(date);
  }
  return days;
}
