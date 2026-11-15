/**
 * Adapter from src/schedule `syncCalendarToAppointments` (which returns ids and counts) to the
 * partitioner's CalendarSync (event + its appointment). Injected so tests can use fakes.
 */
import type { Appointment, CalendarSource } from "../contracts";
import type { CalendarSync, SyncedEvent } from "./contract";

export interface CalendarSyncParts {
  calendar: CalendarSource;
  /** Upserts appointments for the events in [from, to); returns the appointment ids written. */
  sync: (providerId: string, from: Date, to: Date) => Promise<{ appointmentIds: string[] }>;
  appointmentIdForEvent: (eventId: string) => string;
  getAppointment: (id: string) => Promise<Appointment | null>;
}

export function calendarSync(p: CalendarSyncParts): CalendarSync {
  return async (providerId, from, to) => {
    const { appointmentIds } = await p.sync(providerId, from, to);
    const written = new Set(appointmentIds);
    const events = await p.calendar.listEvents(providerId, from, to);
    const out: SyncedEvent[] = [];
    for (const event of events) {
      if (event.providerId !== providerId) continue;
      const id = p.appointmentIdForEvent(event.eventId);
      if (!written.has(id)) continue; // skipped by the sync (no Drive context / authorization)
      const appointment = await p.getAppointment(id);
      if (appointment && appointment.providerId === providerId) out.push({ event, appointment });
    }
    return out;
  };
}
