/**
 * Demo per-client Drive folders for provider_demo_001 (dummy data only). All fixture people are
 * fictional.
 *
 * Mimics what a provider keeps in Google Drive: one folder per client with a service plan,
 * an authorization, previous session notes and an assessment, as PLAIN TEXT. Every person,
 * organisation, number and place is fictional ("Example …", "AUTH-SYN-…").
 * No real names, addresses or phone numbers.
 *
 * The formatting deliberately varies a little between clients (as real provider documents
 * do) so src/schedule/drive-parse.ts has to be tolerant. Goal ids match the plans in
 * fixtures/scenario.ts (C-104) and fixtures/band/scenarios.ts (SD-*).
 */
import type { DriveDocument } from "../../src/contracts";

export interface DemoDriveFolder {
  clientRef: string;
  folder: string;
  documents: DriveDocument[];
}

const ROOT = "My Drive/Caseload";
const SYN = "Fictional participant (demo document) - not a real person.";

function doc(id: string, name: string, kind: DriveDocument["kind"], modifiedAt: string, text: string): DriveDocument {
  return { id, name, kind, modifiedAt, text: text.trim() + "\n" };
}

// ------------------------------------------------------------------ C-104
const c104: DemoDriveFolder = {
  clientRef: "C-104",
  folder: `${ROOT}/C-104 - Sam Rivera`,
  documents: [
    doc("drv_c104_plan", "C-104 Service plan 2026-27", "service_plan", "2026-07-02T17:15:00.000Z", `
SERVICE PLAN — Self-Determination Program
${SYN}

Participant: Sam Rivera
Client ID: C-104
Service: Community Living Supports — independent living skills
SDP service code: 320
Plan period: 2026-07-01 to 2027-06-30
Service coordinator: Example Service Coordinator

GOALS
1. [goal_transport] Practice transportation planning.
   Measure: plans a bus route with one transfer using a printed map, with no more than one prompt.
2. [goal_budget] Practice budgeting.
   Measure: compares the weekly food budget with receipts and names one change.
3. [goal_community] Practice community interaction.
   Measure: starts one conversation with staff at a community venue each month.

Frequency: up to 3 visits per week, 60 minutes each.
Participant preferences: mornings; likes maps and the library.
`),
    doc("drv_c104_auth", "C-104 Authorization (SDP spending plan)", "authorization", "2026-07-01T16:00:00.000Z", `
SERVICE AUTHORIZATION
${SYN}

Authorization number: AUTH-SYN-C104-2627
Participant: Sam Rivera  |  Client ID: C-104
Funding source: Regional Center — SDP spending plan
Financial Management Service: Example FMS, bill payer
SDP service code: 320 Community Living Supports
Hourly rate: $75.00
Authorized: 40 hours per month
Valid from: 2026-07-01
Valid to: 2027-06-30
`),
    doc("drv_c104_note_1", "C-104 Session note 2026-11-06", "previous_note", "2026-11-06T19:20:00.000Z", `
SESSION NOTE (previous) — ${SYN}
Date: 2026-11-06   Time: 10:00–11:00   Code: SDP 320
Goals addressed: goal_transport, goal_budget
Sam looked up the bus schedule to the library and wrote down the departure time with two prompts.
Reviewed the grocery receipt against the weekly food budget; Sam noticed snacks were over budget.
Next visit: practise a route with one transfer.
`),
    doc("drv_c104_note_2", "C-104 Session note 2026-11-10", "previous_note", "2026-11-10T22:05:00.000Z", `
SESSION NOTE (previous) — ${SYN}
Date: 2026-11-10   Time: 14:00–15:00   Code: SDP 320
Goals addressed: goal_community
Visited the community centre front desk; Sam asked about the art class schedule without prompting.
Follow-up: bring a route-planning worksheet next time.
`),
    doc("drv_c104_assess", "C-104 Skills assessment", "assessment", "2026-06-20T18:00:00.000Z", `
INDEPENDENT LIVING SKILLS ASSESSMENT — ${SYN}
Participant: Sam Rivera
Transportation: reads a printed bus schedule; needs support with transfers.
Money: counts change accurately; budgeting across a week is emerging.
Community: polite with familiar people; hesitant to start conversations with strangers.
Recommendation: continue 320 Community Living Supports focused on routes, budgeting and community contact.
`),
  ],
};

// ------------------------------------------------------------------ SD-320-A
const sd320a: DemoDriveFolder = {
  clientRef: "SD-320-A",
  folder: `${ROOT}/SD-320-A - Robin Castillo`,
  documents: [
    doc("drv_sd320a_plan", "SD-320-A Service plan", "service_plan", "2026-08-12T20:00:00.000Z", `
Self-Determination Program — Individual Service Plan
${SYN}

Participant: Robin Castillo
Client ID: SD-320-A
Service code: CA-SDP 320 (Community Living Supports)

Goals:
- goal_meal_planning: Plan and prepare a simple weekly meal with decreasing prompts.
- goal_laundry: Complete a laundry cycle independently.
- goal_schedule: Keep a personal weekly schedule up to date.

Notes: Robin prefers written checklists on the fridge.
`),
    doc("drv_sd320a_auth", "SD-320-A Authorization", "authorization", "2026-08-01T16:30:00.000Z", `
AUTHORIZATION FOR SERVICES — ${SYN}
Auth #: AUTH-SYN-SD320A-01
Funding: Regional Center — SDP spending plan
Service: SDP 320 Community Living Supports
Rate: $38.50 per hour
Authorized minutes per month: 1800
Valid: 08/01/2026 - 07/31/2027
FMS: Example FMS
`),
    doc("drv_sd320a_note_1", "SD-320-A Session note 2026-11-11", "previous_note", "2026-11-11T18:40:00.000Z", `
Previous session note — ${SYN}
2026-11-11, 09:00–10:30, SDP 320.
Robin sorted lights and darks and started the washer with one verbal prompt (goal_laundry).
Wrote two dinners on the fridge plan (goal_meal_planning).
`),
    doc("drv_sd320a_assess", "SD-320-A Daily living assessment", "assessment", "2026-07-25T17:00:00.000Z", `
DAILY LIVING ASSESSMENT — ${SYN}
Cooking: follows a three-step recipe with picture support.
Laundry: knows the machine; unsure about settings.
Scheduling: uses a paper calendar inconsistently.
`),
  ],
};

// ------------------------------------------------------------------ SD-334-A
const sd334a: DemoDriveFolder = {
  clientRef: "SD-334-A",
  folder: `${ROOT}/SD-334-A - Jordan Mendez`,
  documents: [
    doc("drv_sd334a_plan", "SD-334-A Training plan", "service_plan", "2026-09-03T21:00:00.000Z", `
INDIVIDUAL TRAINING AND EDUCATION PLAN — ${SYN}
Participant: Jordan Mendez
Client ID: SD-334-A
SDP service code: 334 Individual Training and Education
Course: money-management skills (curriculum)

Goal goal_budget_tracking — Track weekly spending in a simple budget sheet.
Goal goal_bill_reading — Identify the amount due and due date on a bill.
`),
    doc("drv_sd334a_auth", "SD-334-A Authorization", "authorization", "2026-09-01T15:00:00.000Z", `
SERVICE AUTHORIZATION — ${SYN}
Authorization No.: AUTH-SYN-SD334A-07
Funding source: Regional Center — SDP spending plan
Code: 334
Hourly rate: 52.00 USD/hr
Authorized hours per month: 12
Valid from 2026-09-01 through 2027-08-31
`),
    doc("drv_sd334a_note_1", "SD-334-A Session note 2026-11-12", "previous_note", "2026-11-12T17:55:00.000Z", `
Previous session note — ${SYN}
2026-11-12 09:00–10:00 (SDP 334). Jordan entered four receipts with prompts on each (goal_budget_tracking).
`),
    doc("drv_sd334a_note_2", "SD-334-A Session note 2026-11-13", "previous_note", "2026-11-13T20:05:00.000Z", `
Previous session note — ${SYN}
2026-11-13 11:00–12:00 (SDP 334). Practised reading a phone bill; found the due date, needed help with the amount (goal_bill_reading).
`),
    doc("drv_sd334a_assess", "SD-334-A Learning assessment", "assessment", "2026-08-28T19:00:00.000Z", `
LEARNING ASSESSMENT — ${SYN}
Reads short printed text; prefers worked examples. Uses a calculator app confidently.
`),
  ],
};

// ------------------------------------------------------------------ SD-331-A
const sd331a: DemoDriveFolder = {
  clientRef: "SD-331-A",
  folder: `${ROOT}/SD-331-A - Casey Nguyen`,
  documents: [
    doc("drv_sd331a_plan", "SD-331-A Service plan", "service_plan", "2026-07-15T18:30:00.000Z", `
SERVICE PLAN — ${SYN}
Participant: Casey Nguyen
Client ID: SD-331-A
SDP service code: 331 — Community Integration Supports

Goals
  goal_library_card) Use the public library independently, including checking out items.
  goal_social_group) Join a community interest group of the participant's choice.
`),
    doc("drv_sd331a_auth", "SD-331-A Authorization", "authorization", "2026-07-10T16:00:00.000Z", `
AUTHORIZATION — ${SYN}
Authorization number: AUTH-SYN-SD331A-02
Funding source: Regional Center — SDP spending plan
SDP service code: 331 Community Integration Supports (billed hourly by agreement)
Hourly rate: $41.25
Authorized: 32 hours per month
Valid from: 2026-07-01
Valid to: 2027-06-30
`),
    doc("drv_sd331a_note_1", "SD-331-A Session note 2026-11-12", "previous_note", "2026-11-12T21:10:00.000Z", `
Previous session note — ${SYN}
2026-11-12 11:00–13:00 (SDP 331). Casey asked library staff about a board game club (goal_social_group).
`),
    doc("drv_sd331a_assess", "SD-331-A Community assessment", "assessment", "2026-07-01T17:00:00.000Z", `
COMMUNITY PARTICIPATION ASSESSMENT — ${SYN}
Enjoys quiet venues; uses the bus with a companion; interested in games and reading.
`),
  ],
};

// ------------------------------------------------------------------ SD-335-A
const sd335a: DemoDriveFolder = {
  clientRef: "SD-335-A",
  folder: `${ROOT}/SD-335-A - Morgan Ellis`,
  documents: [
    doc("drv_sd335a_plan", "SD-335-A Employment support plan", "service_plan", "2026-06-30T20:00:00.000Z", `
EMPLOYMENT SUPPORTS PLAN — ${SYN}
Participant: Morgan Ellis
Client ID: SD-335-A
SDP service code: 335 (Employment Supports — job coaching)
Worksite: Example Grocery, stocking shift

GOALS
• goal_task_list – Follow the shift task list with fewer coach prompts.
• goal_break_time – Return from breaks on time using a phone timer.
`),
    doc("drv_sd335a_auth", "SD-335-A Authorization", "authorization", "2026-06-25T16:00:00.000Z", `
AUTHORIZATION — ${SYN}
Authorization number: AUTH-SYN-SD335A-04
Funding source: Regional Center — SDP spending plan
SDP service code: 335 Employment Supports
Hourly rate: $47.80
Authorized: 24 hours per month
Valid from: 2026-07-01
Valid to: 2027-06-30
`),
    doc("drv_sd335a_note_1", "SD-335-A Session note 2026-11-11", "previous_note", "2026-11-11T23:10:00.000Z", `
Previous session note — ${SYN}
2026-11-11 13:00–15:00 (SDP 335). Five prompts to move to the next task (goal_task_list). Back from break on time (goal_break_time).
`),
    doc("drv_sd335a_assess", "SD-335-A Vocational assessment", "assessment", "2026-06-15T18:00:00.000Z", `
VOCATIONAL ASSESSMENT — ${SYN}
Strengths: careful and accurate shelf facing. Support needs: transitions between tasks, time awareness.
`),
  ],
};

export const DEMO_DRIVE_FOLDERS: readonly DemoDriveFolder[] = [c104, sd320a, sd334a, sd331a, sd335a];
