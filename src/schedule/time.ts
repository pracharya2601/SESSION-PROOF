/**
 * Tiny IANA-timezone helpers (no library): wall-clock time in a zone ↔ UTC instant.
 * Uses Intl.DateTimeFormat, which Workers and Node both ship with full tz data.
 */

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(instant: Date, timeZone: string) {
  const p: Record<string, number> = {};
  for (const part of fmt(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

/** Offset (ms) of the zone at an instant: local wall clock − UTC. */
function offsetMs(instant: Date, timeZone: string): number {
  const z = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * UTC instant for a local wall-clock time. Non-existent times (spring-forward gap) shift
 * forward by the gap; ambiguous times (fall-back) resolve to the first (daylight) occurrence.
 */
export function zonedTimeToUtc(d: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(d.year, d.month - 1, d.day, hour, minute);
  const H12 = 12 * 60 * 60_000;
  // Offsets on either side of any transition near this wall time.
  const before = guess - offsetMs(new Date(guess - H12), timeZone);
  const after = guess - offsetMs(new Date(guess + H12), timeZone);
  const matches = [before, after]
    .filter((t) => {
      const z = zonedParts(new Date(t), timeZone);
      return z.year === d.year && z.month === d.month && z.day === d.day && z.hour === hour && z.minute === minute;
    })
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? before);
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const z = zonedParts(instant, timeZone);
  return { year: z.year, month: z.month, day: z.day };
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** ISO weekday 1 = Monday … 7 = Sunday. */
export function isoWeekday(d: LocalDate): number {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function ymd(d: LocalDate, sep = "-"): string {
  return [String(d.year).padStart(4, "0"), String(d.month).padStart(2, "0"), String(d.day).padStart(2, "0")].join(sep);
}

/** Parses "YYYY-MM-DD". */
export function parseYmd(s: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return t.getUTCMonth() + 1 === d.month && t.getUTCDate() === d.day ? d : null;
}
