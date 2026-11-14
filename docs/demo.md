# Demo runbook (handoff §18) — Agent 20

Synthetic data only: provider `provider_demo_001`, client `C-104`, service `DEMO-ILS`,
appointment 2026-11-13 10:00–11:00 America/Los_Angeles (18:00–19:00Z). Not a real visit.

## 1. Outcome label rules (§1.3) — decide BEFORE presenting

Record three dimensions separately, read from `GET /api/health` and the bundle/export `provenance`:

| Evidence | Extraction | Runtime | Label you may claim |
|---|---|---|---|
| fixture | fixture | local | **LOCAL FIXTURE DEMO** — "The local fixture workflow completed." |
| any fixture | any | deployed | **MIXED DEPLOYED DEMO** — "The deployed demonstration uses the following fixtures…" (name them) |
| live | live | deployed | **LIVE DEPLOYED DEMO** — only with real Vexo retrieval + real AI extraction + deployed processing + tested review/approval + finalized export |
| — | — | — | **PARTIAL PROTOTYPE** if any end-to-end step below failed: "These components work; these gates remain open." |

With the default `wrangler.jsonc` (`EVIDENCE_MODE=fixture`, `EXTRACTION_MODE=fixture`, `RUNTIME_MODE=local`)
the only honest label is **LOCAL FIXTURE DEMO**. A single "live" badge is never enough. Do not fake
progress transitions to fit the timing; if a step fails, say so and downgrade the label.

## 2. Pre-demo preparation (§18.1)

```sh
rm -rf .wrangler/state                 # isolated local demo data only — the session can be approved once
npm run db:migrate:local
cp -n .dev.vars.example .dev.vars      # synthetic SESSION_SECRET / TOKEN_ENCRYPTION_KEY
npm run dev                            # builds UI, serves http://localhost:8787
node scripts/e2e/demo.mjs              # optional dry-run on a SEPARATE fresh state; see §5
```

Known prerequisites / limitations (see docs/test-report.md):

- **Bootstrap**: `POST /auth/dev-login` only accepts an already-seeded identity, and `POST /api/dev/seed`
  requires a login. On an empty D1 neither works over HTTP (QA-02a, owners 15/19). Until fixed, the demo
  provider must be created out-of-band before the UI login works.
- **Clock**: `wrangler dev` uses the system clock (`src/index.ts`), not `FIXTURE_CLOCK_NOW`. Discovery only
  finds the 2026-11-13 appointment while the host clock is after 19:00Z that day and within the 7-day
  lookback (until ~2026-11-20). Outside that window sync finds nothing (owner 01/05).
- Queue + Workflow run in Miniflare's local simulation; that is not proof of deployed behaviour (QA-34).

Checklist:
- [ ] Health shows `evidenceMode: fixture`, `extractionMode: fixture`, `runtimeMode: local`; UI mode badges agree.
- [ ] Logged in as `demo.provider@example.invalid`.
- [ ] Initial bundle shows missing progress and unconfirmed duration.

## 3. Two-minute script (§18.2) with expected values

| Time | Action (UI) | Expected evidence |
|---|---|---|
| 0:00–0:15 | Open `http://localhost:8787`. Point at the mode badges (Evidence: fixture, Extraction: fixture, Runtime: local) and the fictional appointment C-104 / DEMO-ILS, 10:00–11:00 LA. | Appointment and service visible; fixture disclosed. |
| 0:15–0:30 | Click **Seed demo data** (idempotent), then **Sync**. | Sync returns 202; status moves SCHEDULED/QUEUED → PROCESSING → **NEEDS_REVIEW** from the real backend (refresh/poll; do not narrate states you have not seen). |
| 0:30–0:50 | Open the session. Walk the Session note, Progress record, Plan coverage, Follow-ups, Sources. | Evidence ids `ev_001`–`ev_005` labelled fixture; follow-up "Provider to bring another route-planning worksheet next session." |
| 0:50–1:10 | Show Plan coverage and Checks. | `goal_transport` addressed, `goal_budget` partially addressed, **`goal_community` unknown** (not invented). Blocking issues: progress statement missing, confirmed duration missing. Billing: **estimate $75.00 (7500 cents), final amount —**. Approve button disabled / server returns 422 if forced. Revision **1**. |
| 1:10–1:30 | Enter progress confirmation `The participant completed the planning task with verbal prompts.` and confirmed duration **90** minutes. Save. | Server returns revision **2**; amount **USD 112.50 (11250 cents)** at 7500 cents/hour; progress shown as provider-confirmed attestation (not transcript-derived); no blockers; Approve enabled. |
| 1:30–1:45 | Approve revision 2. | 202 → "approval recorded, finalization pending", then **COMPLETED** once the Workflow wakes and finalizes. Approval record shows revision 2 and approver `provider_demo_001`. |
| 1:45–2:00 | Download the export (JSON and HTML / print). | Export `finalized.bundleRevision = 2`, `billing.confirmedMinutes = 90`, `billing.amountCents = 11250`, `modes = {fixture, fixture, local}`. HTML shows $112.50 and the fixture disclosure; any markup in content is rendered as text. |

Optional integrity beats (if time): saving again against revision 1 returns **409**; re-clicking Approve
with the same request returns the same approval (no duplicate final record).

## 4. Completion evidence to capture (§18.3)

Build/commit id · `docs/test-report.md` · URL (`http://localhost:8787`) · evidence/extraction/runtime modes ·
completed session id (`sess_` + 24 hex of sha256(provider ⧺ occurrence)) · approved revision 2 · confirmed
90 min · USD 112.50 · export path `/api/sessions/<id>/export?format=json|html` · known limitations above ·
unresolved gates: QA-31/32/33 (live OAuth/MCP/model), QA-34/36 (deployed smoke, real cron).

## 5. Automated checks

- In-process (real modules, Miniflare D1, fake Queue/Workflow, fixture clock): `npx vitest run tests/integration`.
- Black-box against a running dev server: `node scripts/e2e/demo.mjs` (`BASE_URL` to override,
  `POLL_SECONDS` to extend polling). Prints PASS/FAIL per step, the three modes and the outcome label; exits
  non-zero on any failure. Needs a fresh local D1 because the demo session can only be approved once.
