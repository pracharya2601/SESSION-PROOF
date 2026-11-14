# Offline recording (no internet on the phone)

When GlassCam has no internet during a visit, it records the band's Opus packets to a **VXREC1** file and uploads it later. The server transcribes the file (Deepgram pre-recorded), stores the transcript as the visit's band segments, deletes the audio, and the visit goes through the normal pipeline to **NEEDS_REVIEW** (with the review link / inbox notification).

Contract (**frozen**): `src/contracts/offline.ts`. Code: `src/offline/` (`vxrec.ts` parser + timeline, `ogg.ts` muxer, `job.ts` queue job + sweep, `store.ts`), routes `src/api/offline-visits.ts`, migration `migrations/0010_offline_visits.sql`. Tests: `src/offline/*.test.ts`, `tests/integration/offline-visits.test.ts`. Smoke: `scripts/band/offline-upload-smoke.mjs`.

```
phone (offline)                          phone (back online)                     Worker
band ──BLE──▶ record packets ──▶ file    POST /api/device/offline-visits ──────▶ visit (stopped, real past times,
                                                                                   appointment hidden from discovery)
                                         PUT  …/:id/audio  (VXREC1) ───────────▶ R2 AUDIO_TMP ─▶ SESSION_QUEUE
                                                                                   "transcribe_offline"
                                                                                     ▼
                                                    parse → Ogg Opus → Deepgram pre-recorded → band_segments
                                                    → DELETE R2 object → appointment visible → session queued
                                         GET  …/:id  (poll) ◀──────────────────── needs_review
```

## 1. The VXREC1 file

All integers are unsigned **big-endian**. One file = one visit.

| Part | Bytes | Content |
|---|---|---|
| magic | 7 | `VXREC1\n` = `56 58 52 45 43 31 0A` |
| header | ≤ 16384 incl. `\n` | one line of UTF-8 JSON (below), terminated by `\n` (`0A`) |
| records | until EOF | repeated: `u8 runIndex` · `u16 seq` · `u16 len` · `len` bytes of Opus |

Header JSON:
```json
{"version":1,"bandNumber":7,"audioRuns":[{"runIndex":0,"audioStartMs":1794600005000},{"runIndex":1,"audioStartMs":1794600125000}],
 "recordedFrom":"2026-11-13T17:00:00.000Z","recordedTo":"2026-11-13T17:20:00.000Z","clientRef":"C-104",
 "localId":"6F1C2C9E-2B7D-4B0E-9C41-0D7A3E5B9F10","appVersion":"1.4 (77)"}
```

| Field | Rule |
|---|---|
| `version` | `1` |
| `bandNumber` | 1..999 or `null` |
| `audioRuns` | 1..256 entries, increasing `runIndex` (0..255), non-decreasing `audioStartMs` |
| `audioRuns[].audioStartMs` | phone wall-clock epoch ms of the **first record of that run** |
| `recordedFrom` / `recordedTo` | ISO 8601 with offset; same values as the create request |
| `clientRef` | must equal the visit's client |
| `localId` | must equal the `localId` the visit was created with (else `400 FILE_MISMATCH`) |
| `appVersion` | 1..64 chars |
| anything else | ignored (forward compatible) |

Records:
- **A run** = one uninterrupted band stream (`STREAM_START` until the band disconnects). After a band reconnect `seq` restarts, so start a **new run** (next `runIndex`) with its own `audioStartMs`.
- `seq` = the band AUDIO frame's seq exactly as received (on the BLE wire it is little-endian; **write it big-endian here**). It wraps 65535 → 0; that is fine.
- `len` 1..1500; the Opus bytes exactly as the band sent them (16 kHz mono, 20 ms per packet).
- Records are **grouped by run in increasing `runIndex`**, and every record's `runIndex` is listed in `audioRuns`.
- At most 720 000 records (4 h at 50/s) and 50 MB per file (4 h of band audio is about 15–20 MB).
- A cut-off **last** record (app killed mid-write) is tolerated and dropped. Anything else malformed rejects the file.

**Timing.** The server places each packet at `audioStartMs + (seq distance from the run's first record) × 20 ms`, so lost packets (seq gaps) don't shift later speech. A step of 1..32767 is forward (step − 1 lost); a repeated or backwards seq is dropped. Transcript time → wall time is mapped packet by packet, so segment time = `run.audioStartMs` + offset inside the run.

**Writing it on the phone.** The header needs `audioRuns` and `recordedTo`, which are only known at stop. Recommended: while recording, append records (`[runIndex][seq BE][len BE][opus]`) to `<localId>.pkts` and keep a small sidecar `<localId>.json` updated at each run start (crash-safe). At stop (or on next launch after a crash), write `VXREC1\n` + header line + the `.pkts` bytes into `<localId>.vxrec` (or stream those three parts as the upload body).

### Why a raw packet format, not Ogg on the phone
- Append-only and trivial to write from the BLE callback: 5 header bytes per packet, no paging, no CRC, no granule bookkeeping. A crash loses at most the record being written.
- Keeps what the server needs and Ogg would hide: the band's `seq` (loss accounting) and per-run wall-clock starts (exact timestamps across reconnects).
- The Ogg muxer then lives once, in TypeScript, with tests (`src/offline/ogg.ts`): OpusHead (v1, mono, pre-skip 0, input rate 16000, mapping 0) + OpusTags + audio pages (≤ 50 packets per page, granule = cumulative 48 kHz samples from each packet's TOC, EOS on the last page, Ogg CRC-32). Checked by round trip through the kit's `oggPackets` and by ffmpeg (identical decode to the original sample).
- **Runs** are concatenated into **one** Ogg stream with no silence in between, so one Deepgram request covers the visit and diarization speaker numbers stay consistent. The per-packet time map puts every utterance back on the right run's clock.

## 2. Device API

`Authorization: Bearer vfad_…` (the paired device key). No cookie and no `Origin` needed. Envelope as usual: `{ data, correlationId }` or `{ error: { code, message, retryable, correlationId } }`. Another provider's visit is `404`. Removed device → `401 DEVICE_REVOKED`.

### `POST /api/device/offline-visits`
```json
{ "localId": "6F1C2C9E-2B7D-4B0E-9C41-0D7A3E5B9F10", "clientRef": "C-104", "bandNumber": 7,
  "recordedFrom": "2026-11-13T17:00:00.000Z", "recordedTo": "2026-11-13T17:20:00.000Z",
  "timezone": "America/Chicago", "consentConfirmedAt": "2026-11-13T16:59:30.000Z" }
```
- `localId`: `^[A-Za-z0-9._:-]{8,64}$` (a UUID is recommended), unique **per device**. **Idempotent**: the same `(device, localId)` with the same `clientRef`, `bandNumber`, `recordedFrom`, `recordedTo` returns the same visit with `200`; anything different is `409 LOCAL_ID_CONFLICT`.
- `timezone` optional (defaults to the client's last appointment's zone). Strict body (unknown keys → 400).
- Rules (`400 VALIDATION`): `recordedTo > recordedFrom`; at most 4 h long; `recordedTo` not more than 10 min in the future; `recordedFrom` at most 30 days ago; `consentConfirmedAt` not after `recordedTo`.
- `422 NO_SERVICE_PLAN` (client has no earlier appointment), `503 TRANSCRIPTION_NOT_CONFIGURED` (deployed without a Deepgram key; `retryable: true`, keep the file and try later), `503 OFFLINE_NOT_CONFIGURED` (no `AUDIO_TMP` bucket).

`201` (new) / `200` (same localId again):
```json
{ "visit": { "id": "visit_…", "status": "stopped", "startedAt": "<recordedFrom>", "endedAt": "<recordedTo>",
             "sessionId": null, "transcriber": "deepgram", … },
  "uploadUrl": "https://<host>/api/device/offline-visits/visit_…/audio",
  "statusUrl": "https://<host>/api/device/offline-visits/visit_…",
  "maxUploadBytes": 52428800, "status": "awaiting_audio" }
```
The visit is a normal `Visit` (`src/contracts/band.ts`), already `stopped` with the real past start/end; its appointment's start/end are `recordedFrom`/`recordedTo`. It is **hidden from discovery** (the appointment is stored `canceled` until the transcript exists), and `POST /api/device/visits/:id/stop` (or the web stop) returns `409 VISIT_PENDING_UPLOAD` until then. The visit cannot be streamed to (`409 VISIT_STOPPED`).

### `PUT /api/device/offline-visits/:id/audio`
Body = the whole VXREC1 file, `Content-Type: application/octet-stream`, with `Content-Length`. Max 50 MB.

| Response | Meaning / phone action |
|---|---|
| `202 { "status": "queued" }` | stored and queued (also when it was already queued: no second job). Poll GET |
| `200 { "status": "already_transcribed" }` | nothing to do; poll GET |
| `400 FILE_BAD_MAGIC` · `FILE_BAD_HEADER` · `FILE_BAD_RECORD` · `FILE_UNKNOWN_RUN` · `FILE_RUN_ORDER` · `FILE_TOO_MANY_PACKETS` · `FILE_NO_AUDIO` · `FILE_EMPTY` | the file is broken; re-uploading the same bytes won't help |
| `400 FILE_MISMATCH` | header `localId`/`clientRef` differ from the visit, or a run starts outside `recordedFrom − 10 min … recordedTo + 10 min` |
| `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` | fix the request |
| `503 STORAGE_UNAVAILABLE` · `QUEUE_UNAVAILABLE` (`retryable: true`) | try the same PUT again later |

The server validates the whole file before storing it. Not resumable: re-send the whole file. Re-uploading is always safe (idempotent per visit).

### `GET /api/device/offline-visits/:id`
```json
{ "visitId": "visit_…", "status": "needs_review", "sessionId": "sess_…", "segmentCount": 5,
  "canDeleteLocalFile": true, "error": null }
```
| `status` | Meaning |
|---|---|
| `awaiting_audio` | created, no file yet: PUT it |
| `transcribing` | file stored; queued or running (seconds to a few minutes) |
| `processing` | transcript stored, audio deleted; the draft is being made |
| `needs_review` | ready for the provider (NEEDS_REVIEW, or already approved/completed). `sessionId` set |
| `failed` | see `error { code, message, retryable }`. `retryable: true` → PUT the same file again later |

`canDeleteLocalFile` is `true` once the server holds the transcript (`processing` / `needs_review`, or `failed` with `SESSION_*` codes): **delete the local file then, not before.** Job error codes: `DEEPGRAM_UNAVAILABLE`, `DEEPGRAM_AUTH`, `TRANSCRIPTION_NOT_CONFIGURED`, `AUDIO_MISSING`, `TRANSCRIPTION_TIMEOUT`, `OFFLINE_NOT_CONFIGURED`, `INTERNAL` (all `retryable: true`); `DEEPGRAM_REJECTED`, `FILE_*` (`retryable: false`); `SESSION_NO_EVIDENCE` / `SESSION_FAILED` / … (`retryable: false`: the transcript is stored but processing ended there, e.g. a silent recording; see the session in the web app).

### Recommended phone flow
1. Offline: consent → record runs to the side file → stop → assemble `<localId>.vxrec`. Keep `localId`, client, band, times, consent time in the sidecar.
2. Online (app start / reachability change / background task): `POST` (safe to repeat) → remember `visitId` → `PUT` → poll `GET` every 3–5 s while in the foreground (or on next launch) until `needs_review` / `failed`.
3. `canDeleteLocalFile` → delete the file. `failed` + `retryable` → retry the PUT later (back off). `failed` + not retryable → keep the file and tell the provider.

## 3. Server job (`transcribe_offline`)
`SESSION_QUEUE` carries a second message kind (`SessionQueueMessage` = `QueuePayload` | `OfflineTranscribeJob`), ids only: `{ "kind": "transcribe_offline", "schemaVersion": "1", "visitId", "providerId" }`. `handleQueueBatch` routes it to `runOfflineTranscription` (`src/offline/job.ts`):

1. Read `audio-tmp/<providerId>/<visitId>.bin` from R2, parse, build the timeline, mux one Ogg Opus stream.
2. `POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&utterances=true&mip_opt_out=true` with `Authorization: Token <DEEPGRAM_API_KEY>`, `Content-Type: audio/ogg`. Each non-empty `results.utterances[]` becomes a segment: speaker `Speaker <n>` (never mapped to a name), `sourceMode: "live"`, times via the timeline. Above 480 utterances, same-speaker neighbours (gap ≤ 2 s) are merged (the evidence source reads 500).
   Local dev without a key (`RUNTIME_MODE` ≠ `deployed`): the simulated demo script (labelled `fixture`), placed from the first run's start. Deployed without a key: `failed / TRANSCRIPTION_NOT_CONFIGURED`.
3. Replace the visit's segments (`VisitStore.deleteSegments` + `saveSegments`), set packets/lost (lost packets show as a warning and make completeness `partial`), mark `transcribed`.
4. **Delete the R2 object.** (If that delete fails, the sweep deletes it on the next heartbeat.)
5. Un-cancel the appointment, `jobs.enqueueAppointment` (+ the "visit sent" notification, same as a stop), set the visit's `sessionId`. The workflow then reaches NEEDS_REVIEW and the review-link hook (`onNeedsReview`) runs as for any visit.

Retries: transient failures (Deepgram 408/429/5xx/network, D1 errors) return `msg.retry({ delaySeconds: 30, 60, 120, … ≤ 600 })`; after attempt 5 (queue `max_retries: 5`) the job is `failed`. Permanent failures (bad file, Deepgram 400/401/403) fail at once. A retry after step 3 only redoes the hand-off. The heartbeat (`scheduled`) runs `sweepOfflineAudio`: jobs stuck in `transcribing` for 6 h become `failed / TRANSCRIPTION_TIMEOUT`, and every object whose `audio_delete_after` has passed is deleted.

## 4. Privacy and retention
- **Audio:** stored in R2 only between the upload and the end of transcription (seconds to minutes), then deleted. After a final failure it is kept **24 h** (so the provider/operator can retry), then deleted by the sweep. An upload whose queue send failed is also deleted after 24 h unless re-uploaded. Never written to D1, never logged. Backstop: an R2 lifecycle rule deleting `audio-tmp/` objects after 2 days (below).
- **Transcript:** only in D1 `band_segments` (as for live visits). The audio goes to Deepgram **before** the PII scrubber (same as live; the consent screen says so); `mip_opt_out=true` keeps it out of Deepgram's model training.
- **Logs:** ids, sizes, counts, durations and error codes only (`offline.visit_created`, `offline.uploaded`, `offline.transcribed`, `offline.transcribe_retry`, `offline.transcribe_failed`, `offline.handed_off`, `offline.sweep`). Never audio, transcript text, Deepgram response bodies, keys or URLs with secrets.
- `offline_visits` holds ids, times, consent time, sizes, attempt count and error codes.

## 5. Configuration
Local dev: `wrangler.jsonc` (top level) binds `AUDIO_TMP` → bucket `vexo-audio-tmp`; `wrangler dev` simulates it under `.wrangler/state`. Apply the migration: `npm run db:migrate:local`. Smoke test (real Deepgram when `DEEPGRAM_API_KEY` is in `.dev.vars`):
```sh
node scripts/band/offline-upload-smoke.mjs            # pairs a throwaway device via dev login
node scripts/band/offline-upload-smoke.mjs --key vfad_… --packets <[u16 LE len][opus]… file> --runs 3
```

### Production (for the deploy agent: not yet applied)
1. Create the bucket: `npx wrangler r2 bucket create vexo-audio-tmp-production`.
2. Add to `env.production` in `wrangler.jsonc` (bindings are not inherited):
   ```jsonc
   // Offline recordings: uploaded band audio, kept only until transcribed (docs/offline-recording.md).
   "r2_buckets": [{ "binding": "AUDIO_TMP", "bucket_name": "vexo-audio-tmp-production" }],
   ```
3. Backstop lifecycle rule (objects normally live minutes; failed ones 24 h):
   `npx wrangler r2 bucket lifecycle add vexo-audio-tmp-production expire-audio-tmp audio-tmp/ --expire-days 2`
4. `npm run db:migrate:remote` (applies `0010_offline_visits.sql`). `DEEPGRAM_API_KEY` is already a production secret.
5. The routes are device-key routes under `/api/device/*`; if Cloudflare Access fronts the host, they need the same Access bypass as the existing device API. Request body limit: 50 MB fits Workers' 100 MB (Free/Pro) limit.

Without the binding, `POST /api/device/offline-visits` returns `503 OFFLINE_NOT_CONFIGURED`; nothing else changes.
