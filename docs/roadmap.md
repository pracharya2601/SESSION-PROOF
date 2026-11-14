# Roadmap: information-generation workflows

**Focus now:** client service sessions → **summary, documentation, invoice**, approved by a human.
Everything else a provider records is either kept out of that path or becomes its own workflow later.

## Principle
The calendar says *when*; the content says *what kind of conversation* it was. A recording turns into
billable documentation only when **both** agree it was a client session, **and** a human approves.
Other conversation types never create invoices.

## Now (in progress)
| Step | What | Status |
|---|---|---|
| Time split (pass 1) | Calendar appointments → sessions by timing | built |
| Content split (pass 2) | Leftover/ambiguous/unscheduled → suggestions the provider confirms | in progress |
| Conversation type check | Classify each session block: client session / colleague meeting / guardian or family / phone call / personal / unclear. Not a client session (confidence ≥ 0.6) → blocking checklist item "confirm or dismiss" | in progress |
| Client-session outputs | Session note (cited), checklist (DDS minimums, plan, consent, EVV, time), invoice from the Drive authorization, review chat, approval | built |

## Next: other workflow types (not billed, separate outputs)
| Conversation type | Output | Who approves | Notes |
|---|---|---|---|
| Colleague / team meeting | Meeting minutes + action items (per client mentioned → linked tasks, not evidence) | Provider | Mentions of clients stay internal; never client evidence |
| Supervision / case conference | Supervision note, decisions, follow-ups | Supervisor | Needs supervisor role + sign-off |
| Guardian / family call | Contact log entry (date, who, topic, follow-up) | Provider | Consent of the third party; no billing unless the plan authorizes collateral contacts |
| Phone check-in with the client | Short contact note; billable only if the service code allows remote delivery | Provider | Code/unit rules per program |
| Incident / safety event | Incident report draft (time-stamped facts only) with escalation checklist | Provider + agency | Statutory timelines; never auto-sent |
| Travel / mileage | Mileage log from calendar locations | Provider | Some SDP codes bill mileage |
| Personal / unrelated | Nothing: dropped, text deleted on the 24 h timer | — | Privacy default |

## Later
- Real Google Calendar / Drive connectors (OAuth exists) replacing the demo data.
- Per-program rules packs (other states, other payers), unit rounding per payer.
- FMS / billing system export (SETWorks, Therap) and EVV system hand-off (CalEVV); we stay "not EVV".
- Calendar event types (client appointment vs internal meeting) as a strong first signal.
- Multi-provider agencies: roles, supervisor review queues.
- Compliance pack before any real client data: BAAs (Deepgram, Cloudflare, AI vendor), consent records, retention/deletion, access control (login back on).
