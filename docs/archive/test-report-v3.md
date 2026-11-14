# v3 test report (W9)

**Build under test:** the working tree on 2026-11-14, after Agent 01 finished the integration wiring. The project has no git, so there is no commit id.

**Runtime:** local only, using vitest and Miniflare D1 with all four migrations (0001–0004). The Queue and Workflow are the fakes from `tests/e2e/harness.ts`. Outbound HTTP (Google Drive, AI vendors) goes to the recording `FakeCloud` in `tests/e2e/v2-fake-fetch.ts`.

**Not tested:** no real Google account, no real AI vendor, no deployment, no `wrangler dev` run, and no browser tests of the UI.

## Files

| File | Purpose |
|---|---|
| `tests/e2e/v3-harness.ts` | Wraps the v2 harness and copies the v3 wiring from `src/index.ts`. It creates `createRunRecorder(repo, clock)` and passes it to the api, jobs, workflow and delivery deps. It gives the workflow `resolveClient` and gives the extractor `resolveKnownTerms` (built from `clientKnownTerms`). It mounts the clients, templates, documents and runs routers only if `createApi` does not already mount them. `createApi` now mounts all four, so the harness skips that step |
| `tests/integration/v3-flow.test.ts` | 15 tests, ids V3-01 to V3-14 |

The harness makes the clock advance 1 ms on every read, so run events get distinct timestamps. Set `QA_FROZEN_CLOCK=1` to run with the frozen clock instead (see the observations below).

## Results

| ID | Result | Evidence | Owner if failing |
|---|---|---|---|
| V3-01 Seeded client C-104 with funding fields; list, get, search, validation | PASS | Mismatched ref → 400. Partial body → 400. Unknown ref → 404. Cross-origin PUT → 403 | |
| V3-02 Client rate 9000 → draft at $90/hr | PASS | `config.rate` and `billing` show 9000 and `client:C-104:v{n}`. The rate change bumped `rateVersion`; a non-rate edit did not. 90 min → 13500 cents | |
| V3-03 Rate, funding and name changed after approval | PASS | The snapshot holds 9000, the old funding source and the old `rateVersion`. Bundle, invoice DocModel blocks, PDF size, `/api/files` amount and client `billedCents` are all unchanged (13500 cents, $135.00). The new values do not appear | |
| V3-04 Documents route banner | PASS | All 3 kinds show a DRAFT banner before approval. After approval they show only the fixture banner, never DRAFT. Templates resolve to `builtin:<kind>`. Bad kind → 400. Unknown session → 404 | |
| V3-05 Participant direction | PASS | The review adds `participant_direction` ("yes…") and `participant_choices` attestations. The choices text and a `participant_direction` heading appear in the invoice and session-note DocModels, both in the draft and after approval. A non-boolean value → 400 | |
| V3-06 Template CRUD and default per kind | PASS | Builtins are listed and are the default. Create returns a `tpl_` id with the missing sections filled in. Also checked: update, kind filter, builtin PUT/DELETE → 409, bad color → 400, cross-origin → 403, setting the default, wrong-kind default rejected, `templateId` override, reset to builtin, delete, and a second delete → 404 | |
| V3-06b Unknown section key rejected | PASS | 400. This failed on the first run (the key was silently dropped, 201). It passes after Agent 01's contract decision and the W4 fix | |
| V3-07 Client-specific invoice template used by the PDF route | PASS | The DocModel uses the client's template (title, a4). The invoice PDF is 595×842 (a4); the session note PDF is 612×792 (letter). The client template wins over the provider default | |
| V3-08 Preview with sample and with a session | PASS | The sample gives the template's title and font with a fixture banner. The session preview contains C-104 and a DRAFT banner. Preview does not save a template. Bad kind → 400. Unknown session → 404 | |
| V3-09 `renderDocModelPdf` with themed templates | PASS | Every kind with a4/serif/compact, letter/mono and a4 with non-ASCII header/footer gives a valid `%PDF-…%%EOF` that pdf-lib loads, with the right page size | |
| V3-10 Run history, normal path | **FAIL (W5)** | The stages appear in order: discovered → queued → workflow_started → load → evidence → match → extraction → assemble → draft_saved → approval_wait → review_saved → approved → client_snapshot → finalize → completed. The run is `waiting`/`approval_wait` mid-way, then `succeeded`. Event ids are unique, eventCount is correct, the filters work and an unknown run → 404. **But no `files` stage is ever emitted.** `docs/interfaces-v3.md` lists it between finalize and completed, and no code under `src/workflow` or `src/history` emits it. Everything else in this test passes, including the PII checks | W5 (`src/workflow/run.ts`) |
| V3-11 Live mode with fake OpenAI | PASS | The run lists as `succeeded` with `aiProvider=openai` and `model=gpt-4.1`. A `privacy` stage is emitted. The client's displayName and preferredName are not in the AI request body | |
| V3-12 Failure variant (upstream-error) | PASS | `?status=failed` lists the run with `currentStage=failed`, `endedAt` set, and a reason in the failed event | |
| V3-13 Delivery runs after a Drive upload | PASS | The run is `delivery:<deliveryId>`, kind delivery, `succeeded`, with a `delivery_drive` stage | |
| No PII in run events (V3-10, 11, 12, 13) | PASS | All run events were checked for these values and none appeared: planted client names, provider identity email, evidence excerpts, progress text, participant choices, OAuth tokens, AI keys and the connection account email. The logs had no client names | |
| V3-14 Other provider isolation | PASS | Another provider sees no C-104 client (404) and no custom templates. PUT, DELETE and set-default of our template → 404. Documents and preview for our session → 404. Their runs list is empty and our run → 404. Unauthenticated requests → 401. Our client record is unchanged | |
| Real Google, AI vendors, `wrangler dev`, UI in a browser | NOT RUN | No credentials or browser. The dev server on :8787 was not touched | |

## Whole repo

- **`npx vitest run`:** 43 files, 711 tests, **709 passed, 2 failed.**
  1. V3-10, above (W5).
  2. `tests/integration/flow.test.ts` QA-15 flakes under load. It passed 2 of 3 times on its own.
     - Likely cause: in `tests/e2e/harness.ts`, `FakeInstance.waitForEvent` only sets status back to `running` when the wait resolves, not when it is rejected by a timeout.
     - So after `timeoutWaits()`, `settle()` can return while the workflow is still finalizing.
     - The extra v3 I/O in finalize (snapshot, recorder) makes the race easier to hit.
     - Owner: the v1 harness (Agent 20), with W5's workflow changes as the trigger.
     - Agent 01 has classed this as timing noise.
- `src/privacy` perf (500×4000 under ~200 ms) and `fixtures/variants.test.ts` seedDemoData (a fake repo with no `getClient`) failed in an earlier full run. Both pass in the final run.
- **`npx tsc --noEmit`:** exit 0. An earlier run had errors in `src/ui/App.tsx` (missing TemplateEditor) and `src/ui/components/templates/SectionList.tsx` while W7 was still working. Those are now fixed.

## Observations (not failures)

- **Event ordering with a frozen clock:** with `QA_FROZEN_CLOCK=1`, V3-10 reports the run as `running` instead of `waiting` mid-way. Run events and summaries are ordered by timestamp and then by `id`. When events share a millisecond, the "latest" event is chosen by id, not insertion order. Real clocks normally move between D1 writes, but a sequence number or rowid tiebreak would make this exact (W1 `src/db/d1.ts` / W5).
- **Sample preview data:** the built-in sample preview uses the synthetic demo data (C-104, preferred name "Sam") and is labelled with the fixture banner.
