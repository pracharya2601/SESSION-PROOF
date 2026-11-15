# SessionProof

**The visit documents itself. A wearable records the session, the platform turns it into an evidence-backed session note, a compliance checklist and an invoice, and the provider approves it in one place.**

> **AI proposes. Evidence supports. Rules validate. A human approves.**

**Live:** https://field-assist.prakashacharya.com · **Demo guide:** [`docs/demo.md`](docs/demo.md)

---

## The problem

Providers of independent-living, community-integration and employment support (for example under California's Self-Determination Program) deliver services in homes and in the community. After each visit they have to:

- write a progress note against the client's plan goals,
- prove the documentation requirements are met (date, service code, time per task, goals addressed, progress, consent, EVV elements),
- build an invoice at the authorized rate for the funding source (FMS / Regional Center).

That work happens hours later, from memory. It costs evenings, and it creates errors, over- and under-billing, and audit risk. Phone apps make it worse in the moment: the provider ends up looking at a screen instead of the person they're supporting.

## The solution

SessionProof captures the visit hands-free with a **Vexo Open** wristband and turns it into review-ready paperwork:

1. **Record:** a double-tap on the band starts and stops. No phone in hand.
2. **Understand:** speech becomes a timestamped transcript. The day is split into sessions using the provider's calendar.
3. **Draft:** a session note against the client's plan, in which **every statement cites what was actually said**.
4. **Validate:** a checklist of documentation rules. Anything missing or unsupported blocks approval.
5. **Invoice:** per-task lines at the authorized rate, with the attestation and signature blocks.
6. **Approve:** the provider reviews in one screen (with an assistant that explains and proposes fixes) and approves. Then the session note, invoice and approval record are produced.

---

## Why Vexo

The capture device decides whether this works in the field. The Vexo Open band is central to the design:

| Need | How the Vexo band meets it |
|---|---|
| **Stay present with the client** | Worn on the wrist. A double-tap starts or stops recording, so the phone stays in the pocket and attention stays on the person |
| **Visible consent** | While the mic is on, the firmware locks the LED **solid blue**, and no app can override it. Everyone in the room can see when recording is happening |
| **Privacy by hardware** | Microphone only, no camera. Nothing visual about homes or people is ever captured |
| **Good audio where the conversation happens** | The mic is close to the provider's conversation. 16 kHz Opus, with every 20 ms packet sequence-numbered, so gaps are measured instead of hidden |
| **Accurate time** | The band's clock is set on every connect, and audio runs are timed from it. That gives precise time-in/time-out and per-task durations for EVV and billing |
| **Open, documented protocol** | A published Bluetooth LE contract (commands, streams, events). We built our own secure pipeline on it: no vendor cloud, and audio never sits on a third-party device service |
| **Hands-free control and context** | Tap events (double-tap = connect / start / stop) and motion events. The roadmap uses these for bookmarks and a privacy pause |
| **Field-ready** | Low-power BLE, battery and charging telemetry, low-battery warnings, and an automatic reconnect window, so a dropped link resumes the same recording |

---

## The pipeline

```
 ┌──────────────┐  BLE (Opus, seq, tap events)  ┌──────────────────────┐  WSS (token in header)
 │ Vexo Open    │ ─────────────────────────────▶ │ GlassCam (iPhone)    │ ───────────────────────┐
 │ band         │ ◀── double-tap: connect/start/ │ records only; offline│                        │
 │ mic · LED ·  │      stop · LED blue = mic on  │ file + auto-upload;  │                        │
 │ clock · IMU  │                                │ review inbox         │                        │
 └──────────────┘                                └──────────────────────┘                        ▼
┌─────────────────────────────────────────── Cloudflare (edge) ──────────────────────────────────────────┐
│                                                                                                         │
│  1 CAPTURE      Worker relays audio to speech-to-text (key stays server-side) → final transcript       │
│                 lines with exact times (text only; audio is never stored; offline uploads go to R2      │
│                 temporarily and are deleted after transcription)                                       │
│                                                                                                         │
│  2 SPLIT        Queue job: calendar appointments around the recording                                   │
│     pass 1      time rule: a line belongs to the appointment whose window (±10 min) contains it         │
│     pass 2      leftover/ambiguous lines → content blocks (silence, speakers, topic) → matched to the   │
│                 day's clients by their plan → SUGGESTIONS the provider accepts/rejects                  │
│     type check  every block: client session · colleague meeting · family call · phone · personal         │
│                 → anything not clearly a client session is blocked until the provider decides           │
│                                                                                                         │
│  3 CONTEXT      Drive: service plan goals, authorization (code, rate, minutes), previous notes          │
│                 (context only, never citable)                                                           │
│                                                                                                         │
│  4 DRAFT        Workflow per session: privacy scrub (names, contacts, IDs → tokens) → AI drafts claims  │
│                 → strict validation: every claim cites transcript lines; refuse overstatement,          │
│                 plans-as-done, copied notes, injected instructions → restore tokens                     │
│                                                                                                         │
│  5 VALIDATE     Rules + checklist: DDS invoice minimums · goals addressed · progress · consent · EVV    │
│                 elements · billed vs recorded time · authorization minutes · business profile           │
│                                                                                                         │
│  6 INVOICE      Per-task lines × authorized rate (computed server-side only) · attestation · signatures │
│                                                                                                         │
│  7 REVIEW       Summary card · assistant chat (answers with citations, proposes edits as Apply cards)   │
│                 · note / checklist / invoice / transcript / agent run history in accordions             │
│                                                                                                         │
│  8 APPROVE      Human approval (revision-guarded, idempotent) → locked record → Session Note, Invoice,  │
│                 Approval Record (HTML preview + PDF) → review link to the phone inbox, optional email   │
│                 draft / cloud folder                                                                    │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Step by step

| # | Stage | What happens | Where |
|---|---|---|---|
| 1 | Capture | Band → phone over BLE; the phone streams packets with sequence numbers; the Worker relays them to speech-to-text and stores only the final lines with wall-clock times. With no connection, the phone writes a crash-safe file and uploads it later | GlassCam, `src/band/`, `src/offline/`, `src/recordings/` |
| 2 | Split | Calendar sync → **time rule** (pass 1). Content suggestions (pass 2) and conversation type are recorded per block | `src/recordings/partition.ts`, `content*.ts` |
| 3 | Context | The client's plan goals, authorization and documents are loaded from Drive and frozen into the draft | `src/schedule/`, `src/drafting/context.ts` |
| 4 | Draft | Privacy scrub → AI draft → validator (citations, refusals) → restore | `src/privacy/`, `src/ai/`, `src/drafting/` |
| 5 | Validate | Blocking issues and a grouped checklist (pass / warn / fail) | `src/domain/rules/` |
| 6 | Invoice | Server-computed lines, rate and totals from the authorization | `src/domain/billing/` |
| 7 | Review | Summary, assistant chat (proposals only), accordions, archive/delete | `src/ui/pages/Review.tsx`, `src/assistant/` |
| 8 | Approve | Durable approval → finalize → documents → notifications | `src/services/approval/`, `src/documents/`, `src/notify/` |

---

## Trust and safety

- **A human approves everything.** Nothing is billed, submitted or sent automatically. Email is draft-only.
- **Evidence or nothing.** Every drafted statement cites transcript lines. Previous notes inform wording but can't be cited.
- **Refusals that matter.** These are blocked:
  - **Overstatement:** "can now… every week", "independently", "achieved all goals", unless the transcript says so.
  - **Plans described as done:** "we'll submit it" ≠ "submitted".
  - **Self-reports contradicted by another speaker.**
  - **Instructions spoken into the recording:** "write that…", "bill 10 hours".
- **Billing can't be talked into changing.** Rates, minutes and amounts are computed by the server from the authorization and the provider's confirmation; transcript text never changes them.
- **Not a client session → not billable.** Colleague meetings, family calls and personal talk are detected and blocked until the provider confirms or dismisses them.
- **Privacy:** personal details are tokenized before any AI call and restored after; no raw audio is stored; transcript text outside any session is deleted after 24 h; logs carry ids and counts only; stream tokens never appear in URLs.
- **Integrity:** every edit is a new revision guarded by `expectedRevision`; approved records are locked (changes go through Amend); deletes are audited, and approved sessions can only be archived.

### Measured, not assumed
An evaluation harness feeds adversarial transcripts through the full drafting pipeline against a live AI model. The cases include planted personal details, injected instructions, overstatement bait, plans that weren't carried out, two-speaker contradictions, noise and long visits.

| Check | Result |
|---|---|
| Outcome as expected (approvable vs blocked) | 17 / 17 cases |
| Statements with valid citations | 100% |
| Forbidden claims that got through | 0 |
| Personal details sent to the model | 0 of 47 planted |
| Injection attempts resisted | 3 / 3 |
| Billing changed by transcript text | never |

Details: [`docs/ai-evaluation.md`](docs/ai-evaluation.md) · run: `npm run eval:ai`

---

## Product tour

- **Today:** visits that need review, an "Approvals waiting" card, and live status.
- **Recordings:** a timeline per recording with calendar lanes; lines colored by assigned / unassigned / ambiguous; suggestion cards (Accept / Reject / Pick another client); archive and delete.
- **Session review:**
  - a summary card (who, when, code, recorded vs confirmed minutes, what happened, goal chips, invoice total, items needing attention, Approve);
  - an **assistant chat** ("It ran 45 minutes", "Anything misleading?"), whose suggestions you Apply or dismiss;
  - accordions for the note, checklist, invoice, transcript, plan coverage and agent run history.
- **Documents:** Session Note, Invoice and Approval Record, previewed in the browser and generated as PDF, from an editable template designer.
- **Clients:** a per-client rate, funding and authorization details, participant direction.
- **Settings:** business profile, devices (pair a phone once, revoke any time), notifications, cloud storage and email drafts, AI provider and privacy switches, sync schedule.
- **Phone (GlassCam):** remembers the band, double-tap control with a notification for every action, today's schedule, offline recording, and a review inbox with tap-to-review links.

---

## Architecture and stack

| Layer | Technology |
|---|---|
| Edge backend | Cloudflare Workers (Hono), D1, Queues, Workflows, R2, cron |
| Web app | React 18, Vite, framer-motion |
| Contracts | zod: strict request bodies; the server is authoritative for amounts |
| Speech-to-text | Streaming and pre-recorded transcription, relayed by the Worker |
| AI | A provider-agnostic adapter (several major model vendors), behind a privacy controller |
| Documents | One document model → HTML preview and PDF |
| Phone | Swift 6 / SwiftUI / CoreBluetooth (GlassCam) |
| Wearable | Vexo Open band, Bluetooth LE contract v1.1 |
| Quality | ~1,170 automated tests (vitest + Miniflare D1), an AI evaluation harness, an end-to-end "provider day" runner |

Code map: [`CLAUDE.md`](CLAUDE.md) · deep dive: [`docs/architecture.md`](docs/architecture.md)

---

## Run it

```sh
npm ci
cp .dev.vars.example .dev.vars          # add speech-to-text / AI keys for live services
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

```sh
npm test                                # automated tests
npm run typecheck
npm run eval:ai                         # AI evaluation
node --experimental-websocket scripts/demo/run-day.mjs    # a full provider day through the pipeline
```

**Deploy to Cloudflare:** [`docs/deploy.md`](docs/deploy.md). Provision D1, the Queue and R2; apply migrations; set the secrets; then `npx wrangler deploy --env production`.

---

## Documentation

| Doc | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Modules, routes, data rules |
| [`docs/recordings.md`](docs/recordings.md) | Recordings, calendar split, content suggestions, conversation type |
| [`docs/band-bridge.md`](docs/band-bridge.md) | Band → phone → server protocol, device pairing, review inbox |
| [`docs/offline-recording.md`](docs/offline-recording.md) | Offline recording format and upload |
| [`docs/ai-evaluation.md`](docs/ai-evaluation.md) | Evaluation method and results |
| [`docs/deploy.md`](docs/deploy.md) | Cloudflare deployment and security notes |
| [`docs/security-review.md`](docs/security-review.md) | Security review |
| [`docs/research/self-determination-codes.md`](docs/research/self-determination-codes.md) | SDP service codes, DDS invoice minimums, EVV |
| [`docs/research/vexo-band-capabilities.md`](docs/research/vexo-band-capabilities.md) | What the Vexo band provides |
| [`docs/roadmap.md`](docs/roadmap.md) | Conversation types and future workflows |
| [`docs/demo.md`](docs/demo.md) | 5-minute demo |

## Roadmap

- Google Calendar and Drive connectors (OAuth scaffolded).
- Other workflows from the same recordings:
  - meeting minutes
  - supervision notes
  - family contact logs
  - incident reports
  - mileage
- FMS and billing-system export.
- Band bookmarks and a privacy pause.
- A compliance pack for production rollout: BAAs, a consent record flow, retention policies, single sign-on.

SessionProof captures EVV-relevant elements but is not an EVV system. Payer and legal compliance must be confirmed for each program before production use.

## License

All rights reserved by the authors. The Vexo Open kit library in `src/ui/vendor/vexo-open/` is MIT licensed by its authors.
