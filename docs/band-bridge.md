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
- `streamUrl` is `ws(s)://<host>/api/visits/<id>/stream?token=<token>`. `<host>` is the request's host, or `PUBLIC_STREAM_ORIGIN` when that is set (see [Phone handoff](#phone-handoff-glasscam)). The token is signed, valid for 4 hours and scoped to that one visit. **Treat it as a secret: never log the URL.** A native bridge only needs this URL; the user pastes it or scans it.

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
`POST /api/visits/:id/stop` (signed in, or `?token=<stream token>` from a bridge) → `{ visit, sessionId }`. This is idempotent. It sets the appointment's end to now and queues processing; the session then appears in Today as usual: NEEDS_REVIEW, with the approval checklist.

## Phone handoff (GlassCam)
A visit started in the web app can be recorded by the iPhone app instead of the browser. In **Record visit**, pick **Record on iPhone (GlassCam)**, enter the band number, choose the client, confirm consent and press **Start on phone**. The page calls `POST /api/visits` (`transport: "ble"`) and shows a QR code plus **Copy link** for the deep link below. It then polls `GET /api/visits/:id` every 3 s (status, packets, segment count, the latest lines). When the visit is `stopped` with a `sessionId`, it waits for processing and opens `#/sessions/<sessionId>`. **Stop from here** (`POST /api/visits/:id/stop`, cookie) covers a phone that is gone.

### Deep link
```
glasscam://band-visit?stream=<encodeURIComponent(streamUrl)>&band=<bandNumber>&client=<clientRef>
```
- `stream`: the full `streamUrl` (with `?token=`), percent-encoded once. Decode it, then use it as is.
- `band`: the band number, 1 to 999. It is **omitted** when the user left the number empty (GlassCam then lets them pick a band).
- `client`: the client **ref** (e.g. `C-104`), never a name. It is for display only; the visit is already bound to the client.
- The link carries the stream token, so it is a **secret** until `streamTokenExpiresAt` (4 h). The page hides the raw link behind **Show link** with that warning. Never log it.

Helpers: `src/ui/components/visit/handoff.ts` (`glasscamLink`).

### Reaching the Worker from the phone
The phone can't reach `localhost`. Set an origin the phone can reach and listen on every interface:
```sh
# .dev.vars
PUBLIC_STREAM_ORIGIN=ws://192.168.1.20:8787     # this Mac's LAN IP (ipconfig getifaddr en0)
# then, instead of plain wrangler dev:
npm run build:ui && npx wrangler dev --port 8787 --ip 0.0.0.0
```
- `PUBLIC_STREAM_ORIGIN` (optional) must be `ws://` or `wss://` (deployed: `wss://field.example.com`). Only the scheme, host and port are used. Any other value is ignored and logged as `visit.public_stream_origin_invalid`, and the request host is used instead.
- When the `streamUrl` host is still `localhost`/`127.0.0.1`, the page shows a warning that says exactly this.
- The web app itself can stay on `http://localhost:8787` (dev login only works on loopback).

### Bridge endpoints (token auth, no cookie)
The token is the `token` query parameter of `streamUrl`. It is scoped to that one visit: a bad or expired token, or one minted for another visit, returns `401 UNAUTHENTICATED`.

| Request | Response |
|---|---|
| `GET /api/visits/:id/stream?token=…` | WebSocket (section 2) |
| `GET /api/visits/:id/status?token=…` | `200 { data: { visit } }`. `visit.status` is `recording` or `stopped`, plus `packets`, `lostPackets`, `segmentCount`, `sessionId` |
| `POST /api/visits/:id/stop?token=…` (no body needed) | `200 { data: { visit, sessionId } }`. The same logic as the cookie route, and idempotent |

Without `?token=`, these paths fall through to the normal cookie routes. `GET /api/visits/:id/status` also works signed in.

**Origin header rule.** Every non-GET request passes the global origin guard (`src/security` `originGuard`): it needs an `Origin` header equal to `APP_ORIGIN` or to the request's own origin. URLSession sends no `Origin`, so GlassCam must set `Origin: <scheme>://<host>[:port]` of the URL it calls. For `ws://192.168.1.20:8787/...` that means calling `http://192.168.1.20:8787/api/visits/<id>/stop?token=…` with `Origin: http://192.168.1.20:8787`. Without it the stop returns `403 ORIGIN_REJECTED`. The HTTP base comes from `streamUrl`: `ws:` becomes `http:` and `wss:` becomes `https:`. GET (status) and the WebSocket with a token need no `Origin`.

Recommended phone flow: send `{"type":"stop"}` on the socket and wait for `done` (this flushes the transcriber). Then call `POST …/stop?token=` to hand the visit to processing. The web page notices within 3 s and opens the session.

## Paired devices
A phone (GlassCam) is paired **once** with a long-lived device key. It can then list the provider's clients and start, follow and stop band visits on its own, with no web page open, until the provider removes it. Contract (frozen): `src/contracts/devices.ts`. Code: `src/devices/` (key, store, auth), `src/api/device.ts` (device API), `src/api/devices.ts` (web management), UI **Settings → Devices** (`src/ui/components/settings/DevicesSection.tsx`). Table: `paired_devices` (`migrations/0008_devices.sql`).

### Pairing (web, signed in)
**Settings → Devices** → name the phone → **Pair a phone**. The page calls `POST /api/devices` `{ name }` and shows a QR code, **Copy link** and **Show link** for:
```
glasscam://pair?server=<origin>&key=<device key>&name=<encodeURIComponent(name)>
```
- `key`: `vfad_` + 43 base64url chars (32 random bytes). It is returned **once**. The server stores only `SHA-256(key)` (hex, `key_hash`), never the key. It works until the device is removed. **Never log it.**
- `server`: the http(s) origin the phone calls, inserted as is (no path). It is `PUBLIC_APP_ORIGIN` when set (e.g. `http://192.168.1.20:8787` on the LAN, or the deployed `https://…`), else `PUBLIC_STREAM_ORIGIN` with `ws:`→`http:` / `wss:`→`https:`, else `APP_ORIGIN`. When it is localhost the page warns that the phone can't reach it (set one of those vars, then remove and re-pair).
- `name`: the label the provider typed (1 to 60 chars), percent-encoded.
- At most 10 active devices per provider (`409 TOO_MANY_DEVICES`). **Remove** revokes a device (confirm dialog); its key fails at once with `401 DEVICE_REVOKED`.

| Web (cookie) | Response |
|---|---|
| `GET /api/devices` | `PairedDevice[]` `{ id, providerId, name, createdAt, lastSeenAt, revokedAt }`: never a key or hash |
| `POST /api/devices` `{ name }` | `201 { device, key, pairingLink }` (once) |
| `DELETE /api/devices/:id` | `{ revoked: true }` (idempotent; another provider's device is 404) |

### Device API (bearer key, no cookie)
Every request sends `Authorization: Bearer vfad_…`. **No `Origin` header is needed**: the origin guard skips `/api/device/*` when that bearer header is present (bearer auth is not CSRF-able). Without it, POSTs there are still `403 ORIGIN_REJECTED`. Everything is scoped to the device's provider: another provider's visit is `404`. `lastSeenAt` is updated at most once a minute.

| Request | Response |
|---|---|
| `GET /api/device/me` | `{ device, provider: { id, identity }, transcribers }`. `transcribers` = what this server can run: the server's choice (`deepgram`, or `simulated` in local dev) first when available, then `device` (always accepted) |
| `GET /api/device/clients` | `[{ clientRef, displayName, preferredName }]`: active stored clients, plus client refs with a non-band appointment and no stored record. Names are for the provider's own phone only |
| `POST /api/device/visits` `{ clientRef, bandNumber: 1..999\|null, transport, timezone?, transcriber?: "server"\|"device" }` | `201 { visit, streamUrl, streamTokenExpiresAt }`, the same as `POST /api/visits` (service plan from the client's last appointment, `422 NO_SERVICE_PLAN`, `PUBLIC_STREAM_ORIGIN`). Default `transcriber: "server"`: the phone only records and streams audio, the Worker transcribes (Deepgram; simulated in local dev without a key; deployed without a key → `503 TRANSCRIPTION_NOT_CONFIGURED`). `"device"`: on-phone transcription, `visit.transcriber = "device"` (optional path) |
| `GET /api/device/visits/:id` | `{ visit, segments }` |
| `POST /api/device/visits/:id/stop` | `{ visit, sessionId }` (idempotent, same logic as the cookie route) |
| `GET /api/device/inbox` | `{ items: DeviceInboxItem[], generatedAt }`: visits waiting for the provider's review, newest first (max 20). See [Review inbox](#review-inbox-phone-notifications) |

**Offline recordings** (phone had no internet): `POST /api/device/offline-visits`, `PUT /api/device/offline-visits/:id/audio` (a VXREC1 file), `GET /api/device/offline-visits/:id`. Contract (frozen) `src/contracts/offline.ts`; full description [offline-recording.md](offline-recording.md).

Errors: missing/malformed/unknown key → `401 UNAUTHENTICATED`; removed device → `401 DEVICE_REVOKED` (GlassCam should forget the pairing and ask to pair again).

### Review inbox (phone notifications)
When a visit finishes processing (`NEEDS_REVIEW`), the server creates a **review link** and posts an in-app notification. GlassCam polls `GET /api/device/inbox` (same bearer key; e.g. every 60 s while foregrounded, and on app open / background refresh) and shows a local notification for each `sessionId` it has not shown yet:

```jsonc
{ "data": { "generatedAt": "…", "items": [{
  "sessionId": "sess_…", "clientRef": "C-104",
  "serviceStartAt": "2026-11-13T15:00:00.000Z", "timezone": "America/Chicago",
  "bundleRevision": 1, "blockingCount": 2, "minutesEstimate": 90,
  "title": "Visit for C-104 is ready — tap to review",
  "reviewUrl": "https://<PUBLIC_APP_ORIGIN>/r/vfrl_<43 chars>", "reviewUrlExpiresAt": "…",
  "updatedAt": "…"
}]}}
```
- Tapping the notification opens `reviewUrl` in Safari / `SFSafariViewController` (not a WebView that strips the path). It is the **full review page** (documents, checklist, corrections, Approve). Opening it approves nothing. No sign-in is needed: the token in the URL is the credential, scoped to that one session of that provider.
- Dedupe on `sessionId` + `bundleRevision`: an amended visit comes back with a higher `bundleRevision` and a new `reviewUrl`. An item disappears from the inbox once the visit is approved; withdraw its notification then.
- `reviewUrl` is stable across polls while the link is open. It is `null` only when the server has no `SESSION_SECRET`. Treat it as a secret: don't log it or put it in analytics.
- The body carries the client **ref** only, never names or transcript. Keep the notification text to `title`.
- Link errors shown by the page: expired after 7 days (`410 REVIEW_LINK_EXPIRED`), revoked in the app (`410 REVIEW_LINK_REVOKED`), already approved (`410 REVIEW_LINK_USED`, 15 min after completion), malformed/unknown (`401 INVALID_REVIEW_LINK`).
- With Cloudflare Access in front of the whole hostname, the phone's browser signs in to Access first, then the link works as usual. Streaming still uses the returned `streamUrl` (section 2). `POST /api/visits` (cookie) also accepts `transcriber: "device"`.

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
3. **UI:** open the `glasscam://band-visit` deep link (or paste the `streamUrl`), show the band status, the solid-blue "mic on" state, and Stop (socket `stop`, then `POST …/stop?token=` with the `Origin` header; see [Phone handoff](#phone-handoff-glasscam)).
4. **Test without hardware:** `node --experimental-websocket scripts/band/stream-smoke.mjs` plays the same protocol with fake packets.

## Try it locally
```sh
npm run db:migrate:local
npm run dev
node --experimental-websocket scripts/band/stream-smoke.mjs   # fake packets → simulated transcript → NEEDS_REVIEW
```
In the app: **Record visit** → pretend band → consent → Start → Stop.
