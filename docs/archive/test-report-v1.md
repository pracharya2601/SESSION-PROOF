# Test report (handoff §15.4) — Agent 20

- **Build**: working tree 2026-11-13 (no git; no commit id). `tsc --noEmit` clean; `vite build` OK; `wrangler deploy --dry-run` OK.
- **Runtime**: local only (vitest + Miniflare D1; and `wrangler dev` 4.86 local simulation). Nothing deployed.
- **Evidence mode**: fixture. **Extraction mode**: fixture.
- **Outcome label**: **LOCAL FIXTURE DEMO**. "The local fixture workflow completed." No live or deployed claim is supported.

## Suites run

| Suite | Command | Result |
|---|---|---|
| Whole repo | `npx vitest run` | **20 files, 377 tests, all passed** |
| In-process integration (real modules, fake Queue/Workflow binding, fixture clock) | `npx vitest run tests/integration/flow.test.ts` | 15/15 passed |
| Black-box HTTP against `wrangler dev` (fresh local D1, real local Queue + Workflow simulation, system clock) | `BASE_URL=http://localhost:8799 node scripts/e2e/demo.mjs` | 16/16 steps PASS; exit 0; prints "LOCAL FIXTURE DEMO" |

Demo session from the black-box run: `sess_2433706c4caad45a54c82c4c`. Approved revision 2, 90 confirmed minutes, 11250 cents (USD 112.50), export `/api/sessions/<id>/export?format=json|html`, modes fixture/fixture/local.

Integration-run observations (earlier in the sprint, since fixed by their owners and passing again): partial-evidence variant came out INCOMPLETE (`unknown_evidence`) because its extraction cited ev_004, which the partial evidence did not include (05/10). dev-login on an empty DB returned 401, so the demo could not bootstrap (19). The Workflow entrypoint called `step.do.call(...)` through the RPC stub and threw "RPC receiver does not implement the method call" under `wrangler dev`, which left sessions stuck in QUEUED (14).

## Results

Columns: ID · observed result · evidence (test name / step) · owner if failing · material limitation.

| ID | Result | Evidence | Owner (repair) | Limitation |
|---|---|---|---|---|
| QA-01 build/typecheck | PASS | tsc 0, vite build, wrangler dry-run | | not deployed |
| QA-02 seed twice | PASS | flow "QA-02/11 …": seed ×2 gives 1 session | | |
| QA-02a fresh-DB HTTP bootstrap | PASS | flow "QA-02a"; demo.mjs dev-login on empty DB | | |
| QA-03 normal processing | PASS | flow normal path; demo.mjs NEEDS_REVIEW | | fixture extraction |
| QA-04 missing goal evidence | PASS | goal_community = unknown (flow + demo.mjs) | | |
| QA-05 missing progress blocks | PASS | approve at rev 1 gives 422 | | |
| QA-06 unconfirmed duration | PASS | rev 1 estimate 7500, amount null, canApprove false | | |
| QA-07 60/90 billing | PASS (90) | rev 2 amount 11250; 60-min case only in unit tests (Agent 13, billing.test.ts) | | 60-min not integration-run |
| QA-08 rounding/invalid numeric | NOT RUN (integration) | unit suite only (billing.test.ts, contracts.test.ts) | | |
| QA-09 review update | PASS | PATCH gives rev 2, 11250, canApprove true | | |
| QA-10 stale edit/approval | PASS | stale PATCH 409, stale approve 409, latest unchanged | | |
| QA-11 duplicate queue delivery | PASS | all messages redelivered ×2: 1 workflow `wf-<id>-r1`, rev 1 | | fake Queue in-process |
| QA-12 duplicate approval | PASS | same key gives same approval id; 200 finalized after completion | | |
| QA-13 idempotency key conflict | PASS | same key, different revision gives 409 | | |
| QA-14 notification failure after save | PASS | sendEvent fails once: APPROVED, then dispatch gives COMPLETED rev 2 | | injected in fake binding |
| QA-15 approval around wait | PASS (partial) | lost wake-up, then fresh durable check after the wait ends gives COMPLETED; early-event buffering only exercised implicitly | | true race not reproduced |
| QA-16 wait timeout | PASS | timeout: NEEDS_REVIEW, no approval, no final | | |
| QA-17 finalization retry | PASS | finalizeApproved repeat gives same record; 1 final row | | |
| QA-18 unauthenticated | PASS | 401 on list/detail/sync; demo.mjs 401 | | |
| QA-19 wrong provider | PASS | other provider gets 404 on detail/review/approve/export, empty list, no C-104 leak | | |
| QA-20 forged provider/amount | PASS | non-allowlisted edits 400; providerId in approve 400; rate stays 7500 | | |
| QA-21 cross-origin | PASS | PATCH with foreign Origin gives 403, revision unchanged | | |
| QA-22 ambiguous | PASS | variant ambiguous gives AMBIGUOUS_MATCH, approve rejected | | |
| QA-23 no evidence vs upstream | PASS | no-evidence gives NO_EVIDENCE; upstream-error gives FAILED | | |
| QA-24 invalid extraction/citation | PASS | bad-citation and malformed-extraction give INCOMPLETE, not approvable | | |
| QA-25 transcript injection | PASS | instruction-in-transcript gives NEEDS_REVIEW, rate/rules = config, 90 min gives 11250 | | |
| QA-26 export consistency | PASS | export rev 2, 11250, 90 min, modes = health (flow + demo.mjs) | | |
| QA-27 HTML/script content | PASS | renderExportHtml escapes `<script>`, `<img onerror>`, `onclick`; live HTML has no `<script` | | export only; UI not browser-tested |
| QA-28 browser/log inspection | NOT RUN | logs eyeballed only (ids/counts); no systematic check | | |
| QA-29 fixture labelling | PASS (export/API) | export HTML discloses fixture; provenance fixture/fixture/local | | UI badges not browser-checked |
| QA-30 timezone/midnight | NOT RUN (integration) | unit tests only (07/08) | | |
| QA-03b partial evidence | PASS | variant gives NEEDS_REVIEW, completeness partial, warnings present | | |
| QA-31 live OAuth | NOT RUN | no live account | | live gate open |
| QA-32 live MCP retrieval | NOT RUN | | | live gate open |
| QA-33 live model | NOT RUN | | | live gate open |
| QA-34 deployed smoke (§17.5) | NOT RUN | no deployment exists | 03, 20 | deployment gate open |
| QA-35 scheduled handler | **FAIL / unverified** | `wrangler dev --test-scheduled`, `curl /cdn-cgi/handler/scheduled` gave 500 "exception" with no worker log; `/__scheduled` is caught by the SPA asset fallback | 03 (platform/assets config), 09 | manual Sync path (same discovery + dispatch) works |
| QA-36 real cron | NOT RUN | | 03, 09 | |

## Open items and owners

1. **QA-35** scheduled handler could not be triggered locally (500 "exception"). Owners **03** (wrangler/assets config) and **09**.
2. **Clock dependence** (limitation, not a test failure): `src/index.ts` uses `systemClock`, so under `wrangler dev` the 2026-11-13 fixture appointment is only discoverable within the 7-day lookback after 19:00Z (until about 2026-11-20). §14.1 asks for an injected clock. Owner **01** (or **05**: seed relative to now).
3. Live gates QA-31/32/33 and deployment QA-34/36 remain open. No live or deployed claim is made.
