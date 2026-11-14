# Band pipeline observation: synthetic scenarios end to end

- **Date:** 2026-11-14
- **Commit:** `930f9ac` when the work started. HEAD moved to `1c36cc1` at 12:47:57 PST, during the final black-box run (see Observations §2.4). The in-process suite was re-run on `1c36cc1` and passes.
- **Scenarios:** the 8 in `fixtures/band/scenarios.ts`. All data is synthetic.
- **Raw data:** `docs/reports/band-pipeline-observation.json`, the merged black-box result with per-scenario detail, run events and timings.

## What ran

| Run | How | When (PST) | Result |
|---|---|---|---|
| In-process | `npx vitest run tests/integration/band-scenarios.test.ts`: real modules, Miniflare D1, `CaptureSession` driven directly, fake clock/queue/workflow, composition mirroring `src/index.ts` | 12:34, and again on `1c36cc1` | **8/8 scenarios pass** (9 tests including the id-coverage test) |
| Black-box #1 | `node --experimental-websocket scripts/band/run-scenarios.mjs` against `wrangler dev` :8787 at 20x real time | ~12:36–12:39 | 1 PASS, 7 FAIL. Six failed only on the stage *order* check (same-millisecond tie, §2.1). `sdp-334-training` lost its socket (§2.3). Results superseded by #3 |
| Black-box #2 | same | ~12:41–12:44 | Every scenario failed with `fetch failed`: nothing was listening on :8787 (the server had crashed, §2.4). No pipeline data |
| Black-box #3 | same (the runner now breaks same-ms ties by pipeline order and reports the raw order separately) | 12:46:47–12:48:33 | 7 PASS, 1 FAIL (`reconnect-mid-visit` stuck in QUEUED, §2.4) |
| Black-box #4 | `--only reconnect-mid-visit` | 12:49:09 | PASS |

`npx tsc --noEmit -p .` is clean.

The JSON merges #3 with #4 for `reconnect-mid-visit`. The failed attempt is kept under `earlierAttempt`.

## Per-scenario results: expected vs observed

The black-box observed values are from runs #3 and #4. The in-process run asserts the same fields; all match `expect`.

| Scenario (code, unit) | Status after processing (exp / obs) | Blocking at r1 (exp / obs) | Evidence | Completeness | Warnings expected → seen | Amount ¢ (exp / obs) | Final (exp / obs) | Black-box |
|---|---|---|---|---|---|---|---|---|
| sdp-320-normal (320, hour) | NEEDS_REVIEW / NEEDS_REVIEW | DUR+PROG / DUR+PROG | 7 / 7 | complete / complete | Simulated ✓ (listed twice, §2.2) | 4813 / 4813 | COMPLETED / COMPLETED | PASS |
| sdp-334-training (334, hour) | NEEDS_REVIEW / NEEDS_REVIEW | DUR / DUR | 6 / 6 | complete / complete | Simulated ✓ (twice) | 4333 / 4333 | COMPLETED / COMPLETED | PASS |
| sdp-331-community (331, **day**) | NEEDS_REVIEW / NEEDS_REVIEW | DUR+PROG / DUR+PROG | 5 / 5 | complete / complete | Simulated ✓ (twice) | 8250 / 8250 | COMPLETED / COMPLETED | PASS |
| lossy-bluetooth (320, hour) | NEEDS_REVIEW / NEEDS_REVIEW | DUR+PROG / DUR+PROG, plus nonblocking PARTIAL_EVIDENCE | 5 / 5 | partial / partial | Simulated ✓, "225 audio packet(s) (3.8%)" ✓ (both twice) | 3850 / 3850 | COMPLETED / COMPLETED | PASS |
| reconnect-mid-visit (335, hour) | NEEDS_REVIEW / NEEDS_REVIEW (#4; #3 stuck in QUEUED) | DUR / DUR | 6 / 6 | complete / complete | Simulated ✓ | 3585 / 3585 | COMPLETED / COMPLETED | PASS (#4) |
| participant-directed (320, hour) | NEEDS_REVIEW / NEEDS_REVIEW | DUR+PROG / DUR+PROG | 6 / 6 | complete / complete | Simulated ✓ | 5963 / 5963 | COMPLETED / COMPLETED | PASS |
| pii-in-transcript (334, hour) | NEEDS_REVIEW / NEEDS_REVIEW | DUR / DUR | 5 / 5 | complete / complete | Simulated ✓ | 2475 / 2475 | COMPLETED / COMPLETED | PASS |
| empty-recording (320, hour) | NO_EVIDENCE / NO_EVIDENCE | none / none (no bundle) | 0 / 0 | complete (evidence event meta) / complete | n/a | null / null | NO_EVIDENCE / NO_EVIDENCE | PASS |

DUR = `MISSING_CONFIRMED_DURATION`, PROG = `MISSING_PROGRESS`.

Also checked in both runs, for every scenario:
- `promptVersion` is `fixture-scenario-v1` (every non-empty script).
- Evidence ids are `ev_001…` in script order.
- `packets` and `lostPackets` match the simulated audio.
- The invoice downloads as `%PDF`, about 11.7–12.0 KB in the black-box run.
- No run event contains any transcript line, the fake phone number or email, or the client display name. The leak counter was 0.
- The run-history stage sequence for an approved scenario is `discovered > queued > workflow_started > load > evidence > match > extraction > assemble > draft_saved > approval_wait > review_saved > approved > client_snapshot > finalize > files > completed`.
- The sequence for `empty-recording` is `discovered > queued > workflow_started > load > evidence > failed`. There is no `match` event, because the workflow stops at 0 items before matching.
- No `privacy` stage appears: it is only emitted when the extractor reports scrubbing, which fixture mode never does.

### Stage timings (black-box, ms to reach each stage from the previous one; n = 8, or 7 past evidence)

All stages run back-to-back except one: `review_saved` measures the runner's own review call after it saw NEEDS_REVIEW.

| Stage | p50 | max |
|---|---|---|
| discovered → queued | 1 | 2 |
| queued → **workflow_started** | **1026** | **1035** |
| load | 1 | 3 |
| evidence (started→succeeded inside it: p50 2 / max 4) | 12 | 18 |
| match | 2 | 3 |
| extraction (fixture; started→succeeded p50 1 / max 2) | 3 | 4 |
| assemble | 3 | 6 |
| draft_saved | 3 | 4 |
| approval_wait | 3 | 4 |
| review_saved (client-driven) | 49 | 73 |
| approved | 6 | 11 |
| client_snapshot | 10 | 12 |
| finalize | 2 | 3 |
| files | 1 | 1 |
| completed | 0 | 1 |

End to end:
- queued → draft_saved: p50 1047, max 1065 ms.
- approved → completed: p50 14, max 15 ms.
- Client-observed stop → processed (polled every 250 ms): p50 1123, max 1135 ms.
- Approve → COMPLETED: p50 28, max 32 ms.
- Streaming at 20x took 4–7 s per scenario. The WebSocket open → `ready` took 3 ms.

## Observations

### 1. Facts: what the pipeline did right
- **Every expectation holds.** All 8 scenarios match `expect` in both harnesses: status after processing, blockers at r1, evidence count, completeness, warnings, amount after review, final status, prompt version, and files.
- **Packet loss is accounted for exactly.** The lossy scenario produced 225 lost of 6000 packets (3.8%), `partial` completeness and a nonblocking `PARTIAL_EVIDENCE` check.
- **A band-side reconnect is not counted as loss.** The `reconnect-mid-visit` scenario resends `start` with seq back to 0 and stays `complete`.
- **Run events carry no transcript text or PII.** This held for every scenario, including the one with fake contact details.
- **Approval is fast.** The approve request is processed in ~30 ms.

### 2. Bugs and surprises (each with file:line, repro and a suggested fix; I changed nothing in src/ or fixtures/)

**2.1 Run history misorders events recorded in the same millisecond.** (Fact, observed in 6 of 7 approved scenarios on the dev server.)
- `src/db/d1.ts:1632` sorts with `ORDER BY at_ms ASC, id ASC`, and event ids are `runId:stage:status`. So `finalize`, `files` and `completed`, all emitted in one step (`src/workflow/run.ts:275-280`), come back in alphabetical order, for example `client_snapshot > completed > files > finalize`.
- The UI sorts by `at` only (`src/ui/components/runs/model.ts:144-146`), which is a stable sort, so it keeps the wrong order.
- Repro: approve any band scenario on `wrangler dev`, then `GET /api/runs/wf-<session>-r1`.
- Fix: break ties by insertion order (`ORDER BY at_ms, rowid`), or add a per-run sequence column. Alternatively, have the emitter guarantee a strictly increasing `at` per run.
- The in-process test avoids the tie by giving the recorder a ticking clock. The black-box runner reports the raw order as `stagesAsStored` and sets `sameMsTieReordered: true`.

**2.2 Evidence warnings were duplicated in provenance.** (Fact: seen in black-box scenarios 1–4 of run #3 before `1c36cc1` reloaded. Already fixed upstream.)
- `src/workflow/run.ts:471` used to concatenate `result.warnings` and `match.warnings`, so "Simulated transcript…" and the lost-packet warning each appeared twice.
- `1c36cc1` changed it to `[...new Set(...)]`. Scenarios run after the reload show each warning once.
- The in-process test now asserts uniqueness, and that passes on `1c36cc1`.

**2.3 A dropped socket looks like a complete recording.** (Fact: observed. Implication: inference.)
- In black-box #1, `sdp-334-training`'s WebSocket closed with 1006 after about 45 s of audio. This was most likely a dev-server reload or crash.
- The runner still stopped the visit. The server reported `packets: 2250, lostPackets: 0, segmentCount: 4`, which means completeness would be `complete`.
- 2250 is exactly a multiple of the stats interval (`STATS_EVERY = 250`, `src/band/capture.ts:23`). So the final `updateStats` in `finish()` (`src/band/capture.ts:153`) never ran, and the packet count is short by up to 249.
- The fixture extraction cites ev_005 and ev_006, which never arrived, so the session became INCOMPLETE. With live extraction it would probably reach NEEDS_REVIEW and be marked `complete` (inference).
- Repro: start a visit, stream part of the audio, kill or close the socket without `stop`, then POST stop.
- Fix: persist "the socket closed without stop" on the visit (for example `abnormal_close` or `last_packet_at`). Have `BandEvidenceSource` (`src/band/evidence.ts:70`) return `partial` plus a warning when the stream did not end with `stop`, or when audio coverage is less than stop − start.

**2.4 Environment: the dev server crashed, and a lost queue message left a session stuck in QUEUED.**
- **Facts:**
  - The lead reported two workerd aborts during my runs ("V8 fatal error … Missing deoptimization information for OptimizedJSFrame::Summarize", signal 6, wrangler 4.86, which suggests upgrading to 4.162). Each came right after a `workflow.completed` followed by `GET /api/sessions/:id`.
  - From my side I saw:
    - A ~120 s stall in the first scenario of run #1.
    - The 1006 socket drop (2.3).
    - Run #2 failing entirely, with no listener on :8787 at ~12:41–12:44 PST.
    - In run #3, `reconnect-mid-visit`'s session was `QUEUED` from 20:47:20.515Z and still `QUEUED` minutes later. `src/workflow/run.ts` was rewritten at 12:47:19 PST when `1c36cc1` landed, so a hot reload happened within a second of that stop.
  - A manual `GET /__scheduled` did **not** recover the session.
  - I cannot tie a specific crash to a specific request beyond what the lead reported.
- **Inference:**
  - The local queue message was dropped by the reload or crash. `enqueueAppointment` had already marked the delivery `done` (`src/jobs/index.ts:146-148`).
  - `dispatchPendingDeliveries` (`src/jobs/index.ts:199-240`) only retries pending deliveries and reconciles *approval* notifications. Nothing re-enqueues a session that is QUEUED with a done delivery.
  - Production Queues persist messages, so this is mostly a dev-only risk. Still, a stale-QUEUED sweep would make recovery total.
- **Suggested fix:** in the cron, re-send the queue message for sessions that have sat in `QUEUED` longer than N minutes with no workflow instance (the workflow id is deterministic, so a re-send is idempotent). Separately, upgrade wrangler and workerd for the V8 abort.

**2.5 `workflow.approval_event_revision_mismatch` on every approve is benign, not an ordering bug.** (Fact: read from the code, and the log appears in the in-process run too.)
- At `src/workflow/run.ts:194-247`, iteration 0 checks approval and gets `pending` with `currentBundleRevision = 1` (the r1 draft), then waits.
- The provider's review creates r2, and approve sends the event with `bundleRevision: 2`.
- On wake, `src/workflow/run.ts:241` compares the hint against `c.currentBundleRevision`, which was captured *before* the wait. That value is always 1 when a review happened in between, which is every scenario here, since review is needed to unblock.
- The loop then re-reads durable state (`check approval #1`), sees approved r2 and finalizes r2 correctly. The run summary and final amounts confirm this.
- Fix (log noise only): compare against a fresh read, or downgrade the log to debug when `hint > snapshot`.

**2.6 Queue hop latency.** (Fact for local; inference for production.)
- ~1.03 s of the ~1.05 s stop → draft time is `queued → workflow_started`. That is the local queue batch delay: `wrangler.jsonc:24` sets no `max_batch_timeout`.
- Everything else, from evidence to draft, takes about 15 ms with fixture extraction.
- In production the default batch timeout (seconds) would dominate the time to NEEDS_REVIEW, unless `max_batch_timeout` is lowered or stop starts the workflow directly. Live AI extraction latency was not measured; this run used fixture extraction only.

**2.7 Timing artefacts of the test setup.** (Fact.)
- At 20x pacing, the black-box visit appointment lasts only about 5 s, so `billing.scheduledMinutes` is 0 in every black-box draft. In-process it is about 1–2 min.
- Segments are timestamped `audioStartMs + atSec`, up to about 100 s *after* the stop time. They are still accepted because the evidence window has a 60 min buffer (`src/integrations/vexo/window.ts:4`).
- Nothing flags a confirmed duration (75–120 min) that far exceeds the scheduled or recorded duration. See §3.

### 3. What the pipeline does NOT check yet (facts from the code; relevance per docs/research/self-determination-codes.md)
- **Day units (SDP 331).** The waiver estimates 331 per day (§1.4). Billing is hourly only, so `sdp-331-community` billed 120 min as 2 h × $41.25 = $82.50 with no unit conversion or flag. `ScenarioServiceCode.unit` is informational only.
- **Authorization overrun.** `client.authorizedHours` (20 h on every synthetic client) is shown on documents (`src/documents/model.ts:227`) but is not used by `src/domain/rules` or `src/domain/billing`. The only cap is `rate.maxMinutes`, which is per visit. There is no tracking of units used or remaining per period (research §1.8, §5 `units_used`/`units_remaining`).
- **Confirmed minutes vs evidence.** There is no check comparing confirmed minutes with recorded audio duration, appointment start/stop, or the first-to-last segment span.
- **EVV elements (research §1.9).** 320 is EVV-covered (PCS) in SDP, but none of the required elements are checked or captured on the session or final:
  - start and end times as EVV data
  - the service location or street address
  - the participant UCI
  - the FMS vendor number
- **Rule set.** `src/domain/rules` has these codes only: MISSING_CLIENT_REFERENCE, MISSING_CONFIRMED_DURATION, MISSING_PROGRESS, MISSING_PROVIDER_IDENTITY, MISSING_SERVICE_DATE, MISSING_SERVICE_DESCRIPTION, NO_GOAL_ADDRESSED, PARTIAL_EVIDENCE, UNKNOWN_GOAL_COVERAGE, UNSUPPORTED_CLAIM. Nothing is service-code-specific.
- **Participant direction is not enforced.** `participantDirected`/`participantChoices` become attestations (asserted in-process), but no rule requires them for SDP codes.
- **PII scrubbing was not exercised.** In fixture mode the fake phone number and email flow into evidence, as the scenario intends. The scrubber only runs for live inference, so `provenance.privacy` was absent and no `privacy` run stage appeared. A live-mode run is still needed to observe it.
- **Socket-level reconnect.** Only the band-level reconnect (new `start` on the same socket) was tested. A real socket reconnect opens a new `CaptureSession` and a new simulated transcriber with `emitted = 0` (`src/band/transcriber.ts:211-213`). By reading the code (not run), the simulated script would replay from the start and duplicate earlier segments; Deepgram would not.

### 4. Recommended next steps
1. Fix the run-event ordering tie (2.1). It is cheap, and the UI timeline is visibly wrong today.
2. Mark visits whose stream ended without `stop` (or that have audio gaps) as `partial` (2.3).
3. Add a cron sweep for sessions stuck in QUEUED (2.4), and upgrade wrangler/workerd for the V8 abort.
4. Set `max_batch_timeout` on the queue consumer, or start the workflow directly on stop (2.6).
5. Add rules for authorization remaining and confirmed minutes vs recorded duration, then unit-aware billing (day, month) for codes like 331 (§3).
6. Capture the EVV elements for EVV-covered codes (320 and the others in research §1.9).
7. Run the black-box runner in live extraction mode with a key, to observe scrubbing, the `privacy` stage and real extraction latency.
8. Add a socket-reconnect scenario to the fixtures and runner, to settle §3's last point.

## How to reproduce
```sh
npx vitest run tests/integration/band-scenarios.test.ts
# with `npm run dev` running on :8787 (Node 20 needs the flag)
node --experimental-websocket scripts/band/run-scenarios.mjs [--only <id>] [--speed 20] [--base http://localhost:8787]
```
