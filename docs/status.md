# Status and handoff (2026-11-14, evening)

Read this first in a new session. CLAUDE.md is the map; this is *where we are*.

## Live
- `https://field-assist.prakashacharya.com` — Cloudflare account of the owner, Worker `vexo-field-assistant-production`, D1 `vexo-field-assistant` (`fcbf44f5-…`), queue `vexo-session-processing`. **AUTH_MODE public** (owner decision; no login). Rollback: `npx wrangler deployments list --env production`, then `npx wrangler rollback <version> --env production`.
- Deployed: everything up to commit `07f7abb` (dashboard perf fix, version `324c688c…`). **Not deployed yet:** calendar/Drive, recordings + split, drafting/checklist/invoice, review chat, archive/delete, guardrail fixes, live AI. Production `EXTRACTION_MODE` is still `fixture`; `OPENAI_API_KEY` secret is already set (switch to `live` + `AI_PROVIDER=openai`, `AI_MODEL=gpt-4.1` on the next deploy). Migrations 0010–0014 must be applied remotely (`npm run db:migrate:remote`) before deploying; the R2 bucket for offline audio (docs/offline-recording.md §5) is not created yet.
- Secrets in production: SESSION_SECRET, TOKEN_ENCRYPTION_KEY, DEEPGRAM_API_KEY, OPENAI_API_KEY. **Rotate Deepgram + OpenAI keys** (both were pasted in chat).

## Local
- Dev server: `npx wrangler dev --port 8787 --ip 127.0.0.1 --test-scheduled` (`.dev.vars`: live OpenAI gpt-4.1, Deepgram, origins = 127.0.0.1 for the USB bridge).
- The dev server hot-reloads on every file save; reloads cut open WebSocket streams.

## iPhone (GlassCam, `~/Desktop/megent/GlassCam`, NOT under git; backups in the session scratchpad)
- Installed on the owner's iPhone 15: hands-free + remembered band (paired to production). **Not installed yet:** record-only mode (no client picker), offline file fallback, review inbox, token-in-header change.
- Install: `xcodebuild … -destination 'id=00008120-001170E422B9A01E' -allowProvisioningUpdates build` then `xcrun devicectl device install app …`.

## Built, waiting for merge/commit (uncommitted in the working tree)
Recordings + calendar split (pass 1), demo calendar/Drive, drafting/checklist/invoice, review summary + chat, AI eval harness, flaky test fix.

## In flight (parallel agents, may still be editing)
| Area | Files |
|---|---|
| Guardrail fixes from AI evals | src/domain/rules, src/drafting, src/ai, src/privacy, evals |
| Content split (pass 2) + conversation type | src/recordings/content*, partition.ts, migration 0014 |
| Archive/delete + Recordings page | src/api/archive.ts, migration 0013, src/ui/pages/Recordings*, src/ui/components/recordings |
| Stream token out of URLs | src/api/visits.ts + recordings.ts stream routes, src/band/token.ts, GlassCam VisitStreamer |
| Demo day scripts + end-to-end runner | fixtures/schedule/day-scripts.ts, scripts/demo/*, docs/demo.md |
| Phone review inbox | GlassCam Band/Inbox*.swift |

## Next steps (in order)
1. When all agents are done: `npx tsc --noEmit -p .`, `npx vitest run` (expect ~1000+ tests), commit.
2. Run the demo day end to end locally (`scripts/demo/run-day.mjs`) — check sessions, conversation types, refusals, invoices.
3. Deploy: apply remote migrations, create the R2 bucket, set production vars (EXTRACTION_MODE live, AI_PROVIDER openai, AI_MODEL gpt-4.1), `npx wrangler deploy --env production`, smoke test.
4. Build + install GlassCam on the iPhone; real band test: double-tap → talk → double-tap → "Sent: 1 session" → review chat → approve → invoice PDF.
5. Open items: `minutesUsedThisMonth`, discovery filter in the repo query (not after the limit), email sending (Resend or Email Routing), login back on before any real client data (docs/roadmap.md).
