# USB bridge: iPhone ↔ Mac dev server over the cable (FROZEN protocol v1)

For when the phone can't reach the Mac over Wi-Fi (client-isolated networks). Over USB only the
**Mac can open connections to the phone** (Apple's usbmuxd, the same channel Xcode uses), so the
tunnel is reversed:

```
GlassCam app ──HTTP/WS──▶ 127.0.0.1:8787 on the PHONE (UsbRelay listener)
                               │  "OPEN <id>" on the control connection
                               ▼
Mac: scripts/band/usb-bridge.mjs ◀──usbmuxd (cable)──▶ phone port 27015 (UsbRelay)
   opens a DATA connection for <id> through the cable, and a TCP connection to the Mac's
   localhost:8787 (wrangler dev), then pipes bytes both ways. Plain TCP: HTTP and WebSockets work.
```

Nothing touches Wi-Fi or the internet. The phone pairs with `server=http://127.0.0.1:8787`, and
stream URLs are `ws://127.0.0.1:8787/...` (set `PUBLIC_APP_ORIGIN=http://127.0.0.1:8787` and
`PUBLIC_STREAM_ORIGIN=ws://127.0.0.1:8787` in `.dev.vars` while using the bridge).

## Phone side (GlassCam `UsbRelay`)
- **App listener:** TCP `127.0.0.1:8787` (loopback only). Each accepted connection waits for a
  DATA connection from the Mac (timeout 10 s, then it is closed).
- **Bridge listener:** TCP port **27015** on the loopback interface (usbmuxd connects to the
  device's localhost). If loopback binding turns out unreachable through usbmux, bind to any
  interface **and require the secret** (below) on every connection.
- All bridge connections start with ONE ASCII line ending in `\n`:
  - `FAUSB1 CONTROL <secret>` — at most one control connection; a new one replaces the old.
  - `FAUSB1 DATA <id> <secret>` — the data connection for pending app connection `<id>`.
  - Anything else, a wrong secret, or no line within 5 s → close.
- `<secret>`: 32 hex chars shown in the app's Band visit tab (“USB bridge” section) and
  regenerated on each app launch. The Mac script takes it as `--secret`.
- **Control messages** (phone → Mac, one line each): `OPEN <id>` when the app opens a
  connection (`<id>` = decimal counter). `PING` every 10 s; the Mac answers `PONG`. If the
  control connection is down, app connections are refused immediately (the app then shows
  “can't reach Field Assistant”).
- After the DATA line is read, the phone pipes the two sockets until either closes.

## Mac side (`scripts/band/usb-bridge.mjs`, Node 20, no native deps)
- Talks to usbmuxd directly over `/var/run/usbmuxd` (binary header + XML plist protocol:
  `ListDevices`, `Listen`, `Connect` with `DeviceID` and `PortNumber` in network byte order).
- Picks the first USB-attached iPhone (or `--udid`). Connects to device port 27015, sends
  `FAUSB1 CONTROL <secret>`, answers `PING` with `PONG`, and on each `OPEN <id>`: opens a new
  usbmux connection to 27015, sends `FAUSB1 DATA <id> <secret>`, opens TCP to
  `--target 127.0.0.1:8787`, pipes both ways. Reconnects (2 s back-off) when the phone app is
  not running or the cable is unplugged. Logs connection counts and bytes, never payloads.
- Usage: `node scripts/band/usb-bridge.mjs --secret <from the app> [--target 127.0.0.1:8787] [--udid …]`

## Troubleshooting (Mac side)
- `node scripts/band/usb-bridge.mjs --list` shows what usbmuxd sees (UDID, `USB`/`Network`). No
  rows → unlock the phone, re-plug the cable, accept "Trust This Computer". Only `Network` rows →
  the cable isn't carrying data (charge-only cable or hub); the bridge prefers `USB` entries.
- `waiting for GlassCam on the phone (open the Band visit tab)…` repeating → usbmuxd answered
  `Connect` with result 3 (connection refused): nothing listens on device port 27015. Open the app
  on the Band visit tab; run with `--verbose` to see the per-attempt reason.
- `control connection closed by the phone right away — is --secret current?` → the phone rejected
  the CONTROL line. The secret is regenerated on every app launch; copy it again.
- `OPEN <id> closed (target 127.0.0.1:8787 refused …)` → the Mac dev server (`npm run dev`) is not
  running, or use `--target` for a different port.
- `cannot reach usbmuxd at /var/run/usbmuxd` → usbmuxd isn't running (it is on-demand on macOS;
  plugging in a device or opening Finder's device view starts it).
- Tests (no phone needed): `node --test scripts/band/usb-bridge.test.mjs`.
