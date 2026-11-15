# SessionProof

**Evidence-backed session notes and invoices for in-home and community service providers, captured hands-free with a Vexo Open wristband.**

> AI proposes. Evidence supports. Rules validate. A human approves.

Providers who deliver independent-living, community-integration and employment support (for example under California's Self-Determination Program) spend hours after every visit writing notes, checking documentation rules and building invoices. SessionProof turns the visit itself into that paperwork:

1. **Record.** The provider wears a Vexo Open band. A double-tap starts and stops recording; nothing else to touch.
2. **Transcribe.** The band's audio streams through the phone (GlassCam app) to a Cloudflare Worker, which proxies it to Deepgram. Only text is kept: audio is never stored.
3. **Split by calendar.** The recording is split into sessions by the provider's calendar. Leftover time gets content-based suggestions, and every block is checked for *what kind of conversation it was* (client session, colleague meeting, family call, personal).
4. **Draft with evidence.** For each session an AI drafts the session note using the client's plan from Drive. Every claim must cite a transcript line; overstatements ("can now… every week"), unfinished plans and injected instructions are refused.
5. **Validate.** Rules produce a checklist: DDS invoice minimums, plan goals, consent, EVV elements, and billed vs recorded time. Blocking items stop approval.
6. **Review in one place.** A summary card, an assistant chat that answers questions with citations and proposes fixes (applied only when the provider clicks), and accordions for the note, checklist, invoice, transcript and agent run history.
7. **Approve → documents.** A human approves. The session note, invoice and approval record are generated as PDFs. A review link is sent to the phone inbox.

---

## Demo

- **Live:** https://field-assist.prakashacharya.com (public demo; synthetic data only)
- **5-minute demo script:** [`docs/demo.md`](docs/demo.md)
- **Synthetic "provider day" end to end:** `node --experimental-websocket scripts/demo/run-day.mjs` (6 scripted situations; results in [`docs/reports/`](docs/reports/))

All people, clients, authorizations and documents in this repository are **fictional**.

---

## Architecture

```
Vexo Open band ──BLE──▶ GlassCam (iPhone)            ──WSS──▶ Cloudflare Worker (Hono)
  Opus 16 kHz mic        records only, offline file           ├─ /api/device/*  device-key auth
  double-tap control     fallback, review inbox               ├─ capture socket ─▶ Deepgram (proxy, key server-side)
                                                              ├─ D1 (SQLite)    transcript segments, sessions, audit
                                                              ├─ Queue + Workflow
                                                              │    partition (calendar time → content suggestions)
                                                              │    → privacy scrub → AI draft (OpenAI / Anthropic / Gemini / Mistral)
                                                              │    → validation + rules → checklist + invoice → NEEDS_REVIEW
                                                              ├─ R2 (temporary offline audio, deleted after transcription)
                                                              └─ React SPA (static assets): review, chat, approve, PDFs
```

| Layer | Tech |
|---|---|
| Edge backend | Cloudflare Workers, Hono 4, D1, Queues, Workflows, R2, cron |
| Web app | React 18, Vite 6, framer-motion, lucide-react |
| Contracts | zod (every request is `.strict()`; the server computes all amounts) |
| Speech-to-text | Deepgram nova-3 (live streaming + pre-recorded for offline uploads) |
| AI drafting | One adapter over OpenAI, Anthropic, Gemini, Mistral; default `gpt-4.1` |
| Documents | One document model rendered as an HTML preview and as a PDF (pdf-lib) |
| Phone | GlassCam (Swift 6, SwiftUI, CoreBluetooth), separate project |
| Tests | vitest + Miniflare D1 (~1,170 tests), AI eval harness, band scenario runner |

Code map: [`CLAUDE.md`](CLAUDE.md) · deep dive: [`docs/architecture.md`](docs/architecture.md)

---

## Trust and safety by design

- **Human approval is mandatory.** Nothing is billed, sent or submitted automatically. Email is draft-only.
- **Evidence or nothing.** Every drafted claim cites transcript lines. Previous notes in Drive are context only and can never be cited.
- **Refusals.** Overstatements, completion claims for things only planned, self-reports contradicted by another speaker, and instruction lines ("write that…", "bill 10 hours") are refused or blocked. See [`docs/ai-evaluation.md`](docs/ai-evaluation.md).
- **Server-authoritative billing.** Rates come from the authorization; transcript text can't change amounts, rates or minutes.
- **Privacy.** Names, contacts, IDs, addresses and dates are tokenized before any AI call and restored after. No raw audio is stored. Transcript text outside any session is deleted after 24 h. Logs carry ids and counts only.
- **Not a client session? Blocked.** Colleague meetings, family calls and personal talk are flagged and can't be approved until the provider confirms or dismisses them.
- **Revisions and audit.** Every edit is a new revision guarded by `expectedRevision`. Approved records are locked; changes go through Amend. Deletes are audited, and approved sessions can only be archived.

### AI evaluation (live OpenAI, 17 synthetic cases)
| | gpt-4.1 | gpt-4.1-mini |
|---|---|---|
| Outcome as expected | 17/17 | 17/17 |
| Citation validity | 100% | 100% |
| Forbidden claims leaked | 0 | 0 |
| PII sent to the model | 0 of 47 planted | 0 of 47 |
| Injection attempts resisted | 3/3 | 3/3 |

Run it yourself: `npm run eval:ai` (offline fake model) or `npm run eval:ai -- --mode live --provider openai --model gpt-4.1`.

---

## Run locally

Requirements: Node 20+, npm.

```sh
npm ci
cp .dev.vars.example .dev.vars          # add DEEPGRAM_API_KEY / OPENAI_API_KEY to use live services
npm run db:migrate:local
npm run dev                             # http://localhost:8787  (dev login: demo.provider@example.invalid)
```

Without keys everything still runs: transcription is simulated, and drafting uses a rule-based demo drafter. Both are clearly labelled in the approval record.

```sh
npm test                                # vitest (use --maxWorkers=2 on a busy machine)
npm run typecheck
npm run eval:ai                         # AI evaluation (fake model)
node --experimental-websocket scripts/band/stream-smoke.mjs   # stream fake band audio end to end
```

## Deploy (Cloudflare)

See [`docs/deploy.md`](docs/deploy.md): D1 + Queue + R2, migrations, secrets (`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`), then `npx wrangler deploy --env production`.

## Hardware: Vexo Open band

- Bluetooth LE wristband with a microphone, motion sensor and LED. Contract v1.1 (firmware 1.1.0).
- GlassCam connects by exact band name and remembers the band. It reconnects automatically within the band's 2-minute window.
- **Double-tap: connect → start → stop.** Every action is confirmed by a notification.
- Browser path: Chrome or Edge can record over Web Bluetooth or USB (`#/visit`).
- Protocol and bridges: [`docs/band-bridge.md`](docs/band-bridge.md), [`docs/usb-bridge.md`](docs/usb-bridge.md). Capability research: [`docs/research/`](docs/research/).

## Documentation

| Doc | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Modules, routes, data rules |
| [`docs/recordings.md`](docs/recordings.md) | Recordings, calendar split, content suggestions, conversation type |
| [`docs/band-bridge.md`](docs/band-bridge.md) | Band → phone → server streaming protocol, pairing, review inbox |
| [`docs/offline-recording.md`](docs/offline-recording.md) | Offline recording file format and upload |
| [`docs/ai-evaluation.md`](docs/ai-evaluation.md) | Eval harness, results, remaining gaps |
| [`docs/deploy.md`](docs/deploy.md) | Cloudflare deployment, security notes |
| [`docs/research/self-determination-codes.md`](docs/research/self-determination-codes.md) | CA SDP codes, DDS invoice minimums, EVV |
| [`docs/roadmap.md`](docs/roadmap.md) | Conversation types and future workflows |
| [`docs/security-review.md`](docs/security-review.md) | Security review |

## Status and limits

- **Demo stage:** synthetic data only. Before real client data you need: login back on (Cloudflare Access is supported), BAAs with Deepgram, Cloudflare and the AI vendor, a consent record flow, and retention/deletion policies. See [`docs/roadmap.md`](docs/roadmap.md).
- **Not EVV.** SessionProof captures EVV-relevant elements but does not replace CalEVV.
- **Demo calendar and Drive** stand in for Google Calendar and Drive. OAuth connectors are scaffolded.
- **Legal/payer compliance is not certified.**

## License

All rights reserved by the authors unless a license file is added. The Vexo Open kit library vendored in `src/ui/vendor/vexo-open/` is MIT licensed by its authors.
