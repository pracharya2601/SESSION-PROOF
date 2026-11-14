/** Date / money formatting for artifacts. Appointment-timezone aware, UTC fallback. */

function safeTz(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return tz;
  } catch {
    return "UTC";
  }
}

function parts(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { ...opts, timeZone: safeTz(tz) }).formatToParts(new Date(iso))) {
    out[p.type] = p.value;
  }
  return out;
}

/** YYYY-MM-DD in the given timezone. */
export function ymdInTz(iso: string, tz: string): string {
  const p = parts(iso, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Friday, November 13, 2026" */
export function longDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz(tz),
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

/** "Nov 13, 2026" */
export function shortDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: safeTz(tz), year: "numeric", month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

/** "10:00 AM" */
export function clock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: safeTz(tz), hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "PST" (or "GMT-8" where no abbreviation exists). */
export function tzAbbr(iso: string, tz: string): string {
  return parts(iso, tz, { timeZoneName: "short" }).timeZoneName ?? tz;
}

/** "10:00 AM – 11:00 AM PST" */
export function timeRange(fromIso: string, toIso: string, tz: string): string {
  return `${clock(fromIso, tz)} – ${clock(toIso, tz)} ${tzAbbr(toIso, tz)}`;
}

/** "Nov 13, 2026, 11:45 AM PST (America/Los_Angeles)" */
export function dateTimeInTz(iso: string, tz: string): string {
  return `${shortDate(iso, tz)}, ${clock(iso, tz)} ${tzAbbr(iso, tz)} (${safeTz(tz)})`;
}

/** "2026-11-13 19:45:00 UTC" */
export function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${neg ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export function minutesLabel(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hm = h > 0 ? ` (${h} h${r ? ` ${r} min` : ""})` : "";
  return `${m} min${hm}`;
}

/** FNV-1a 32-bit, hex. Deterministic, non-cryptographic (display ids only). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(8, "0");
}
