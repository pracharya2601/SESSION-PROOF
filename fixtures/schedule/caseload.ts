/**
 * Demo caseload for provider_demo_001 (dummy data only). All fixture people are fictional:
 * every person, address, authorization number and organisation here is made up. No real names,
 * addresses or phones. Names read like real paperwork on purpose (no "(synthetic)" suffix);
 * the approval record still discloses fixture provenance.
 *
 * Mimics what a provider keeps in Google Calendar: a weekly recurring schedule, Mon–Fri,
 * 08:30–17:00 America/Los_Angeles, with CA Self-Determination Program (SDP) service codes
 * 320 / 331 / 334 / 335 (docs/research/self-determination-codes.md §1.2, DDS table [S1]).
 *
 * Clients reuse the canonical demo client C-104 ("Sam Rivera", fixtures/scenario.ts)
 * and the band-scenario clients SD-320-A / SD-334-A / SD-331-A / SD-335-A
 * (fixtures/band/scenarios.ts), with the same goal ids as their plans.
 *
 * src/schedule/demo-calendar.ts expands WEEKLY_PATTERN into concrete events for any date range.
 */
import { DEMO_PROVIDER_ID } from "../scenario";

export const SCHEDULE_PROVIDER_ID = DEMO_PROVIDER_ID;
export const SCHEDULE_TIMEZONE = "America/Los_Angeles";

export interface CaseloadClient {
  clientRef: string;
  /** Fictional display name (matches the existing fixture where the client already exists). */
  displayName: string;
  /** App service key, e.g. "CA-SDP-320". */
  serviceCode: string;
  /** Short calendar title used in event summaries. */
  shortTitle: string;
  /** Fictional location label (no street addresses). */
  location: string | null;
}

export const CASELOAD: readonly CaseloadClient[] = [
  { clientRef: "C-104", displayName: "Sam Rivera", serviceCode: "CA-SDP-320", shortTitle: "Independent living skills", location: "Participant's home" },
  { clientRef: "SD-320-A", displayName: "Robin Castillo", serviceCode: "CA-SDP-320", shortTitle: "Community Living Supports", location: "Participant's home" },
  { clientRef: "SD-334-A", displayName: "Jordan Mendez", serviceCode: "CA-SDP-334", shortTitle: "Money-management training", location: "Community learning room" },
  { clientRef: "SD-331-A", displayName: "Casey Nguyen", serviceCode: "CA-SDP-331", shortTitle: "Community integration", location: "Public library" },
  { clientRef: "SD-335-A", displayName: "Morgan Ellis", serviceCode: "CA-SDP-335", shortTitle: "Job coaching", location: "Worksite" },
];

/** ISO weekday: 1 = Monday … 5 = Friday. */
export type Weekday = 1 | 2 | 3 | 4 | 5;

export interface WeeklySlot {
  /** Unique within the pattern; part of the deterministic eventId. */
  slotId: string;
  weekday: Weekday;
  /** Local wall-clock start "HH:MM" in SCHEDULE_TIMEZONE. */
  start: string;
  minutes: number;
  clientRef: string;
  status: "confirmed" | "tentative" | "cancelled";
}

/**
 * The recurring week. Back-to-back pairs: Mon 09:00/10:00, Wed 10:30, Fri 11:00.
 * Tuesday 08:30 SD-334-A is tentative; Friday 08:30 SD-335-A is cancelled.
 * Friday 10:00–11:00 C-104 lines up with the canonical demo appointment (fixtures/scenario.ts).
 */
export const WEEKLY_PATTERN: readonly WeeklySlot[] = [
  // Monday
  { slotId: "mon1", weekday: 1, start: "09:00", minutes: 60, clientRef: "C-104", status: "confirmed" },
  { slotId: "mon2", weekday: 1, start: "10:00", minutes: 90, clientRef: "SD-320-A", status: "confirmed" },
  { slotId: "mon3", weekday: 1, start: "13:30", minutes: 120, clientRef: "SD-335-A", status: "confirmed" },
  // Tuesday
  { slotId: "tue1", weekday: 2, start: "08:30", minutes: 45, clientRef: "SD-334-A", status: "tentative" },
  { slotId: "tue2", weekday: 2, start: "10:00", minutes: 120, clientRef: "SD-331-A", status: "confirmed" },
  { slotId: "tue3", weekday: 2, start: "14:00", minutes: 60, clientRef: "C-104", status: "confirmed" },
  // Wednesday
  { slotId: "wed1", weekday: 3, start: "09:00", minutes: 90, clientRef: "SD-320-A", status: "confirmed" },
  { slotId: "wed2", weekday: 3, start: "10:30", minutes: 45, clientRef: "SD-334-A", status: "confirmed" },
  { slotId: "wed3", weekday: 3, start: "13:00", minutes: 120, clientRef: "SD-335-A", status: "confirmed" },
  { slotId: "wed4", weekday: 3, start: "15:30", minutes: 60, clientRef: "C-104", status: "confirmed" },
  // Thursday
  { slotId: "thu1", weekday: 4, start: "09:00", minutes: 60, clientRef: "SD-334-A", status: "confirmed" },
  { slotId: "thu2", weekday: 4, start: "11:00", minutes: 120, clientRef: "SD-331-A", status: "confirmed" },
  { slotId: "thu3", weekday: 4, start: "15:00", minutes: 90, clientRef: "SD-320-A", status: "confirmed" },
  // Friday
  { slotId: "fri1", weekday: 5, start: "08:30", minutes: 60, clientRef: "SD-335-A", status: "cancelled" },
  { slotId: "fri2", weekday: 5, start: "10:00", minutes: 60, clientRef: "C-104", status: "confirmed" },
  { slotId: "fri3", weekday: 5, start: "11:00", minutes: 60, clientRef: "SD-334-A", status: "confirmed" },
  { slotId: "fri4", weekday: 5, start: "15:45", minutes: 75, clientRef: "SD-320-A", status: "confirmed" },
];

/** Client used for the dev/demo "now" slot (DEMO_CALENDAR_NOW_SLOT=1). */
export const NOW_SLOT_CLIENT_REF = "C-104";
export const NOW_SLOT_MINUTES = 60;

export function caseloadClient(clientRef: string): CaseloadClient | undefined {
  return CASELOAD.find((c) => c.clientRef === clientRef);
}
