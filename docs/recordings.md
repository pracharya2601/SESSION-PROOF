# Recordings (client-less, partitioned by the calendar)

The phone only **records**. It never picks a client. The server works out who each part of the recording belongs to from the provider's **calendar**: it splits the transcript into sessions by time window, then drafts each session from Drive context.

Contract (frozen): `src/contracts/schedule.ts`. Code: `src/recordings/` (store, partition job, evidence source), `src/api/recordings.ts` (routes), `src/schedule/` (calendar + Drive sources, `syncCalendarToAppointments`). Migration: `migrations/0011_recordings.sql`.

```
Band ─▶ GlassCam ─▶ POST /api/device/recordings ─▶ WS /api/recordings/:id/stream (visit protocol)
     ─▶ POST /api/device/recordings/:id/stop ─▶ queue {kind:"partition_recording"}
     ─▶ calendar sync [start − 2 h, end + 2 h] ─▶ assign segments ─▶ one session per event with segments
     ─▶ workflow (evidence = that event's assigned segments) ─▶ NEEDS_REVIEW (+ review link)
```

## Device API (Authorization: Bearer vfad_…)
No `Origin` header is needed with the bearer key. Another provider's recording returns `404`.

| Request | Response |
|---|---|
| `POST /api/device/recordings` `{ bandNumber: 1..999\|null, transport: "ble"\|"serial"\|"sim", timezone?, scenario? }` | `201 StartRecordingResponse { recording, streamUrl, streamToken, streamTokenExpiresAt, currentEvent }`. `currentEvent` is the calendar event covering now, or `null`. With no server transcriber you get `503 TRANSCRIPTION_NOT_CONFIGURED`. A `scenario` is a synthetic day script id (`fixtures/schedule/day-scripts.ts`, local dev only): the recording then always uses the simulated transcriber, even when Deepgram is configured, and its calendar comes from the script (see [demo.md §5](demo.md#5-rehearse-locally-the-synthetic-day-scriptsdemorun-daymjs)). Deployed → `400 SCENARIO_DEV_ONLY`; unknown id → `400 UNKNOWN_SCENARIO` |
| `GET /api/device/recordings/:id` | `{ recording }` (status, packets, segmentCount, partition) |
| `POST /api/device/recordings/:id/stop` | `202 { recording }`. The first call stops the recording and queues the partition job. A repeat call is a no-op once the recording is partitioned. If the queue send fails you get `503 QUEUE_UNAVAILABLE`, and you call stop again. An offline recording that is not yet transcribed returns `409 RECORDING_PENDING_UPLOAD` |
| `GET /api/device/schedule?date=YYYY-MM-DD[&timezone=IANA]` | `{ events: CalendarEvent[] }`, cancelled events included (shown greyed out). With a `timezone` you get the events overlapping that local day. Without one you get the events that start on `date` in their own zone. `date` defaults to today |

### Stream
`streamUrl` is `ws(s)://<host>/api/recordings/<id>/stream`, with no token. The host is `PUBLIC_STREAM_ORIGIN` when that is set. The protocol is exactly the visit protocol ([band-bridge.md §2](band-bridge.md#2-stream)): `start` first and again after every band reconnect, then binary `[seq BE][opus]`, `keepalive`, and `stop` → `done`. Only `streamToken` authenticates, the same way as for a visit ([band-bridge.md §2](band-bridge.md#2-stream)): `Sec-WebSocket-Protocol: vfa-stream, vfa-token.<streamToken>`, or a first message `{"type":"auth","token":"…"}` within 5 s (else close 1008). There is no cookie route. `?token=` still works for one release (deprecated, counted in the logs). The token is valid for 4 h and scoped to this one recording. It is a secret: never put it in a URL or a log. Once the recording is stopped the stream returns `409 RECORDING_STOPPED`.

Recommended phone flow: send socket `stop`, wait for `done`, then call `POST …/stop`. If the phone restarts or the app is killed, start a **new** recording. Segments of one visit can come from any number of recordings, and the server joins them per event.

## Partition rule (exact, frozen)
A segment belongs to event E when its **midpoint** lies in `[E.start − 10 min, E.end + 10 min)`. If the midpoint is in two windows, the event whose start is nearest wins, but only when it is nearer by at least 5 min. Otherwise the segment is **ambiguous**: it is attached to neither event and flagged on the candidates' sessions. A midpoint in no window makes the segment **unassigned**.

Only appointments with ids `appt_cal_*` that are not cancelled take part. These are the calendar events synced by `syncCalendarToAppointments`; legacy and band-visit appointments never do.

## What a partition produces
- **One session per event with ≥ 1 assigned segment**, through `jobs.enqueueAppointment` (session id = `sessionIdFor(provider, eventId)`). An event with no segments gets **no session**. Discovery skips `appt_cal_*` appointments, so calendar sessions come only from the partitioner.
- **Several recordings for one event** go to the same session. When a later recording adds segments, the session is re-processed (new processing revision, new bundle revision). This happens unless the session is `APPROVED` or `COMPLETED` (approved stays locked) or already `QUEUED`. Re-running a partition with no change does nothing (hand-offs are recorded per recording+event with their segment count).
- **Unassigned segments** are never evidence. Their text (the `band_segments` row) is deleted **24 h** after partitioning by the cron sweep. Their times and the counts stay.
- `recording.partition`:
  ```jsonc
  { "sessions": [{ "eventId": "demo_c_104_20261113_fri2", "clientRef": "C-104", "sessionId": "sess_…", "segmentCount": 2 },
                 { "eventId": "demo_sd_334_a_20261113_fri3", "clientRef": "SD-334-A", "sessionId": "sess_…", "segmentCount": 2 }],
    "unassignedSegments": 1, "ambiguousSegments": 0, "unassignedMs": 5000, "partitionedAt": "…" }
  ```
- Failures: if the calendar or sync fails, the job retries with backoff (30 s doubling, at most 10 min) up to 5 attempts. After that, `status: "failed"` with an `error_code` (`CALENDAR_UNAVAILABLE`, `CALENDAR_NOT_CONFIGURED`).

## Evidence (`RecordingEvidenceSource`, `appt_cal_*` only)
- **Items:** the provider's assigned segments for that appointment across **all** recordings, sorted by time. They get ids `ev_001…` and `sourceId` `recording:<id>`.
- **Mode:** `live` when every contributing recording used Deepgram, `fixture` otherwise.
- **Warnings:** simulated transcript; a recording that was never stopped; lost Bluetooth packets (sum over the recordings); ambiguous segments near this appointment; "comes from N recordings"; and **a gap between recordings inside the event** longer than 2 min. A late start or an early stop is not flagged.
- **Completeness:** `partial` whenever any of these apply (except the multi-recording note).
- **Workflow matching:** `appt_cal_*` appointments have no competitors and never compete, the same as `appt_visit_*` (`src/workflow/run.ts`). The partitioner already bound each segment to exactly one event. So the Friday C-104 calendar slot does not collide with the legacy `appointment_demo_001` at the same time.

## Web (cookie / public auth)
| Request | Response |
|---|---|
| `GET /api/recordings` | `Recording[]` (newest first, with `partition`) |
| `GET /api/recordings/:id` | `{ recording, segments: [{ index, observedFrom, observedTo, speaker, text, textDeleted, assignment }] }`. `assignment` is one of `{status:"assigned", eventId, appointmentId, clientRef, sessionId}`, `{status:"unassigned"}`, `{status:"ambiguous", candidateEventIds}` or `{status:"pending"}` (not partitioned yet). `text` is `null` once an unassigned segment's text has been deleted |

## Offline recordings (no internet)
These work like [offline-recording.md](offline-recording.md), but there is no client:

| Request | Response |
|---|---|
| `POST /api/device/offline-recordings` `{ localId, bandNumber, recordedFrom, recordedTo, timezone?, consentConfirmedAt }` | `201` (or `200` for the same localId) `{ recording, uploadUrl, statusUrl, maxUploadBytes, status }`. The same localId describing a different recording returns `409 LOCAL_ID_CONFLICT`. localIds share one space per device with offline visits |
| `PUT /api/device/offline-recordings/:id/audio` (VXREC1, `application/octet-stream`) | `202 { status: "queued" }` / `200 { status: "already_transcribed" }`. Same checks as visits (localId, run times within ±10 min). A recording's header has **no `clientRef`** (the recording header is the visit header without it; if one is sent, it is ignored) |
| `GET /api/device/offline-recordings/:id` | `{ recordingId, status: awaiting_audio\|transcribing\|partitioning\|partitioned\|failed, segmentCount, canDeleteLocalFile, partition, error }`. Once the status is `partitioned`, the phone reads `GET /api/device/recordings/:id` |

The same `transcribe_offline` job runs. Its row in `offline_visits` has `target = 'recording'`. Segments are stored on the wall clock, the audio is deleted, and then a `partition_recording` job is queued.

## Tables
- `recordings`: one per recording (plus `consent_confirmed_at` from offline create, exposed as `Recording.consentConfirmedAt`, migration 0012). It stores status, transcriber, times, packets/lost, the partition summary JSON and the error code. It never holds audio.
- `band_segments`: transcript segments, with `visit_id` = the recording id (shared with visits).
- `recording_segment_assignments`: (recording, idx) → assigned / unassigned / ambiguous, plus event/appointment (or candidate lists) and `text_deleted_at`.
- `recording_sessions`: the hand-off of (recording, event) → session, with segment count.
- `offline_visits.target`: `visit` | `recording`.

## Cron sweep (`sweepRecordings`, every heartbeat)
- Deletes unassigned segment text 24 h after partitioning.
- Stops recordings still `recording` 12 h after their start and partitions them. The end time is the last segment.
- Re-sends the partition job for recordings left `stopped` for more than 15 min (a lost queue message).

## Content suggestions (pass 2)
Pass 1 (the time rule above) is the **only automatic assignment**. Pass 2 runs right after it inside the partition job (`src/recordings/content-job.ts`, pure algorithm in `content.ts`). It looks at the segments left **unassigned or ambiguous**, plus every segment of a recording with no calendar overlap, and **proposes** a client from the content. Nothing is assigned until the provider accepts. If pass 2 fails, the partition does not fail. Migration: `migrations/0014_assignment_suggestions.sql`.

1. **Blocks.** These rules are deterministic.
   - A silence gap of more than 90 s between segments is a hard split.
   - The 3 segments on either side are compared. Disjoint speaker sets make a soft split. A bag-of-words cosine below 0.10 is also a soft split, but only when both windows have at least 5 content tokens.
   - A tiny block (fewer than 2 segments, or shorter than 30 s) merges into a neighbour. A soft-connected neighbour is preferred, then the smaller gap. Across a hard split it only merges if the gap is at most 10 min.
   - After scoring, neighbours separated by a soft split that reached the same outcome merge again.
2. **Candidates.** These are the provider's non-cancelled events on the block's local day within ± 4 h, for clients that have Drive context. If there are none, or none of them match, the candidates widen to the caseload: active clients plus calendar clients of ± 7 days that have Drive context, capped at 8.
3. **Score (rules).**
   - `goal` = the number of distinct goal terms matched, divided by 3 (capped at 1).
   - `tfidf` = cosine against the candidate's Drive plan text (plan, previous notes and assessment, with names stripped), using IDF over the candidates, divided by 0.25 (capped at 1).
   - `content = 0.6·goal + 0.4·tfidf`.
   - `time = 1 − gap/4h` to the client's nearest event.
   - `score = 0.8·content + 0.2·time`.
   - A candidate is eligible with content ≥ 0.30 **and** ≥ 2 distinct matched plan terms. If no candidate is eligible, the block is "none".
   - Confidence: `0.3 + 0.45·score + 0.5·margin` (clamped to 0.05–0.85). For "none" it is `0.7 − bestContent` (clamped to 0.2–0.7).
   - The suggestion is `kind: "event"` when the client's event overlaps the block or is within 60 min of it. Otherwise it is `"unscheduled"`, which is also the kind used for "none".
   - **Visit tail / early start.** A block that starts ≤ 20 min after a candidate's event ends (or ends ≤ 20 min before it starts) **extends THAT event** (`kind: "event"`) when it names the participant (a local match on the known name parts from the Drive plan and the client record; names are never sent, stored or put in a rationale) or matches ≥ 2 plan terms. This applies even below the content threshold, because goodbyes rarely carry plan terms (day-overrun: "…see you Friday, Jordan."). Confidence: `0.55 + 0.1·named + 0.05·terms(≤2) + 0.1·content`, −0.15 when another client also qualifies (clamped to 0.3–0.85). An AI "none" does not override a tail, because the model sees de-identified lines and no calendar. The confidence is then ×0.85 and the method is `ai+rules`. The rationale says `participant named` and `(visit tail)`.
4. **AI (optional).** This needs `EXTRACTION_MODE=live` and a key for the provider's vendor. At most 8 calls go out per recording. The model receives only **privacy-scrubbed** lines `{i, speaker, text}` and candidates `{clientRef, goals}`. Client names on file and Drive participant names are known terms. Nothing is restored.
   - The output must be exactly `{clientRef, confidence, rationale, citedSegmentIndexes}`. `clientRef` must be a candidate or `"none"`, and the cited indexes must lie inside the block (at least one for a pick). Any other output is ignored, and the method stays `rules`.
   - When the model and the rules agree, confidence is `min(0.95, mean + 0.1)`. When they disagree, the more confident side wins at half its confidence. The method is then `ai+rules`.
5. **Rationale.** At most 200 chars, built from plan keywords, segment indexes and minutes only. It never contains transcript text or names. Example: `Plan terms: amount, bill, budget, date, due (segs 3-8); 12 min after its event.`

| Request | Response |
|---|---|
| `GET /api/recordings/:id` | Also returns `suggestions: Suggestion[]`, `sessionConversations: SessionConversation[]` and `segments[].assignment.method` (`calendar_time` or `provider_confirmed_content`) |
| `POST /api/recordings/:id/suggestions/:sid/accept` `{clientRef?, eventId?}` (strict, may be empty) | `200 {suggestion, sessionId}`. The provider may override the client and/or name an event within ± 4 h. With no event (overlapping, or within 60 min, for that client), an appointment `appt_cal_unsched_<12 hex>_<firstIdx>_<client>` covering the block is created, with its service config from Drive. The segments are assigned with method `provider_confirmed_content`, then the partition hand-off runs: the session is enqueued, or re-processed if it already exists. Errors: `400 CLIENT_REQUIRED / UNKNOWN_CLIENT / UNKNOWN_EVENT / EVENT_CLIENT_MISMATCH / VALIDATION`, `409 SUGGESTION_DECIDED / SUGGESTION_STALE / EVENT_CANCELLED / SESSION_LOCKED / NO_SERVICE_CONFIG`, `404` |
| `POST /api/recordings/:id/suggestions/:sid/reject` (no body) | `200 {suggestion}` (status `rejected`). Returns `409` when it was already decided |
| `POST /api/recordings/:id/sessions/:eventId/conversation` `{decision: "client_session"\|"dismissed"}` | `200 {conversation}`. Records the decision for the appointment and re-processes the session (approved sessions stay locked) |

- A pass 1 re-run never overwrites `provider_confirmed_content` rows. Suggestion ids are deterministic (`sug_` + sha256 of the recording id and segment indexes), so a re-run never duplicates a suggestion or touches a decision.
- **Evidence warning:** `N lines assigned by provider from content suggestion.`
- **Retention:** unassigned text covered by a **pending** suggestion **with a client** is kept for up to **7 days** after partitioning. Rejected, accepted and "none" suggestions follow the normal 24 h.

## Conversation type
Every session block (per recording and event, from pass 1 or an accept) and every suggestion block gets a `conversationType`: `client_session`, `colleague_meeting`, `guardian_or_family`, `phone_call`, `personal` or `unclear`. Each one also carries a confidence and `signals`. The signals are counts and booleans only: speakers, participant voice, plan-term hits, work-term hits, other client refs, family terms, phone cues, personal terms, `participantMentions`, `relationCues`, and the event-title hint.
- **Every pass 1 session block is classified before its hand-off** (`classifySessionBlocks`, called by the partition job between saving the assignments and enqueuing the sessions). One `recording_conversations` row (`event:<eventId>`) is written per block. So the drafter's visit context always reads the stored assessment and never races the content pass. Before this change, a session drafted before pass 2 finished fell back to on-the-fly rules without the participant's name (demo day 2026-11-14: a guardian call in a C-104 slot got no assessment and no `NOT_CLIENT_SESSION`).
- **Guardian / family calls.** `participantMentions` counts lines that talk ABOUT the participant: their name in the possessive ("Sam's"), or not in an addressing position. "Okay Sam, …", "See you, Sam." and "Great job, Sam!" are addresses and do not count. `relationCues` counts "Sam's mom", "his mother", "as the guardian", "your son". Phone cues now include "Hi, it's <name>", "… calling", "is now a good time" and "bye now". `guardian_or_family = 0.15·family(≤3) + 0.25·relation(≤2) + [family call] (0.1·mentions(≤3) + 0.1 if phone cues) + 0.3·title − 0.1·plan`. A family call means relation cues, or ≥ 2 mentions plus a family term. `client_session` loses `0.08·mentions + 0.15·relation`. day-guardian-call scores guardian_or_family 0.9 on the rules alone.
- When the AI and the rules pick **different non-client types** (e.g. guardian vs phone call), the verdict "not a client session" is agreed: the more confident type wins at `min(0.9, mean)`, not half.
- **Rules:** each label gets a score from the signals, and the best label wins if it scores at least 0.35, otherwise the type is `unclear`. Confidence is `0.25 + top − 0.5·second` (clamped to 0.2–0.9). An optional AI classification must be exactly `{conversationType, confidence}`, and it is combined the same way as the content suggestions.
- The partition **always** creates the session. When the type is neither `client_session` nor `unclear` and the confidence is ≥ 0.6, `needsConfirmation` is true. The visit context then sets `conversationNeedsConfirmation: true`, and the checklist can show a blocking item. Nothing is ever deleted automatically.
- Visit context (`visitContextResolver`, type `RecordingVisitContext`) adds `conversationType`, `conversationConfidence`, `conversationLabel` (e.g. "colleague meeting"), `conversationNeedsConfirmation` and `conversationDecision`. When nothing has been stored yet (no pass 2 configured), it computes the rules on the fly, with the participant's name parts when Drive is configured. The frozen `config.context.conversation` drives the blocking `NOT_CLIENT_SESSION` issue (`validateRequirements`).
- Tables: `recording_assignment_suggestions`, `recording_conversations` (provider decision kept across re-runs), `recording_segment_assignments.method`.

## Config
`CALENDAR_SOURCE` / `DRIVE_SOURCE` = `demo` (the default) or `google` (a stub for now). `DEMO_CALENDAR_NOW_SLOT=1` (dev and production vars) injects a C-104 event covering "now" when no demo event does. Without it, a live demo recording outside the weekly pattern would be fully unassigned.

## Try it locally
```sh
npm run db:migrate:local   # applies 0011_recordings.sql
npm test -- tests/integration/recordings.test.ts
```
