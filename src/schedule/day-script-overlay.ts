/**
 * DEV ONLY: calendar overlay for synthetic "provider's day" recordings (fixtures/schedule/day-scripts.ts).
 *
 * A day script plays relative to the recording's audio start ("now"), so the weekly demo pattern
 * rarely lines up with it. A script therefore brings its own calendar (offsets from the anchor),
 * and this wrapper adds those events to the demo calendar:
 *
 *   - scoped (`onlyRecordingId`, used by that recording's partition job): the base events that
 *     overlap the script's span (± 15 min) are hidden and only THIS recording's script events are
 *     added. Several demo runs started minutes apart therefore never see each other's events.
 *   - global (everything else: schedule view, currentEvent, visit context): base events plus the
 *     script events of every scenario recording near the range (event ids are unique per recording).
 *
 * Never fails the calendar: an overlay error falls back to the base events. src/index.ts only
 * installs it when RUNTIME_MODE !== "deployed" and the calendar is the demo one.
 */
import type { CalendarEvent, CalendarSource } from "../contracts";

export interface DayScriptRecording {
  id: string;
  scenario: string;
  /** Audio start (segments are anchor + atSec), else the recording start. */
  anchorMs: number;
}

export interface DayScriptOverlay {
  events: CalendarEvent[];
  /** The script's own span: base events overlapping it are hidden in the scoped view. */
  spanFromMs: number;
  spanToMs: number;
}

export interface DayScriptOverlayDeps {
  base: CalendarSource;
  /** Scenario recordings of this provider whose anchor lies in [fromMs, toMs). */
  listRecordings(providerId: string, fromMs: number, toMs: number): Promise<DayScriptRecording[]>;
  /** One scenario recording by id (scoped view), else null. */
  getRecording(providerId: string, id: string): Promise<DayScriptRecording | null>;
  /** The overlay of one recording, or null when its scenario is not a day script. */
  overlayFor(providerId: string, rec: DayScriptRecording): Promise<DayScriptOverlay | null>;
  /** Scope to one recording (its partition). */
  onlyRecordingId?: string;
}

/** Longest script span looked back from a range start (anchors earlier than this are ignored). */
export const DAY_SCRIPT_LOOKBACK_MS = 6 * 3600_000;
/** Base events this close to a scoped script's span are hidden too (partition buffer is 10 min). */
export const DAY_SCRIPT_GUARD_MS = 15 * 60_000;

const overlaps = (e: CalendarEvent, fromMs: number, toMs: number) => Date.parse(e.startAt) < toMs && Date.parse(e.endAt) > fromMs;
const sort = (events: CalendarEvent[]) =>
  events.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.eventId.localeCompare(b.eventId));

export class DayScriptCalendarSource implements CalendarSource {
  readonly kind: CalendarSource["kind"];
  constructor(private readonly d: DayScriptOverlayDeps) {
    this.kind = d.base.kind;
  }

  async listEvents(providerId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    const base = await this.d.base.listEvents(providerId, from, to);
    const f = from.getTime();
    const t = to.getTime();
    try {
      if (this.d.onlyRecordingId) {
        const rec = await this.d.getRecording(providerId, this.d.onlyRecordingId);
        const ov = rec ? await this.d.overlayFor(providerId, rec) : null;
        if (!ov) return base;
        const hideFrom = ov.spanFromMs - DAY_SCRIPT_GUARD_MS;
        const hideTo = ov.spanToMs + DAY_SCRIPT_GUARD_MS;
        return sort([...base.filter((e) => !overlaps(e, hideFrom, hideTo)), ...ov.events.filter((e) => overlaps(e, f, t))]);
      }
      const recs = await this.d.listRecordings(providerId, f - DAY_SCRIPT_LOOKBACK_MS, t);
      const extra: CalendarEvent[] = [];
      for (const rec of recs) {
        const ov = await this.d.overlayFor(providerId, rec);
        if (ov) extra.push(...ov.events.filter((e) => overlaps(e, f, t)));
      }
      return extra.length ? sort([...base, ...extra]) : base;
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", event: "dev.day_script_calendar_failed", errorName: err instanceof Error ? err.name : "unknown" }));
      return base;
    }
  }
}

/** Scenario recordings straight from D1 (`recordings` table, migration 0011). */
export function d1DayScriptRecordings(db: D1Database): Pick<DayScriptOverlayDeps, "listRecordings" | "getRecording"> {
  type Row = { id: string; scenario: string; anchor: string };
  const toRec = (r: Row): DayScriptRecording => ({ id: String(r.id), scenario: String(r.scenario), anchorMs: Date.parse(String(r.anchor)) });
  return {
    async listRecordings(providerId, fromMs, toMs) {
      const { results } = await db
        .prepare(
          `SELECT id, scenario, COALESCE(audio_started_at, started_at) AS anchor FROM recordings
            WHERE provider_id = ? AND scenario IS NOT NULL
              AND COALESCE(audio_started_at, started_at) >= ? AND COALESCE(audio_started_at, started_at) < ?
            ORDER BY anchor DESC LIMIT 50`,
        )
        .bind(providerId, new Date(fromMs).toISOString(), new Date(toMs).toISOString())
        .all<Row>();
      return results.map(toRec);
    },
    async getRecording(providerId, id) {
      const r = await db
        .prepare(`SELECT id, scenario, COALESCE(audio_started_at, started_at) AS anchor FROM recordings WHERE provider_id = ? AND id = ? AND scenario IS NOT NULL`)
        .bind(providerId, id)
        .first<Row>();
      return r ? toRec(r) : null;
    },
  };
}
