# Band capture and the bridge protocol

How a Vexo Open band recording becomes evidence, and what a bridge (the browser, or GlassCam on iPhone) must send. Code: `src/band/`, `src/api/visits.ts`, contract `src/contracts/band.ts`.

## Flow
```
Vexo band ──BLE──▶ bridge (Chrome/Edge page, or GlassCam on iPhone)
   Opus 16 kHz mono, 20 ms packets, seq u16          │  WS /api/visits/:id/stream
                                                      ▼
Worker CaptureSession ──▶ transcriber (Deepgram live, or simulated in local dev)
   └─ final segments ──▶ D1 band_segments (text + times only; audio is never stored)
POST /api/visits/:id/stop ──▶ appointment end = stop time ──▶ session queued ──▶ workflow
   evidence = this visit's segments (ev_001…), via BandEvidenceSource
```

## 1. Start a visit (from the web app, signed in)
`POST /api/visits` `{ clientRef, bandNumber: 1..999 | null, transport: "ble"|"serial"|"sim", timezone? }` → `201 { visit, streamUrl, streamTokenExpiresAt }`.

- The visit creates its own appointment (`appt_visit_…`). It copies the client's service plan from their most recent appointment; with no earlier appointment the call returns 422 `NO_SERVICE_PLAN`.
- The appointment stays open, so discovery ignores it, until the visit is stopped or 12 hours pass.
- `streamUrl` is `ws(s)://<host>/api/visits/<id>/stream?token=<token>`. The token is signed, valid for 4 hours and scoped to that one visit. **Treat it as a secret: never log the URL.** A native bridge only needs this URL; the user pastes it or scans it.

## 2. Stream
Connect to `streamUrl` with a WebSocket.
- **Native bridge:** the token authenticates; no cookie is needed.
- **Browser:** the cookie plus a same-site `Origin` also work.

Client → server:

| Message | When |
|---|---|
| text `{"type":"start","audioStartMs":<epoch ms>}` | **First, before any audio**: the wall-clock time of the packet with band `seq` 0. With the kit: the first `audio` event's `time`. After a band reconnect, `seq` restarts at 0, so send `start` again |
| binary `[seq u16 big-endian][Opus packet]` | One message per band AUDIO frame (50/s). The Opus bytes go exactly as the band sent them; on the BLE wire that is the AUDIO frame `13 <seq lo> <seq hi> <len> <opus…>` (see the kit's `docs/bluetooth-contract.md`). **Note:** our header is big-endian; the band's frame field is little-endian per the contract. Max 1500 bytes |
| text `{"type":"keepalive"}` | Every ~5 s when no audio is flowing (mic paused) |
| text `{"type":"stop"}` | Finish: the server flushes the transcriber, sends `done`, then closes |

Server → client (JSON text): `ready{transcriber}` (wait for it before sending audio), `interim{text}`, `final{segment}`, `stats{packets,lostPackets}`, `error{code,message}`, `done{segmentCount}`.

- Lost packets are counted from gaps in `seq`. They show up as a warning on the session, and completeness becomes `partial`.
- If the socket drops, reconnect to the same `streamUrl` and send `start` again. Segment numbering continues from what was already saved.
- Only one connection per visit should stream at a time.

## 3. Stop
`POST /api/visits/:id/stop` (signed in) → `{ visit, sessionId }`. This is idempotent. It sets the appointment's end to now and queues processing; the session then appears in Today as usual: NEEDS_REVIEW, with the approval checklist.

## Transcribers
| | When | Evidence label |
|---|---|---|
| `deepgram` | `DEEPGRAM_API_KEY` set (`.dev.vars` or `wrangler secret put`) | `live` |
| `simulated` | No key and `RUNTIME_MODE` is not `deployed`. It emits the synthetic demo script (one line per 3 s of audio, the rest at stop) | `fixture`, with a "Simulated transcript" warning |
| none | Deployed with no key | `POST /api/visits` returns 503 |

Deepgram settings are the kit's (`nova-3`, Opus 16 kHz mono, `endpointing=100`, `mip_opt_out=true`) plus `diarize=true` and `utterance_end_ms=1000`. Speakers are stored exactly as labelled (`Speaker 0`) and never mapped to names. The audio reaches Deepgram **before** the PII scrubber, which only protects the AI step. The consent screen says so.

## GlassCam (iPhone) bridge, to build
GlassCam already has a WebSocket uploader with reconnect and keep-alive (`GlassCam/Media/Broadcaster.swift`). It needs:
1. **A CoreBluetooth central.** It scans for service `254f0001-df82-4a9c-a2b5-563a0f6b2021` with the exact name `Vexo-HACK-NN`, connects and subscribes to TX `254f0003-…`. It writes commands to RX `254f0002-…`: `GET_INFO` first, checking `band_no`, then the clock set, then `STREAM_START` with the audio bit (mask 8). One command at a time, waiting for each response. The exact bytes are in the kit's `contract/contract.md` and `docs/bluetooth-contract.md`.
2. **Parse AUDIO frames** (type `0x13`) and forward each one as `[seq BE][opus]` to `streamUrl`. Send `start` first.
3. **UI:** paste or scan the `streamUrl`, show the band status, the solid-blue "mic on" state, and Stop.
4. **Test without hardware:** `node --experimental-websocket scripts/band/stream-smoke.mjs` plays the same protocol with fake packets.

## Try it locally
```sh
npm run db:migrate:local
npm run dev
node --experimental-websocket scripts/band/stream-smoke.mjs   # fake packets → simulated transcript → NEEDS_REVIEW
```
In the app: **Record visit** → pretend band → consent → Start → Stop.
