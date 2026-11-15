# Devpost submission: SessionProof

## Tagline
Hands-free, evidence-backed session notes and invoices for community support providers: double-tap a Vexo band, and the visit documents itself, for a human to approve.

## Why Vexo
The band makes hands-free capture work in the field:
- **Present with the client:** a double-tap on the wrist starts and stops recording; no phone in hand.
- **Visible consent:** the firmware locks the LED blue whenever the mic is on.
- **Privacy:** microphone only, no camera.
- **Accurate timing:** sequence-numbered audio and a settable clock, for exact time-in/time-out.
- **Open protocol:** we built our own secure pipeline on it, with no vendor cloud.

## Inspiration
Independent-living and community-support providers spend evenings on paperwork: a progress note per visit, a checklist of documentation rules, and an invoice per funding authorization. Notes get written from memory, and that's where errors, over-billing and audit risk come from. We wanted the visit itself to become the record, with proof, while a person still decides.

## What it does
- **Records hands-free.** The provider wears a Vexo Open band. Double-tap to connect, double-tap to start, double-tap to stop. The phone (GlassCam app) only records; it doesn't need to know who the visit is with.
- **Transcribes securely.** Audio streams through a Cloudflare Worker to speech-to-text. The key never touches the phone, and audio is never stored. With no internet, the phone records to a file and uploads it later.
- **Splits the day by calendar.** One recording can cover several visits. The server splits it into sessions by the provider's calendar. Leftover time gets content-based suggestions (for example "this looks like SD-334-A, unscheduled, 88%") that the provider accepts or rejects.
- **Knows a visit from a chat.** Every block is classified: client session, colleague meeting, family call, phone call or personal. Anything that isn't clearly a client session is blocked until the provider confirms or dismisses it.
- **Drafts with proof.** An AI drafts the session note against the client's service plan (from Drive), and every claim cites transcript lines. Overstatements ("can now… every week"), plans described as done, and injected instructions ("write that…", "bill 10 hours") are refused.
- **Builds the checklist and invoice.** DDS invoice minimums, plan goals, consent, EVV elements, billed vs recorded time, and per-task invoice lines at the authorized rate.
- **One review screen with an assistant.** Summary card, chat ("it ran 45 minutes", "anything misleading?"), suggested fixes as Apply/Edit cards, and the agent run history tucked into accordions. The chat can't approve and can't change rates.
- **Approve, then documents.** A human approves. A session note, an invoice and an approval record are generated as PDFs, and a review link goes to the phone inbox.

## How we built it
- **Cloudflare:** Workers (Hono) with D1, Queues, Workflows, R2 and cron. A durable workflow per session, with deterministic ids, guarded revisions and idempotent approval.
- **Speech-to-text:** live streaming through a Worker WebSocket relay, plus pre-recorded transcription for offline uploads. Diarized speakers.
- **A provider-agnostic AI adapter** (several major model vendors) behind a privacy controller that tokenizes personal details before every model call.
- **Vexo Open band:** a native CoreBluetooth client implementing contract v1.1 (GET_INFO, TIME_SET, STREAM_START, Opus AUDIO frames, tap EVENTs), with remembered-band auto-reconnect and hands-free double-tap control.
- **React + Vite** web app. One document model renders both the HTML preview and the PDF.
- **Tested:**
  - about 1,170 automated tests
  - an AI eval harness of 17 adversarial cases, run against a live model
  - an end-to-end "provider day" runner covering 6 scripted situations

## Challenges
- **The band's audio** has no timestamps and drops packets. We rebuilt each packet's time from the band clock and its sequence number, and track loss honestly.
- **Venue Wi-Fi isolates devices.** We built a USB reverse tunnel (usbmuxd) from the phone to the Mac dev server, then moved everything to Cloudflare.
- **The AI tests found real failures.** A smaller model cited an injected line as its own proof ("can now shop alone every week"). We added instruction detection, completion and negation checks, and stricter progress rules; afterwards every case came out as expected (17/17).
- **"Is this even a client visit?"** A calendar slot doesn't prove it, so we added conversation-type classification that blocks approval.

## Accomplishments
- A hands-free path from band to approved invoice, running on a real deployment.
- Zero personal details sent to the AI across 47 planted values, and zero forbidden claims leaked in live evals.
- The server computes all billing. In every test, transcript text never changed amounts, rates or minutes.

## What we learned
Evidence-first design changes the AI's job: instead of "write a note", it becomes "propose claims that cite what was said". Rules and a human then make the call.

## What's next
- Real Google Calendar and Drive (OAuth is scaffolded).
- Other conversation workflows: team meeting minutes, supervision notes, family contact logs, incident reports.
- FMS and billing exports.
- A compliance pack (BAAs, consent records, login on) before real client data.

## Built with
cloudflare-workers, d1, cloudflare-queues, cloudflare-workflows, r2, hono, typescript, react, vite, deepgram, openai, zod, pdf-lib, swift, swiftui, corebluetooth, vexo-open-band

## Links
- Live demo: https://field-assist.prakashacharya.com
- Code: https://github.com/pracharya2601/SESSION-PROOF

## Sponsor tracks (pick the ones offered at this event)
- **Vexo / hardware track:** the Vexo Open band is the capture device (BLE client, double-tap control, auto-reconnect).
- **Cloudflare:** the whole backend runs on Workers, D1, Queues, Workflows and R2.
- **Deepgram:** live and pre-recorded speech-to-text.
- **OpenAI:** drafting, the review assistant, and the eval harness.

---

## 1-minute video script (backup)
| Time | Show | Say |
|---|---|---|
| 0:00–0:08 | Provider wearing the band, phone in pocket | "Support providers spend hours on paperwork after every visit. SessionProof makes the visit document itself." |
| 0:08–0:18 | Double-tap the band; the phone notification "Recording started" | "Double-tap to record. The phone just records; it doesn't even need to know who the visit is with." |
| 0:18–0:28 | Talk briefly, double-tap; notification "Sent: 1 session (C-104)" | "Speech is transcribed on Cloudflare, and the calendar splits the day into sessions." |
| 0:28–0:42 | Review page: summary card, cited note, checklist, invoice; chat "it ran 45 minutes" → Apply | "Every claim cites what was said. Overstatements are refused. The checklist and invoice are built from the plan and the authorization." |
| 0:42–0:52 | Approve → invoice PDF | "A human approves, and the note, invoice and approval record are ready." |
| 0:52–1:00 | Recordings page: colleague chat flagged | "And a chat with a colleague is never billed as a visit. AI proposes, evidence supports, rules validate, a human approves." |
