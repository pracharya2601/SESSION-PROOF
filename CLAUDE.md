# Vexo Field Assistant

Turns evidence from a field visit (transcript) into a session note, progress record, plan coverage, checks, time summary and a draft invoice. **AI proposes → evidence supports → rules validate → a human approves.** Nothing is billed or sent: email is draft-only, the user presses Send.

Demo with synthetic data only (client `C-104`, provider `provider_demo_001`). Evidence comes from fixtures, or from a **Vexo Open band** recording (Bluetooth wristband mic → Deepgram, or a simulated transcript in dev). The iPhone bridge is GlassCam (`~/Desktop/megent`, a separate project).

## Stack
One Cloudflare Worker: Hono API, cron, queue consumer and `SessionWorkflow`, with D1 and static assets. React 18 + Vite SPA (hash routes, framer-motion, lucide-react). zod contracts. vitest + Miniflare D1. pdf-lib. wrangler 4.86. npm.

## Commands
```sh
npm run db:migrate:local   # after adding a migration
npm run dev                # build UI + wrangler dev on :8787 (cron: add --test-scheduled, then GET /__scheduled)
npm run dev:ui             # vite on :5173 with hot reload, proxying to :8787
npm test                   # all vitest suites (keep green)
npm run typecheck          # tsc --noEmit (keep clean)
npm run build              # vite build + wrangler dry-run bundle
npm run deploy             # typecheck + build + wrangler deploy --env production
```
Dev login: `demo.provider@example.invalid` (an empty DB auto-seeds). Review → **Reset demo session (dev)** gives you a fresh draft.

## Map
| Area | Where |
|---|---|
| Contracts (zod, source of truth) | `src/contracts/` (`schemas.ts` v1, `v2.ts`, `v3.ts`, `ids.ts`) |
| Repository interface / D1 impl | `src/db/repository.ts` / `src/db/d1.ts`, SQL in `migrations/` |
| Composition root | `src/index.ts` (fetch, scheduled, queue, workflow deps) |
| HTTP routes | `src/api/*` mounted by `src/api/index.ts` |
| Workflow | `src/workflow/run.ts` (steps), `src/workflow/index.ts` (class) |
| Queue / cron jobs | `src/jobs/index.ts` |
| Pure domain (match, docs, rules, billing, bundle) | `src/domain/` |
| Review / approve / amend | `src/services/approval/` |
| AI adapter (anthropic/openai/gemini/mistral) + PII scrubber | `src/ai/`, `src/privacy/` |
| Documents (one DocModel → HTML preview + PDF) | `src/documents/`, `src/services/documents/` |
| Cloud (Drive/OneDrive, Gmail/Outlook drafts) | `src/connections/`, `src/integrations/cloud/`, `src/services/delivery/` |
| Clients + rates, run history | `src/clients/`, `src/history/` |
| Band visits (Vexo band → transcript → evidence) | `src/band/`, `src/api/visits.ts`, UI `#/visit`; protocol in `docs/band-bridge.md` |
| UI | `src/ui/` (`pages/`, `components/`, `design/`, `api.ts`) |
| Tests | `src/**/*.test.ts`, `tests/integration/`, harnesses in `tests/e2e/` |

More detail: `docs/architecture.md` · band/bridge: `docs/band-bridge.md` · run/deploy: `docs/runbook.md` · OAuth/AI keys: `docs/integrations.md` · demo script: `docs/demo.md` · security: `docs/security-review.md` · original spec: `astro_handoff.md`.

## Invariants (don't break)
- **Server is authoritative.** Amounts, rates and blockers are computed server-side. Request bodies are `.strict()` and never carry provider ids or amounts.
- **Revisions guard everything.** Review, approve and amend take `expectedRevision`, and a stale one returns 409. Approval is durable plus an idempotency key. Finalize is idempotent.
- **Deterministic IDs** (`src/contracts/ids.ts`): workflow id `wf-<session>-r<processingRevision>`. Never reuse a processing revision, and dev reset keeps it.
- **Approved = locked.** Changes go through Amend: the old final moves to `superseded_finals` and the new revision is re-approved.
- **Frozen at the right time.** The client rate is frozen into the draft. The client snapshot is taken at finalize, and documents for a final always use the snapshot.
- **Privacy.** Every live inference call goes through `src/privacy` (tokenize → infer → restore). Logs and run events carry ids, counts and codes only, never transcript text, names, tokens or emails.
- **Workflow step results return ids only.** Data is written to D1 inside the step.
- **Ownership.** Every query is scoped to the actor's `providerId`, and another provider's data returns 404.
- **Composition changes need harness changes.** `tests/e2e/v2-harness.ts` and `v3-harness.ts` mirror `src/index.ts` wiring.

## Gotchas
- `run_worker_first` must list `/api/*`, `/auth/*`, `/__scheduled`, or the SPA fallback swallows them. `/cdn-cgi/handler/scheduled` returns 500; use `/__scheduled`.
- The vite proxy uses regex keys (`^/api/`), because a plain `/api` also catches `/api.ts`.
- A new migration has to be applied to the dev DB (`npm run db:migrate:local`), or you'll see 500s.
- `cloudflare:workers` is stubbed in tests (`scripts/platform/cloudflare-workers-stub.ts`). Test workflow logic through `runSessionWorkflow` with a fake step.
- `wrangler dev` uses the system clock, so the 2026-11-13 fixture appointment is only discoverable within the lookback window.
- `npm run dev` rebuilds `dist/client`, and a page reloaded mid-build can be blank. Reload again.
