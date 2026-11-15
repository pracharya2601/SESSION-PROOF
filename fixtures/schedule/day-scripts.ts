/**
 * SYNTHETIC "provider's day" scripts for client-less recordings (dummy data only: fictional
 * people, no PII). Each script is what the band would hear during ONE recording, as
 * Deepgram-style lines ("Speaker 0" = the provider, "Speaker 1" = whoever they talk to), with
 * `atSec` = seconds from the recording's audio start.
 *
 * Scripts work relative to "now": each brings its own calendar (`calendar`, minute offsets from
 * the audio start), modelled on the weekly demo caseload (fixtures/schedule/caseload.ts). In
 * local dev src/schedule/day-script-overlay.ts adds those events to the demo calendar (and, for
 * that recording's partition, hides the regular pattern + "now" slot around the script), so the
 * partition sees e.g. Monday's back-to-back C-104 09:00 → SD-320-A 10:00 whatever the wall clock.
 *
 * Played by: POST /api/device/recordings { scenario: "<id>" } (simulated transcriber, local dev
 * only; src/band/scenarios-registry.ts day-script lookup) and scripts/demo/run-day.mjs.
 *
 * Coverage: (a) tail of a visit + travel silence + a full next visit, (b) a 3-minute colleague
 * conversation, (c) a guardian phone call in a slot the participant missed, (d) personal small
 * talk, (e) a visit overrunning its slot by 12 minutes (with the overstatement bait), (f) content
 * about SD-334-A's goals outside any slot. Negated plan: (a) "we didn't submit the … application yet".
 */
import type { CalendarEvent } from "../../src/contracts";
import type { ScenarioLine } from "../band/types";
import { SCHEDULE_PROVIDER_ID, SCHEDULE_TIMEZONE, caseloadClient } from "./caseload";

export interface DayScriptEvent {
  /** Unique within the script; part of the event id. */
  key: string;
  clientRef: string;
  /** Start, minutes from the recording's audio start (negative = began before the recording). */
  offsetMin: number;
  minutes: number;
  status?: "confirmed" | "tentative";
  /** The weekly-pattern slot this mirrors (documentation only). */
  mirrors?: string;
}

export interface DayScriptExpect {
  /** Sessions the time rule creates (client + calendar event key), in time order. */
  sessions: { clientRef: string; eventKey: string; segments: number }[];
  unassignedSegments: number;
  ambiguousSegments: number;
  /** Conversation types the content pass may report for the leftover / session blocks. */
  conversationTypes?: string[];
  /** Pass 2 should propose this client for the unassigned block (null = no proposal expected). */
  suggestedClientRef?: string | null;
  /** …as this kind: "event" = extend that client's script event (visit tail), "unscheduled". */
  suggestedKind?: "event" | "unscheduled";
  /** Blocking issue codes every session of this script must carry (e.g. NOT_CLIENT_SESSION). */
  sessionBlockers?: string[];
  /** Blocking issue codes no session of this script may carry (false refusals). */
  forbiddenBlockers?: string[];
  /** The script carries the overstatement bait (CLAIM_EXCEEDS_EVIDENCE must refuse it if drafted). */
  bait?: boolean;
  /** The script carries a negated plan (the draft must not say it happened). */
  negatedPlan?: boolean;
}

export interface DayScript {
  /** kebab-case, matches StartRecordingRequest.scenario (/^[a-z0-9-]{1,64}$/). */
  id: string;
  title: string;
  purpose: string;
  calendar: DayScriptEvent[];
  script: ScenarioLine[];
  expect: DayScriptExpect;
}

/** The overstatement the provider dictates; the rules must refuse it if the drafter writes it. */
export const BAIT_PHRASE = "write that she can now pay all bills alone every month";
/** A plan that did NOT happen. */
export const NEGATED_PLAN_PHRASE = "we didn't submit the application yet";

const P = "Speaker 0"; // provider
const O = "Speaker 1"; // participant / colleague / guardian

/** "m:ss" → seconds. */
function t(mmss: string): number {
  const [m, s] = mmss.split(":").map(Number) as [number, number];
  return m * 60 + s;
}

/** Lines from [time, speaker, text, durationSec?]. Duration defaults to ~2.5 words/s, 3–12 s. */
function lines(rows: [string, string, string, number?][]): ScenarioLine[] {
  return rows.map(([at, speaker, text, dur]) => ({
    atSec: t(at),
    durationSec: dur ?? Math.min(12, Math.max(3, Math.round(text.split(/\s+/).length / 2.5))),
    speaker,
    text,
  }));
}

// ------------------------------------------------------------------ (a) visit tail → travel → next visit
const HANDOFF: DayScript = {
  id: "day-handoff",
  title: "C-104 visit tail, travel, then a full SD-320-A visit",
  purpose:
    "Back-to-back slots (Monday C-104 09:00 → SD-320-A 10:00): the last 7 minutes of one visit, 17 minutes of travel silence, then a full Community Living Supports visit. Includes a negated plan.",
  calendar: [
    { key: "c104", clientRef: "C-104", offsetMin: -40, minutes: 60, mirrors: "mon1" },
    { key: "sd320a", clientRef: "SD-320-A", offsetMin: 20, minutes: 90, mirrors: "mon2" },
  ],
  script: lines([
    // C-104, last minutes of the 09:00 visit (transport + budget goals).
    ["0:00", P, "Okay Sam, let's look at the bus route one more time before I head out."],
    ["0:20", O, "The number 12 goes to the library and I change at the transfer stop on Main."],
    ["0:45", P, "Right. You found the transfer stop on the map yourself today, with one reminder about the direction."],
    ["1:30", O, "I wrote the times on my card so I don't forget."],
    ["2:30", P, "About the reduced fare bus pass, we didn't submit the application yet, so you still pay full fare this week."],
    ["3:00", O, "Okay. Can we do it next time?"],
    ["3:10", P, "Yes, we'll fill it out together on Thursday. Bring your ID."],
    ["4:00", P, "For the food budget, you spent about forty dollars of the fifty we planned."],
    ["4:30", O, "I skipped the snacks at the store."],
    ["5:30", P, "Good choice. I'll bring a new budget worksheet next visit."],
    ["6:40", P, "Alright, I'm heading out. See you Thursday, Sam."],
    ["6:50", O, "Bye, see you."],
    // 7:00–24:00 travel: silence (the band keeps sending packets, nothing is said).
    // SD-320-A, the 10:00 visit (meal planning, laundry, weekly schedule).
    ["24:00", P, "Hi Robin, sorry, traffic. Ready to plan meals for the week?"],
    ["24:15", O, "Yes, I have the grocery flyer here."],
    ["26:00", P, "Let's pick two dinners. What do you want on Monday?"],
    ["26:20", O, "Pasta with vegetables, and tacos on Wednesday."],
    ["29:00", P, "Great, write them on the fridge plan."],
    ["31:00", O, "Done, both are on the plan."],
    ["33:00", P, "You wrote both dinners on the plan with one prompt to add the shopping list."],
    ["38:00", P, "Now the laundry. Can you sort the lights and the darks?"],
    ["38:30", O, "These are lights, these are darks. Towels go with the darks."],
    ["41:00", P, "Which setting do you use for the darks?"],
    ["41:20", O, "Cold water, normal cycle."],
    ["42:00", P, "You started the washer yourself, I only pointed to the detergent cup once."],
    ["55:00", P, "While the washer runs, let's update your weekly schedule."],
    ["55:30", O, "I have work Tuesday and Thursday, and bowling on Saturday."],
    ["58:00", P, "Put the dentist appointment on Friday at two in the calendar."],
    ["59:00", O, "Okay, Friday two o'clock, dentist."],
    ["70:00", P, "The washer is done. Move the clothes to the dryer."],
    ["71:00", O, "I cleaned the lint screen first."],
    ["80:00", P, "Let's check the meal plan against the flyer. Is pasta on sale?"],
    ["80:30", O, "Yes, two for three dollars."],
    ["92:00", O, "The dryer is finished, I'll fold the towels."],
    ["95:00", P, "Nice work today. You folded the towels and put them away."],
    ["101:00", P, "Next time we'll cook the pasta dinner together. See you Wednesday, Robin."],
    ["101:20", O, "Bye."],
  ]),
  expect: {
    sessions: [
      { clientRef: "C-104", eventKey: "c104", segments: 12 },
      { clientRef: "SD-320-A", eventKey: "sd320a", segments: 24 },
    ],
    unassignedSegments: 0,
    ambiguousSegments: 0,
    conversationTypes: ["client_session"],
    negatedPlan: true,
  },
};

// ------------------------------------------------------------------ (b) colleague conversation
const COLLEAGUE: DayScript = {
  id: "day-colleague",
  title: "3-minute caseload chat with a colleague",
  purpose: "Work talk between visits (coverage of C-201 next week, schedule, team meeting). No slot: must stay unassigned and never become a client session.",
  calendar: [],
  script: lines([
    ["0:00", O, "Hey, do you have a minute about the caseload?"],
    ["0:06", P, "Sure, I'm between visits."],
    ["0:15", O, "I'm out next week. Can you cover C-201 next week on Tuesday morning?"],
    ["0:30", P, "Tuesday morning I have a tentative eight thirty, but I can move that."],
    ["0:50", O, "Thanks. C-201 is working on the job application packet, the plan is in the shared folder."],
    ["1:10", P, "Okay, send me the authorization number and I'll check the hours left this month."],
    ["1:30", O, "Also, the team meeting moved to Thursday at four."],
    ["1:45", P, "Got it. I'll update my schedule and the mileage log."],
    ["2:10", O, "And who has the Friday afternoon slot this week, you or me?"],
    ["2:25", P, "That's mine, quarter to four until five."],
    ["2:45", O, "Perfect, thanks. I'll email the C-201 notes tonight."],
    ["2:56", P, "Sounds good, talk later."],
  ]),
  expect: { sessions: [], unassignedSegments: 12, ambiguousSegments: 0, conversationTypes: ["colleague_meeting"], suggestedClientRef: null },
};

// ------------------------------------------------------------------ (c) guardian phone call
const GUARDIAN: DayScript = {
  id: "day-guardian-call",
  title: "Guardian phone call in a slot the participant missed",
  purpose:
    "The provider arrives for C-104, the participant is not home, and the provider phones the guardian. The slot gets a session, but it is a phone call with family, not a client session: it must ask for confirmation.",
  calendar: [{ key: "c104", clientRef: "C-104", offsetMin: -5, minutes: 60, mirrors: "tue3" }],
  script: lines([
    ["0:00", P, "Hi, this is Sam's support worker calling. Is now a good time?"],
    ["0:08", O, "Yes, hi. Is everything okay with Sam?"],
    ["0:15", P, "Everything's fine. Sam isn't home yet, so I wanted to check if the visit is still on today."],
    ["0:30", O, "Oh, Sam has a doctor's appointment, I forgot to tell you. As Sam's mom, can I cancel today?"],
    ["0:45", P, "Of course. I'll note that the family cancelled today and we'll meet Thursday."],
    ["1:05", O, "Thank you. Also, does Sam need my signature for the bus pass form?"],
    ["1:20", P, "Yes, as the guardian you sign the second page. We'll bring it Thursday."],
    ["1:45", O, "Okay. Tell Sam I said hi."],
    ["2:00", P, "Will do. Bye now."],
  ]),
  expect: {
    sessions: [{ clientRef: "C-104", eventKey: "c104", segments: 9 }],
    unassignedSegments: 0,
    ambiguousSegments: 0,
    conversationTypes: ["guardian_or_family", "phone_call"],
    sessionBlockers: ["NOT_CLIENT_SESSION"],
  },
};

// ------------------------------------------------------------------ (d) personal small talk
const SMALL_TALK: DayScript = {
  id: "day-small-talk",
  title: "Personal small talk over coffee",
  purpose: "Personal conversation outside any slot: unassigned, classified as personal, never evidence.",
  calendar: [],
  script: lines([
    ["0:00", O, "How was your weekend?"],
    ["0:05", P, "Good, we went hiking and my kid finally learned to ride a bike."],
    ["0:20", O, "That's great! We just watched movies and ordered pizza."],
    ["0:40", P, "Honestly that sounds perfect. Are you going to the concert next month?"],
    ["0:55", O, "Maybe, the tickets are expensive. Want a coffee? I'm buying."],
    ["1:10", P, "Yes please, an oat milk latte. Thanks!"],
    ["1:20", O, "Okay, be right back."],
  ]),
  expect: { sessions: [], unassignedSegments: 7, ambiguousSegments: 0, conversationTypes: ["personal"], suggestedClientRef: null },
};

// ------------------------------------------------------------------ (e) overrun by 12 minutes
const OVERRUN: DayScript = {
  id: "day-overrun",
  title: "SD-334-A visit overrunning its slot by 12 minutes",
  purpose:
    "Money-management visit (Friday SD-334-A 11:00, 60 min) that runs 12 minutes past the slot: the first 10 minutes past the end are still in the window, the goodbye is not. The provider dictates an overstatement the evidence does not support.",
  calendar: [{ key: "sd334a", clientRef: "SD-334-A", offsetMin: -2, minutes: 60, mirrors: "fri3" }],
  script: lines([
    ["0:00", P, "Hi Jordan, let's start with your receipts from this week."],
    ["0:20", O, "I have five receipts. Groceries, the bus, and a movie."],
    ["3:00", P, "Enter each one in the budget sheet: date, store and amount."],
    ["6:00", O, "I put in the grocery one, forty two fifty."],
    ["9:00", P, "Good, that's correct. You entered three receipts with a prompt on the date column."],
    ["14:00", O, "The movie was twelve dollars. That goes under fun money."],
    ["16:00", P, "Right category. You have eight dollars of fun money left this week."],
    ["22:00", P, "Now let's look at your electric bill. Where is the amount due?"],
    ["22:30", O, "Here, sixty one dollars and twenty cents."],
    ["24:00", P, "And the due date?"],
    ["24:20", O, "November twenty eighth."],
    ["25:00", P, "You found both the amount due and the due date, I pointed to the top box once."],
    ["31:00", O, "I want to pay it online myself."],
    ["33:00", P, "We'll practise the online payment next time with the sample bill."],
    ["40:00", P, "For the note, write that she can now pay all bills alone every month."],
    ["48:00", P, "Let's set a reminder on your phone for the bill due date."],
    ["48:30", O, "I set it for November twenty sixth."],
    ["55:00", P, "We're almost at time. Let's finish the last receipt."],
    ["57:00", O, "The bus pass refill, twenty dollars."],
    ["62:00", P, "We're running over, but let's finish the weekly total."],
    ["63:00", O, "The total is one hundred twenty six fifty."],
    ["66:00", P, "That's right. You added up the weekly total with the calculator."],
    ["69:40", P, "Okay, we went twelve minutes over today. See you Friday, Jordan."],
    ["69:52", O, "Bye!"],
  ]),
  expect: {
    sessions: [{ clientRef: "SD-334-A", eventKey: "sd334a", segments: 22 }],
    unassignedSegments: 2,
    ambiguousSegments: 0,
    conversationTypes: ["client_session"],
    // The goodbye 8–10 min past the slot names the participant: extend SD-334-A's event.
    suggestedClientRef: "SD-334-A",
    suggestedKind: "event",
    bait: true,
  },
};

// ------------------------------------------------------------------ (f) unscheduled SD-334-A content
const UNSCHEDULED: DayScript = {
  id: "day-unscheduled",
  title: "Unscheduled SD-334-A check-in (budget + bill reading)",
  purpose:
    "Jordan drops by with a phone bill outside any slot. The time rule leaves it unassigned; the content pass should propose SD-334-A (budget tracking, bill reading) as an unscheduled session.",
  calendar: [],
  script: lines([
    ["0:00", O, "I brought my phone bill, I can't find the amount due."],
    ["0:15", P, "Let's look together, Jordan. The amount due is usually in the box at the top."],
    ["0:40", O, "Thirty five dollars, due December third."],
    ["1:00", P, "Yes. You found the amount due and the due date with one hint."],
    ["3:00", P, "Did you add your receipts to the budget sheet this week?"],
    ["3:15", O, "I added the grocery receipt and the bus refill."],
    ["4:30", P, "Good. What's left in your weekly budget?"],
    ["4:45", O, "Twenty two dollars until Friday."],
    ["7:00", P, "That's right. Let's write the phone bill in the bills column of the budget sheet."],
    ["8:30", O, "Done, phone bill thirty five, due December third."],
    ["9:30", P, "Great. This wasn't on the schedule, so I'll check with the coordinator before writing a note."],
  ]),
  expect: { sessions: [], unassignedSegments: 11, ambiguousSegments: 0, conversationTypes: ["client_session"], suggestedClientRef: "SD-334-A" },
};

export const DAY_SCRIPTS: readonly DayScript[] = [HANDOFF, COLLEAGUE, GUARDIAN, SMALL_TALK, OVERRUN, UNSCHEDULED];

export function getDayScript(id: string): DayScript | null {
  return DAY_SCRIPTS.find((s) => s.id === id) ?? null;
}

/** Seconds from the audio start to the end of the script's last line. */
export function dayScriptSeconds(s: DayScript): number {
  return Math.max(0, ...s.script.map((l) => l.atSec + l.durationSec));
}

/** Deterministic, unique per recording: demo_day_<last 12 of the recording id>_<key>. */
export function dayScriptEventId(recordingId: string, key: string): string {
  const tail = recordingId.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase();
  return `demo_day_${tail}_${key.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/** The script's calendar as concrete events, anchored at the recording's audio start. */
export function dayScriptEvents(s: DayScript, anchorMs: number, recordingId: string): CalendarEvent[] {
  return s.calendar.map((e) => {
    const client = caseloadClient(e.clientRef);
    if (!client) throw new Error(`day script ${s.id}: unknown client ${e.clientRef}`);
    const start = anchorMs + e.offsetMin * 60_000;
    return {
      eventId: dayScriptEventId(recordingId, e.key),
      providerId: SCHEDULE_PROVIDER_ID,
      clientRef: client.clientRef,
      title: `${client.clientRef} ${client.shortTitle}`,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + e.minutes * 60_000).toISOString(),
      timezone: SCHEDULE_TIMEZONE,
      serviceCode: client.serviceCode,
      location: client.location,
      status: e.status ?? "confirmed",
      source: "demo",
    };
  });
}

/** Overlay for src/schedule/day-script-overlay.ts: events + the span they own. */
export function dayScriptOverlay(id: string, anchorMs: number, recordingId: string) {
  const s = getDayScript(id);
  if (!s) return null;
  const events = dayScriptEvents(s, anchorMs, recordingId);
  const starts = [anchorMs, ...events.map((e) => Date.parse(e.startAt))];
  const ends = [anchorMs + dayScriptSeconds(s) * 1000, ...events.map((e) => Date.parse(e.endAt))];
  return { events, spanFromMs: Math.min(...starts), spanToMs: Math.max(...ends) };
}
