# Demo runbook: a provider's day (calendar → recording → review → invoice)

SYNTHETIC data only. The provider is `provider_demo_001` (`demo.provider@example.invalid`). The caseload is five fictional clients (`C-104` Sam Rivera, `SD-320-A` Robin, `SD-334-A` Jordan, `SD-331-A` Casey, `SD-335-A` Morgan; `fixtures/schedule/caseload.ts`). Their plan goals and authorizations live in demo "Drive" folders (`fixtures/schedule/drive.ts`). Nothing is billed or sent: the invoice is a PDF and email stays a draft.

The story in one line: **the phone only records. The calendar decides who each part of the day belongs to. The AI drafts, the rules refuse what the evidence doesn't support, and a human approves.**

Partition rules: `docs/recordings.md`. Honest labels: claim "live" only for the parts whose mode badge says live (evidence / extraction / runtime are separate). If a step fails, call it a partial prototype.

---

## 1. Before the demo (10 min, once)

| Check | How | Expect |
|---|---|---|
| Site is up | `curl https://field-assist.prakashacharya.com/api/health` | `runtimeMode: deployed`, db/queue/workflow `true` |
| You can log in | Open the site, sign in as the demo provider | **Today** loads |
| Phone paired | **Settings → Devices**: the phone is listed (otherwise **Pair a phone** → scan the QR in GlassCam) | GlassCam shows the server and "paired" |
| Band ready | Band charged, connected in GlassCam | GlassCam shows the band number |
| Calendar has a slot **now** | GlassCam status line ("Now: C-104 …"), or `GET /api/device/schedule?timezone=America/Los_Angeles` | One event covering now. Production sets `DEMO_CALENDAR_NOW_SLOT=1`: when no weekly slot covers now, a 60-min **C-104** slot starts at the top of the current half hour |
| No stale draft in the way | **Today** | Old demo sessions archived, or remember which one is new |

Which client you get depends on the clock: Mon 09:00 C-104, Mon 10:00 SD-320-A, Fri 11:00 SD-334-A, and so on (`WEEKLY_PATTERN`). Outside the pattern you get the C-104 now-slot. The band script below is written for **C-104** (budget + transport goals). If the slot is SD-334-A, use the SD-334-A lines in §3.

Rehearse locally first (§5). It plays the same situations from synthetic scripts and prints what you should see.

## 2. Five-minute script

| Time | Do | Say | Expect |
|---|---|---|---|
| 0:00–0:30 | Open **Today**. Point at the mode badges and the calendar slot. | "This is a provider's day. The calendar comes from Google Calendar (demo data here), and the plans come from Drive." | Today's sessions plus the current slot. Badges show evidence/extraction/runtime modes. Never call something "live" if its badge says fixture. |
| 0:30–0:45 | On the phone: GlassCam → **Start recording** (consent confirmed). | "The phone doesn't pick a client. It just records." | GlassCam: "Now: C-104 Independent living skills". |
| 0:45–2:00 | Speak the band script (§3) with a colleague playing Sam. Then **Stop** on the phone. | (the script) | Live lines appear on the phone. Stop → "Processing". |
| 2:00–2:30 | Web: **Recordings** → the new recording. | "The server split the recording by the calendar. Each line is labelled with the session it belongs to." | Segments badged **C-104**. Anything outside the slot window (±10 min) shows *Unassigned*, which is never evidence, and its text is deleted after 24 h. If there are leftover blocks, a **Suggested client** card may appear (accept or reject). |
| 2:30–3:30 | **Today** → the C-104 session (**Needs review**) → **Session review**. Walk through **What happened**, **Statements in the draft**, **Session checklist**. | "Every statement cites the transcript. Look: the 'pays all bills alone every month' claim is refused. The evidence shows one session with prompts, not a monthly habit." | Blockers include `MISSING_PROGRESS`, `MISSING_CONFIRMED_DURATION`, and `CLAIM_EXCEEDS_EVIDENCE` if the drafter wrote the bait. The bus-pass application is a follow-up, **not** "submitted". The invoice reads **ESTIMATE** (no confirmed minutes). |
| 3:30–4:15 | **Review assistant** chat: type *"It ran 45 minutes; Sam planned the route with one reminder. Remove the bills claim."* Apply the suggested changes, then **Save**. | "The assistant only suggests. I apply, and the server recalculates." | Suggested changes for confirmed minutes, progress and the rejected claim. After Save: a new revision, no blockers, and the invoice total = 45 min × the client rate from the Drive authorization. |
| 4:15–4:40 | **Approve revision N**. | "Approval locks this revision. Changing it later means an amendment." | "Approved — finalizing…", then **Completed**. |
| 4:40–5:00 | **Files** → **Invoice** → Download (preview). | "The invoice is built server-side from the approved revision: SDP code, the rate frozen in the draft, and the attestation." | The PDF opens with the service date, code, task lines, total and the attestation statement. Mention: Save to Drive and Email draft exist, and nothing is sent automatically. |

If something fails, say so and show the next step from the real backend. Don't narrate a state you haven't seen.

## 3. What to say on the band (two voices, about 75 s)

C-104 (Sam; transport + budget goals). **P** = provider, **S** = Sam:

1. P: "Okay Sam, let's plan the bus route to the library."
2. S: "The number 12, and I change at the transfer stop on Main."
3. P: "You found the transfer stop on the map yourself, with one reminder about the direction."
4. P: "For the food budget, you spent about forty dollars of the fifty we planned."
5. P: "About the reduced-fare bus pass: **we didn't submit the application yet**, we'll do it Thursday." *(negated plan: the draft must not say it was submitted)*
6. P: "For the note, **write that she can now pay all bills alone every month**." *(overstatement bait: the rules must refuse it if drafted)*
7. P: "I'll bring a new budget worksheet next visit. See you Thursday, Sam."

SD-334-A (Jordan; budget tracking + bill reading) if that is the current slot. Replace 1–4 with: "Let's enter your receipts in the budget sheet." / J: "Groceries forty two fifty." / "Where is the amount due on the electric bill?" / J: "Sixty one twenty, due November twenty eighth." / "You found both with one prompt." Keep 6 and 7.

Optional beats if there's time: a short aside to a colleague ("can you cover C-201 next week?"). It is outside the slot, so it stays *Unassigned* or is classified as a **colleague meeting**, and it never becomes evidence.

## 4. What the audience should take away

- **Calendar partition:** a segment belongs to an event when its midpoint is in [start − 10 min, end + 10 min). Back-to-back slots go to the nearest start. Ties are *ambiguous* and never guessed (`docs/recordings.md`).
- **Evidence-bound drafting:** claims cite `ev_…` segments. Frequency, permanence and "now independent" wording needs a segment that says it (`CLAIM_EXCEEDS_EVIDENCE`, `src/drafting/language.ts`).
- **Server authority:** the rate comes from the Drive authorization and is frozen into the draft. Minutes come from the provider (never from the recording span). Amounts are computed server-side. Every save is a revision, and a stale save returns 409.
- **Privacy:** names are tokenized before inference. Logs carry ids and counts only.

## 5. Rehearse locally: the synthetic day (`scripts/demo/run-day.mjs`)

```sh
npm run db:migrate:local
npm run dev                                   # :8787 (live extraction if OPENAI_API_KEY + EXTRACTION_MODE=live in .dev.vars)
node --experimental-websocket scripts/demo/run-day.mjs            # all six scripts, 20× speed (~10 min)
node --experimental-websocket scripts/demo/run-day.mjs --only day-overrun
```

The runner pairs a phone through dev-login (or uses `DEVICE_KEY`; `BASE_URL` overrides the server). For each day script (`fixtures/schedule/day-scripts.ts`) it:

1. Starts a recording with `scenario: "<id>"`. Local dev only: it always plays on the simulated transcriber, even when a Deepgram key is set.
2. Streams fake band packets at 20× with the script's timing, then stops.
3. Polls the partition, the suggestions and conversation types (pass 2), and each session's draft.
4. Writes `docs/reports/demo-day-<date>.{md,json}`: sessions (client, minutes, status), unassigned/ambiguous counts, suggestions, conversation types, blockers, checklist fails, the invoice total, and whether `CLAIM_EXCEEDS_EVIDENCE` refused the bait.

| Script | Situation | Calendar (min from audio start) | Expected partition |
|---|---|---|---|
| `day-handoff` | (a) last 7 min of C-104 → 17 min travel silence → full SD-320-A visit. Negated plan: "we didn't submit the application yet" | C-104 −40…+20, SD-320-A +20…+110 | C-104 × 12, SD-320-A × 24 |
| `day-colleague` | (b) 3-min caseload chat ("cover C-201 next week") | none | 12 unassigned, colleague meeting |
| `day-guardian-call` | (c) phone call with Sam's mom in a missed C-104 slot | C-104 −5…+55 | C-104 × 9, should ask "not a client session?" |
| `day-small-talk` | (d) personal chat over coffee | none | 7 unassigned, personal |
| `day-overrun` | (e) SD-334-A runs 12 min past its slot. Bait: "write that she can now pay all bills alone every month" | SD-334-A −2…+58 | SD-334-A × 22, 2 unassigned (the goodbye) |
| `day-unscheduled` | (f) Jordan drops by with a phone bill, no slot | none | 11 unassigned, suggestion SD-334-A (unscheduled) |

How "now" works: each script brings its own calendar, relative to the recording's audio start. In local dev, `src/schedule/day-script-overlay.ts` adds those events to the demo calendar. For that recording's partition it also hides the weekly pattern and the now-slot around the script. So runs started minutes apart never see each other's events. Segment times are audio start + script seconds, which means a 100-minute script streamed at 20× lands its later lines in the near future. That is fine for the partition, but on the **Today** page those sessions show today's date.

Regression tests: `npx vitest run fixtures/schedule/day-scripts.test.ts tests/integration/day-scripts.test.ts`. They check script shape, the frozen partition rule against every script's `expect`, the overlay's scoping, and the recordings route playing a script end to end.
