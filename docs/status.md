# Status and handoff (2026-11-14, night)

Read this first in a new session. CLAUDE.md is the map; this is *where we are*.

## Product
**SessionProof** (name final). Repo: `github.com/pracharya2601/SESSION-PROOF` (public, `main`). Hackathon submission is due on Devpost by **6:00 PM PT, Nov 14 2026**. Submission text: `docs/devpost.md`. The pitch and voiceover scripts are deliberately **not** in the repo.

## Live
- `https://field-assist.prakashacharya.com` runs Worker `vexo-field-assistant-production` on the owner's Cloudflare account. **AUTH_MODE public** (the owner's decision: no login, `PUBLIC_PROVIDER_ID=provider_demo_001`).
- Deployed: commit `b00399d`, version `ca939220`. Everything is live: recordings and calendar split, content suggestions and conversation type, drafting, checklist, invoice, review chat, archive/delete, real document templates and the business profile.
- Production vars: `EXTRACTION_MODE live`, `AI_PROVIDER openai`, `AI_MODEL gpt-4.1`, R2 `vexo-audio-tmp-production`, `DEMO_CALENDAR_NOW_SLOT 1`, `DEMO_EXTRA_EVENTS` (C-104 at 5:05–5:15 PM PT on Nov 14).
- Secrets: SESSION_SECRET, TOKEN_ENCRYPTION_KEY, DEEPGRAM_API_KEY, OPENAI_API_KEY. **Rotate Deepgram and OpenAI** (both were pasted in chat).
- Rollback: `npx wrangler deployments list --env production`, then `npx wrangler rollback <version> --env production`.
- The Mac may cache an old DNS miss for the domain. Pass `--resolve field-assist.prakashacharya.com:443:104.21.34.170` directly to curl (don't put it in a shell variable), or flush DNS.

## Real band test results (Nov 14, production)
- 24 recordings in production. The 5:05 PM C-104 visit (3 min, 0 packets lost, 28 lines) split into one session, was drafted with refusals, and was **approved and finalized** (`sess_86280350…`).
- Waiting for review: `sess_8e1bd382…` (the 33-min recording at 7:07 PM, 100 lines; the best one for the video) and `sess_00aeeba8…`.
- 14 short recordings have no transcript (accidental taps or silence): archive them before filming. The 8:03 PM recording lost about two-thirds of its audio: keep the phone close and the app in the foreground.

## iPhone (GlassCam, `~/Desktop/megent/GlassCam`, NOT under git; backups in an old session scratchpad)
- Installed on the owner's iPhone 15 (`00008120-001170E422B9A01E`) and paired to production. It has record-only mode, hands-free double-tap (connect → start → stop, with notifications), the remembered band, the offline file fallback, the review inbox and the stream token in the header.
- For the demo, `GlassCamApp.showGlassesTab = false` and `BandVisitView.showDeveloperSections = false`. The navigation title is "SessionProof".
- Install: `xcodebuild … -destination 'id=00008120-001170E422B9A01E' -allowProvisioningUpdates build`, then `xcrun devicectl device install app …`. App args go after `--`.

## Local
- Dev server: `npx wrangler dev --port 8787 --ip 127.0.0.1 --test-scheduled`. `.dev.vars` has live OpenAI and Deepgram keys, and its origins are set to 127.0.0.1 for the USB bridge.
- Tests: run with `--maxWorkers=2`, since parallel Miniflare runs can fail with EADDRNOTAVAIL. Expect about 1,170 tests.

## Owner to-dos
1. Live site: fill in Settings → Business profile (approval of new sessions is blocked until it is filled).
2. Record the video (walkthrough on `sess_8e1bd382…`) and complete the Devpost form, including the sponsor tracks.
3. Rotate the Deepgram and OpenAI keys.

## Open items (code)
- The review page has no "Confirm client session / Dismiss" buttons yet; they are only on the Recordings page.
- `minutesUsedThisMonth` is not implemented.
- Recordings with 0 segments could be auto-archived or hidden.
- Email sending (Resend or Email Routing); real Google Calendar/Drive; login back on before any real client data (docs/roadmap.md).
