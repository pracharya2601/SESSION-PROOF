/**
 * Tiny tolerant parsers that "read" provider documents (plain text from Drive) into the
 * structured bits of DriveClientContext: goals (service plan), service code, and the
 * authorization. Pure functions; unknown or malformed text yields null/[] rather than throwing.
 *
 * Accepted shapes (case-insensitive, any bullet / numbering, separators : - – — ) ):
 *   "1. [goal_transport] Practice transportation planning."
 *   "- goal_laundry: Complete a laundry cycle independently."
 *   "Goal goal_bill_reading — Identify the amount due…"
 *   "SDP service code: 320" | "Service code: CA-SDP 320" | "Code: 334" → "CA-SDP-320"
 *   "Hourly rate: $75.00" | "Rate: $38.50 per hour" | "52.00 USD/hr" → cents
 *   "Authorized: 40 hours per month" | "Authorized minutes per month: 1800"
 *   "Valid from: 2026-07-01" + "Valid to: …" | "Valid: 08/01/2026 - 07/31/2027" | "… through …"
 */
import type { DriveClientContext } from "../contracts";

export type ParsedGoal = DriveClientContext["goals"][number];
export type ParsedAuthorization = NonNullable<DriveClientContext["authorization"]>;

const GOAL_RE = /^[\s>*•\-–—\d.)]*(?:goal\s*(?:id)?\s*[:#]?\s*)?\[?(goal_[a-z0-9_]+)\]?\s*(?:[:\-–—)]\s*)?(.*)$/i;

export function parseGoals(text: string): ParsedGoal[] {
  const out: ParsedGoal[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = GOAL_RE.exec(raw);
    if (!m) continue;
    const goalId = m[1]!.toLowerCase();
    const objective = (m[2] ?? "").trim();
    // A goal line needs an objective; "Goals addressed: goal_x, goal_y" lines are not definitions.
    if (!objective || /^,|^goal_/i.test(objective) || seen.has(goalId)) continue;
    seen.add(goalId);
    out.push({ goalId, objective: objective.slice(0, 500) });
    if (out.length >= 20) break;
  }
  return out;
}

/** Field value for the first line whose label matches. */
function field(text: string, label: RegExp): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = new RegExp(`^(?:${label.source})\\s*[:#.]*\\s*(.+)$`, "i").exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** "CA-SDP-<code>" from the first line naming a code (SDP codes are 310–399, DDS table [S1]). */
export function parseServiceCode(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const test of [/\bcode\b/i, /\bSDP\b/i]) {
    for (const raw of lines) {
      if (!test.test(raw)) continue;
      const m = /(?:^|[^\d-])(3[1-9]\d)(?![\d-])/.exec(raw);
      if (m) return `CA-SDP-${m[1]}`;
    }
  }
  return null;
}

/** "$75.00", "38.50 per hour", "52.00 USD/hr" → cents. */
export function parseMoneyCents(s: string): number | null {
  const m = /\$?\s*(\d{1,6}(?:,\d{3})*)(?:\.(\d{1,2}))?/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]!.replace(/,/g, ""));
  const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  return whole * 100 + frac;
}

/** "2026-07-01" or "07/01/2026" → "2026-07-01". */
export function normalizeDate(s: string): string | null {
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

const DATE_SRC = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{4})`;

function parseValidity(text: string): { validFrom: string; validTo: string } | null {
  const from = field(text, /valid\s+from|start\s+date|effective/);
  const to = field(text, /valid\s+(?:to|until|through)|end\s+date|expires/);
  if (from && to) {
    const f = normalizeDate(from);
    const t = normalizeDate(to);
    if (f && t) return { validFrom: f, validTo: t };
  }
  // One-line ranges: "Valid: A - B", "Valid from A through B", "Plan period: A to B".
  const range = new RegExp(`${DATE_SRC}\\s*(?:-|–|—|to|through|until)\\s*${DATE_SRC}`, "i");
  for (const raw of text.split(/\r?\n/)) {
    if (!/valid|period|dates?/i.test(raw)) continue;
    const m = range.exec(raw);
    if (m) {
      const f = normalizeDate(m[1]!);
      const t = normalizeDate(m[2]!);
      if (f && t) return { validFrom: f, validTo: t };
    }
  }
  return null;
}

function parseAuthorizedMinutes(text: string): number | null {
  for (const raw of text.split(/\r?\n/)) {
    if (!/authori[sz]ed/i.test(raw)) continue;
    const minutes = /(\d+(?:\.\d+)?)\s*(?:minutes|mins?)\b/i.exec(raw) ?? (/minutes/i.test(raw) ? /(\d+(?:\.\d+)?)/.exec(raw) : null);
    if (minutes) return Math.round(Number(minutes[1]));
    const hours = /(\d+(?:\.\d+)?)\s*(?:hours|hrs?|h)\b/i.exec(raw) ?? (/hours/i.test(raw) ? /(\d+(?:\.\d+)?)/.exec(raw) : null);
    if (hours) return Math.round(Number(hours[1]) * 60);
  }
  return null;
}

/**
 * Authorization fields; null unless number, funding source, hourly rate and validity are all
 * found (a half-read authorization must not silently drive billing).
 */
export function parseAuthorization(text: string): ParsedAuthorization | null {
  const number = field(text, /auth(?:ori[sz]ation)?\s*(?:number|no\.?|#)/);
  const fundingSource = field(text, /funding(?:\s+source)?/);
  const rateLine = field(text, /(?:hourly\s+)?rate/);
  const hourlyRateCents = rateLine ? parseMoneyCents(rateLine) : null;
  const validity = parseValidity(text);
  if (!number || !fundingSource || hourlyRateCents === null || !validity) return null;
  return {
    number: number.slice(0, 64),
    fundingSource: fundingSource.slice(0, 120),
    hourlyRateCents,
    authorizedMinutesPerMonth: parseAuthorizedMinutes(text),
    validFrom: validity.validFrom,
    validTo: validity.validTo,
  };
}

/** "Participant: Sam Rivera (synthetic)" from a plan/authorization doc. */
export function parseParticipantName(text: string): string | null {
  const v = field(text, /participant(?:\s+name)?/);
  if (!v) return null;
  return v.split("|")[0]!.trim().slice(0, 120) || null;
}
