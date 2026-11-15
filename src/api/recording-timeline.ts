/**
 * GET /api/recordings/:id/events → { events: RecordingTimelineEvent[] }
 *
 * The calendar lanes for the Recordings detail timeline: the provider's synced calendar
 * appointments (appt_cal_*, not cancelled) overlapping the recording ± 1 h, each with the session
 * built for it (or null) and whether a deleted session dismissed it. Ids, client refs and times
 * only (no event titles: a real calendar title can carry a name). Another provider's recording → 404.
 */
import { Hono } from "hono";
import { CALENDAR_APPOINTMENT_PREFIX } from "../recordings/contract";
import { createRecordingStore } from "../recordings/store";
import { apiError } from "../security";
import type { AppBindings } from "./deps";
import type { RecordingApiDeps } from "./recordings";
import { ok } from "./respond";

export interface RecordingTimelineEvent {
  eventId: string;
  appointmentId: string;
  clientRef: string;
  startAt: string;
  endAt: string;
  sessionId: string | null;
  sessionStatus: string | null;
  dismissed: boolean;
}

const MARGIN_MS = 3600_000;

export function recordingTimelineRoutes(deps: RecordingApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get("/api/recordings/:id/events", async (c) => {
    const providerId = c.get("actor").providerId;
    const store = deps.recordings?.store ?? createRecordingStore(deps.env.DB);
    const row = await store.get(providerId, c.req.param("id"));
    if (!row) return apiError(c, 404, "NOT_FOUND", "Recording not found", false);
    const r = row.recording;
    const segs = await store.listAssignments(r.id);
    const startMs = Math.min(Date.parse(r.startedAt), ...segs.map((s) => Date.parse(s.observedFrom)));
    const endMs = Math.max(Date.parse(r.endedAt ?? r.startedAt), ...segs.map((s) => Date.parse(s.observedTo)));
    const appts = (
      await deps.repo.listProviderAppointmentsOverlapping(
        providerId,
        new Date(startMs - MARGIN_MS).toISOString(),
        new Date(endMs + MARGIN_MS).toISOString(),
      )
    ).filter((a) => a.id.startsWith(CALENDAR_APPOINTMENT_PREFIX) && a.providerId === providerId);
    const db = deps.env.DB;
    const events: RecordingTimelineEvent[] = [];
    for (const a of appts.slice(0, 40)) {
      const s = await db
        .prepare(`SELECT id, status FROM sessions WHERE provider_id = ? AND appointment_id = ?`)
        .bind(providerId, a.id)
        .first<{ id: string; status: string }>();
      const d = await db
        .prepare(`SELECT 1 AS x FROM dismissed_events WHERE provider_id = ? AND event_id = ?`)
        .bind(providerId, a.occurrenceId)
        .first();
      events.push({
        eventId: a.occurrenceId,
        appointmentId: a.id,
        clientRef: a.clientRef,
        startAt: a.startAt,
        endAt: a.endAt,
        sessionId: s?.id ?? null,
        sessionStatus: s?.status ?? null,
        dismissed: !!d && !s,
      });
    }
    return ok(c, { events });
  });
  return app;
}
