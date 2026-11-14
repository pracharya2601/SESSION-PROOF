# GlassCam + Vexo Open band: code review, hands-on test plan, field-readiness gaps

Date: 2026-11-14. Scope: `GlassCam/GlassCam/Band/` (iPhone app, Swift 6, not under git) checked against
the band kit contract v1.1 (`vexo-open-kit/contract/contract.md`, rev 2026-11-12) and
`contract/test-vectors.json`. No app source was changed.

Paths used below:

- App: `/Users/prakashacharya/Desktop/megent/GlassCam/GlassCam/Band/`
- Kit: `/private/tmp/claude-501/-Users-prakashacharya-Documents-field-assist/475a8457-109e-4849-9767-0bced8ade2b1/scratchpad/vexo-open-kit/`
- Vector harness (throwaway, a copy of `BandProtocol.swift` plus a runner):
  `/private/tmp/claude-501/-Users-prakashacharya-Documents-field-assist/475a8457-109e-4849-9767-0bced8ade2b1/scratchpad/band-review/main.swift`.
  Run it with `swiftc -O BandProtocol.swift main.swift -o vt && ./vt <kit>/contract/test-vectors.json`.

---

## 1. Code review against the contract

### 1.1 What is correct (checked with the test vectors)

The harness ran every vector that touches the parts the app implements. Result: everything passes
except one audio vector (finding B10).

- Command encoding: GET_INFO, IDENTIFY, TIME_SET (u64 LE), STREAM_START and STREAM_STOP (mask u16
  LE) and BATTERY_GET all match the vector hex byte for byte.
- Response header `[02][seq][opcode][status][data]`: all 51 response vectors parse, and seq,
  opcode and status come out right.
- GET_INFO offsets: proto 0 and 1, fw 2 to 4, hw 5, band_no u16 at 6, caps at 8, max_frame at 10,
  uptime at 12. Both GET_INFO vectors decode (fw 1.0.0 and 1.1.0, band 42, max_frame 244).
- EVENT `[11][t_ms u32][event][arg]`: code at byte 5 and arg at byte 6 are correct, so all 8 event
  vectors pass, including orientation arg 4 and the unknown code 200. The short frame
  `1101000000` is rejected.
- NOTICE `[03][code][arg]`: all 7 vectors pass.
- AUDIO `[13][seq u16 LE][len][opus]`: seq 65535 parses correctly, and a `len` longer than the
  data is rejected.
- BATTERY percent and state are right.
- Unknown frame type `0x7f` is ignored.
- The advertised name works for 00, 07, 42 and 999. The manufacturer-data parse reads
  `FF FF 4F 01 2A 00` as band 42. CoreBluetooth puts the company ID at the start in little-endian
  order, which is what the code expects.
- Seq and opcode matching (`VexoBand.swift:287`), the 2 s timeout (`:266-271`), subscribing to TX
  before the first command (`:373-378`) and the 120 s rescan window after a drop (`:144`) all
  follow the contract.

### 1.2 Findings, most severe first

| # | Severity | Where | Problem and impact | Fix |
|---|---|---|---|---|
| B1 | High | `VexoBand.swift:296-297` (notice handler); `BandVisitView.swift:13`; `BandVisitModel.swift` (nothing listens) | **CRITICAL_BATTERY (Notice 2) leaves the visit stuck.** The handler only sets `phase = .failed(...)`. `wantAudio` stays true, `BandVisitModel.phase` stays `.recording`, the WebSocket stays open with keepalives, and no audio arrives. The UI shows "Mic on" with a running timer. The band test section disappears because it only renders in `.ready` or `.streaming`, so `test.isListening` stays true. `stopAudio()` then leaves the phase as `.failed`, since it only resets from `.streaming`. Leaving is dangerous too: once the client disconnects, the band can't be found until it is on USB power (contract §6). | Add an `onCriticalBattery(percent)` callback. In `VexoBand`, set `wantAudio = false`, keep the link (**do not** call `disconnect()`), and set a `batteryCritical` flag with the phase back at `.ready`. In `BandVisitModel`, auto-`finish()` so the transcript is flushed and the visit handed over, and show "Band battery critical: plug it in. Don't disconnect." Stop `BandTestModel` too. |
| B2 | High | `VisitStreamer.swift:116-117`; `BandVisitModel.swift:205-210` | **Audio is dropped at the start of every visit and during every WebSocket reconnect.** `send()` returns early unless `ready`. `start()` calls `s.open()` and then `band.startAudio()` straight away, so every packet before the server's `ready` is thrown away. That is typically the first 0.3 to 2 s, and longer on a weak network. The greeting or the first sentence of a visit is lost, and so is every outage on a mobile network. | Add a buffer that keeps packets in order. Section 3.4 has the design. As a minimum, an in-memory ring of `relayPacket` Data (about 60 B each, about 3 KB/s) that is flushed in order after `start` once `ready` arrives. |
| B3 | High/Med | `VexoBand.swift:162-169` (`scanFailed`), `:196-202` (handshake catch), `:333-336` (`didFailToConnect`) | **A lost band never reaches the visit.** Three things leave the band `.failed` with no callback: the 120 s reconnect window running out, a failed handshake during reconnect, and `didFailToConnect` during reconnect, which also has no retry. `BandVisitModel` stays `.recording` forever and the user only sees a red label in the band section. | Add an `onLinkLost(reason)` callback. In the model, show an alert banner and either keep waiting (manual "Retry band") or `finish()` with what the server has. In `didFailToConnect` while `wantAudio`, retry (`central.connect(peripheral)`) until the window deadline. |
| B4 | Med | `VexoBand.swift:307-309` | **Bluetooth turned off or reset mid-visit is not handled.** When the central goes `.poweredOff` or `.resetting`, iOS drops the link without reliably calling `didDisconnectPeripheral`. `centralManagerDidUpdateState` only rescans when `connectContinuation != nil` or the phase is `.reconnecting`. The app shows `.streaming` with no audio, and `rx` and `tx` point at dead objects. | In `didUpdateState`: if the state is not `.poweredOn` and `peripheral != nil`, clear `rx` and `tx`, call `failPending`, and set the phase to `.reconnecting` (if `wantAudio`) or `.bluetoothOff`. On `.poweredOn` with `wantAudio`, reconnect. |
| B5 | Med | `VexoBand.swift:95-105`, `:259` | **STREAM_STOP can be skipped silently, so the mic stays on.** `command()` throws "already running" when another command is pending. That happens with a "Flash light" tap, a reconnect handshake, or a test start/stop racing a double-tap. `stopAudio()` uses `try?`, so the stop is never sent, but the app still flips to `.ready`. The band keeps the mic on with the blue LED lit and keeps streaming. The same thing happens if the STREAM_STOP response times out. | Replace "throw if busy" with a serial command queue (an actor or an `AsyncStream` of jobs, so each command waits for the previous one). For STREAM_STOP, retry once on timeout and confirm with the returned `active` mask: audio bit 3 must be clear. Otherwise send STREAM_GET. |
| B6 | Med | `VexoBand.swift:285-289`, `:205-209`; `BandProtocol.swift:116-117` | **The response length checks the contract requires (§2.2, §3) are missing.** `handle()` accepts any response whose seq and opcode match. Contract rule: an OK response whose data length is wrong must be ignored, and the client keeps waiting until the timeout. `parseInfo` accepts `>= 16` when it should require exactly 16. `startStreams()` checks `status == 0` but never reads the **`active` u16**, so it never confirms that bit 3 (audio) is really active. | Keep a table `expectedLen: [UInt8: ClosedRange<Int>]`: GET_INFO 16, TIME_SET 13, STREAM_START/STOP/GET 2, IDENTIFY 0, BATTERY_GET 4, GET_NAME 12...13, STORE_GET 1...232, and so on. Any status other than OK must have 0 bytes. In `handle()`, `guard expected.contains(r.data.count) else { return }`, which keeps `pending`. In `startStreams()`, `guard let active = readU16(r.data, 0), active & audioBit != 0`. |
| B7 | Med | `VexoBand.swift:189`, `:206` | **The handshake STREAM_START (battery and event) ignores its status, and battery is mixed into the audio start.** With a critical battery, STREAM_START of BATTERY is DENIED. For the other DENIED cases the contract says nothing in the mask starts, so EVENT (double-tap) is probably off too, silently. The audio start also sends `audio|battery|event`, so under critical battery the user sees "refused to start the microphone (denied)", which points at the wrong cause. | Start EVENT on its own (bit 1) and BATTERY on its own (bit 4), and check each status. Start audio with bit 3 only, since battery and event are already running. On DENIED, call BATTERY_GET and say "battery critical" in plain words. |
| B8 | Low/Med | `VexoBand.swift:199-201` then `:342-349`; `:140-147` | **The handshake error is overwritten, and the reconnect window is restarted.** On a handshake failure the code sets `.failed("This is Vexo-HACK-07, not ...")` and then calls `cancelPeripheralConnection`. `didDisconnect` then runs and overwrites it with "The band disconnected.". With `wantAudio` set, every failed handshake re-enters `.reconnecting` and starts a **fresh** 120 s timer, so the app can keep scanning long after the band's real window has closed. | Set `wantedNumber = nil` (or a `tearingDown` flag) before the cancel. Compute one `reconnectDeadline = dropTime + 120 s` when the drop happens, and don't extend it. |
| B9 | Low | `VexoBand.swift:296-297` | **LOW_BATTERY (1), STREAM_DROPPED (3) and USB_POWER (4) are ignored.** Notice 3 is the band's own explanation for gaps in `seq`. Without it, "lost" packets can't be told apart from radio loss. | Count Notice 3 per stream, and show low battery and USB plug state (section 2, rows A3 and A4). |
| B10 | Low | `BandProtocol.swift:101` | **An AUDIO frame with `len` 0 is rejected.** The vector `13000000` is valid (seq 0, empty Opus). Dropping it makes the next frame look like 1 lost packet. It is rare in practice. | Accept `len == 0`: return `.audio` with empty Opus. The decoder already skips empty packets (`BandAudioDecoder.swift:34`). Still forward it to the relay, or count it as received. |
| B11 | Low | `BandProtocol.swift:107-109` | BATTERY needs 5 bytes (`percent`, `state`, `millivolts u16`), but the parser accepts 3 and ignores millivolts and state. | `guard b.count >= 5`. Add `millivolts`, and publish `state` (charging or charged) in `VexoBand`. |
| B12 | Low | `BandProtocol.swift:116-119`; `VexoBand.swift:180-187` | GET_INFO ignores `proto_major` (must be 1), `caps` (bit 4 mic, bit 6 battery, bit 2 motion events, bit 3 step counter), `hw` and `uptime_ms`. The TIME_SET response (13 bytes: `set`, `unix_ms`, `t_ms`) is discarded, but it is exactly what converts EVENT and ACTIVITY `t_ms` to wall-clock time (§5.8). | Parse caps and refuse audio with a clear message if bit 4 is clear. Keep `(unix_ms, t_ms)` from the TIME_SET response to timestamp events. Warn if `proto_major != 1`. |
| B13 | Low | `VexoBand.swift:338-347` | **Reconnect rescans instead of connecting directly.** In the background, scans are throttled and the scan response (local name) may not arrive. The manufacturer-data fallback covers the name, which is good. A direct `central.connect(peripheral)` to the retained `CBPeripheral` is a pending connect with no timeout. iOS completes it as soon as the band advertises, even while locked. | On a drop while `wantAudio`: `central.connect(self.peripheral!)` straight away, keep the scan as a backup, and cancel both at the deadline. |
| B14 | Low | `VexoBand.swift:265`; no `didWriteValueFor` | Write errors (ATT error, for example if the TX subscription was lost) are never seen. Every one costs the full 2 s timeout. | Implement `peripheral(_:didWriteValueFor:error:)`. If an error arrives for the pending write, fail that command at once. |
| B15 | Low | `BandTestModel.swift:78`; `BandAudioDecoder.swift:37-39` | `samples.removeFirst(n)` on a 160k-sample array runs on every packet once the 10 s buffer is full (about 8M float moves a second on the main actor). In the decoder, a seq that goes backwards (stale packet, or a restart without `reset`) counts about 65k "lost". | Use a ring buffer index. Treat `d > 32768` as a restart or reorder: reset, and don't count it as loss. |

Not bugs, but worth knowing:

- `IDENTIFY` is only offered in `.ready` (`BandVisitView.swift:117`), which is right because it is
  DENIED while the mic is on. Its status is ignored, though, so DENIED under critical battery fails
  silently.
- A double-tap still produces EVENT code 2 while connected. The contract's "does nothing" refers only
  to opening the connect window.

---

## 2. Hands-on test plan (band connected to the iPhone)

### How to read this

- **Now**: what build 1 (the current app) already shows.
- **Next build**: the smallest UI or code change that would show it.
- Run the tests standing about 1 m from the phone unless a test says otherwise. Note results in
  the "Result" column of a copy of this file.

### Shared change for the next build: a "Band diagnostics" section

Most rows need the same small additions. Build them once:

1. `BandProtocol.parse`: add the cases `.activity(tMs, steps, cadence, state, motionMg)` (13-byte
   body), `.temp(tMs, milliC i32)` (8), `.link(tMs, rssi i8, tx i8, phy)` (7),
   `.micLevel(tMs, peak, rms)` (6) and `.motion(tMs, periodMs, [Sample])` (6 + 12 × count). The
   vectors in `test-vectors.json` "streams" are the unit tests. The harness above can be extended
   with them.
2. `VexoBand`: add `func send(_ op: UInt8, _ args: [UInt8]) async throws -> Response`, a raw
   command used by the diagnostics screen. It needs the serial queue from B5. Add observable
   properties: `info` (all GET_INFO fields), `battery` (percent, state, mV), `tempC`, `rssi`,
   `micPeak` and `micRms`, `activity`, `lastMotion`, `notices: [String]`, and
   `events: [(Date, code, arg)]` (the last 30).
3. `BandDiagnosticsView` (a new `Section`, or a pushed screen from the band section): an info
   block, a live values block, an event log list, toggles "Stream activity / temp / link
   (0x0064)", "Mic level (lights the blue LED)" and "Motion 25 Hz", plus buttons "LED test",
   "Storage test" and "Read clock". Each toggle sends STREAM_START or STREAM_STOP with its bit.
   The handshake should start EVENT for **all** codes (it already does), and diagnostics just
   stops discarding them.

Mask cheat sheet: event 0x0002, activity 0x0004, audio 0x0008, battery 0x0010, temp 0x0020,
link 0x0040, mic_level 0x0080, motion 0x0001. "Diagnostics without mic" = 0x0076.

### 2.1 Field-visit essentials (test these first)

| # | Capability | Now | Next build | Physical action | Expected result | Result |
|---|---|---|---|---|---|---|
| A1 | **Audio (mic to phone)** | Yes: "Test microphone" shows a level meter, loudness dB and peak, packets received and lost, and "Play last N s" | Add packets/s and a "Notice 3 count" (B9) | Tap Test microphone. Stay silent 5 s, speak normally at 30 cm for 10 s, then say a sentence from 2 m away. Stop and press Play. | The band LED goes **solid blue** while the mic is on. Packets rise about **50 per second** (about 3,000 a minute). Lost stays 0 at 1 m. Silence reads about -60 dB or lower, speech -35 to -20 dB, and peak rises. Playback is intelligible (normalised, so it may hiss) and the 2 m sentence is audible. | |
| A2 | **Audio range and body blocking** | Yes (lost counter) | Same as A1 | During the mic test, put the phone in a back pocket, then walk 5 m, 10 m and to the next room. | Pocket at 1 m: lost under 1%. Lost grows with distance and walls. Beyond range, the band shows "Link dropped, reconnecting..." (see A6). | |
| A3 | **Battery** | Partly: "battery N%" in the band status line (BATTERY stream). State and mV are not shown. | Show `state` (on battery, charging, charged) and mV. Show Notice 1 and 4 as banners. | Read the %. Plug the band into USB for 1 minute, then unplug. | % is plausible, and it never rises while on battery. Plugging in shows "charging" in the next build (now: nothing changes). Unplugging shows "on battery". Notice 4 arg 1, then 0. | |
| A4 | **Battery low or critical** | Broken (B1): critical leaves the visit stuck | B1 fix plus banners | Can't be forced safely. Only if a band is nearly empty: let it run with the mic on. | Notice 1 appears below 3.5 V (LED dimmer). Notice 2 appears below 3.3 V: streams stop and the LED goes off. After the B1 fix the visit finishes itself and the app says "plug in, don't disconnect". | |
| A5 | **Double-tap** | Yes: "Double-taps seen" counter. With "Double-tap ... to start / stop" on, and paired with a client and consent, it starts or stops recording. | Event log (shows all codes with time) | Tap the band face twice quickly (about 0.3 s apart, firm, as on a table) 10 times. Then try 10 gentle double-taps. | Counter +1 per double-tap, at least 9 of 10 firm ones. Gentle ones may miss (threshold 800 mg). No count from walking or arm swings. With recording ready: a double-tap starts the visit and the next one stops it. | |
| A6 | **Reconnect after a drop** | Yes: phase "Link dropped, reconnecting..." and a 120 s rescan (only while the mic is on) | B3, B8, B13 fixes; show a countdown | Start the mic test, walk out of range (or wrap the band in foil) for 20 s, then come back. Repeat with 3 minutes away. | Within about 2 to 5 s of coming back, the phase returns to streaming, packets resume and a few hundred are counted lost. After 3 minutes away (more than 120 s) the phase is "Could not see..." (now the visit stays "recording": B3). | |
| A7 | **Activity / steps** | No | Diagnostics: start ACTIVITY (0x0004). Show steps since start (`steps_total - first`), cadence, state (still, walk, run) and motion_mg. | Stand still 10 s. Walk 30 counted steps with the band on the wrist. Jog on the spot 10 s. | Still: state 0, motion_mg small. Walking: state 1, cadence about 90 to 120 spm, steps since start about 30 (±3). Jogging: state 2, cadence above 140. One frame per second. | |
| A8 | **Lock screen / background** | Untested: `bluetooth-central` is in Info.plist | none (see section 3) | Start a real visit, lock the phone, talk for 3 minutes, unlock. | Packets kept counting and transcript lines cover the locked period. If not, see section 3.1. | |

### 2.2 Motion events (all from the EVENT stream the app already starts, but it drops every code except 2)

All rows: **Now = No** (only code 2 is used, at `VexoBand.swift:295`). **Next build** = the event
log in diagnostics, which shows name, arg and time for each EVENT frame.

| # | Event (code) | Physical action | Expected result | Result |
|---|---|---|---|---|
| E1 | Single tap (1) | Tap the band once, firmly. Wait 1 s. | Code 1 for each single tap. A double-tap gives code 2 (and possibly a 1 before it). | |
| E2 | Free-fall (3) | Take the band off and drop it about 40 cm onto a bed or cushion. | Code 3: total acceleration under 0.35 g for 100 ms. A 20 cm drop may be too short. | |
| E3 | Tilt (4) | Wrist flat, then rotate the forearm more than 35° (palm sideways) and **hold 2 s**. | Code 4 after about 2 s of hold. Nothing if you rotate back within 2 s. | |
| E4 | Orientation (5) | Lay the band flat face up on a table, then face down, then on its edge. Hold each 1 s. | Code 5 with `arg` = face up: 4 (+Z) or 5 (-Z) for flat, 0 to 3 for the edges. One event per change (300 ms above 0.8 g). | |
| E5 | Motion started (6) / stopped (7) | Leave the band still 5 s, shake or walk 3 s, then keep still 3 s. | Code 6 after about 2 s of movement (above 0.1 g), code 7 after about 2 s still (below 0.05 g). | |
| E6 | Tap threshold (EVENT_SET 0x22) | Diagnostics "Tap sensitivity" stepper: 400, 800 (default), 2000 mg | At 400, gentle taps register. At 2000 only hard knocks do. The double-tap that opens the connect window always stays at 800. | |

### 2.3 Device information, clock, link

| # | Capability | Now | Next build | Physical action | Expected result | Result |
|---|---|---|---|---|---|---|
| D1 | GET_INFO | Partly: firmware shown, band number checked | Info block: proto `1.1`, fw, hw, band_no, caps as a list, max_frame, uptime | Connect | proto 1.1, fw **1.1.0**, hw 1, band_no = the number on the bag, caps **0x07FF** (all 11 parts passed self-test; any missing bit names a broken part), max_frame 244 (or lower if the iPhone negotiated a smaller MTU), uptime = time since the band was switched on | |
| D2 | Clock (TIME_SET 0x07 / TIME_GET 0x08) | Sent on connect, result not shown | "Read clock" button: TIME_GET; show `set`, band time and the difference from phone time | Connect, tap Read clock. Reconnect after 10 min and read again. | `set` = 1, difference under about 50 ms right after connect, still under about 100 ms 10 minutes later (drift about 2 s a day) | |
| D3 | Link RSSI (LINK stream bit 6, or RADIO_GET 0x41) | No | Live RSSI (dBm), tx power and PHY (1M or 2M). RADIO_GET also gives interval and MTU. | Start LINK. Hold the band next to the phone, then at 3 m, then 10 m. | About -40 to -55 dBm close, -65 to -75 at 3 m, under -85 near the edge. 127 = no reading. PHY 2 on recent iPhones. tx -8 dBm. While audio streams the interval is 12 units (15 ms). | |
| D4 | Chip temperature (TEMP bit 5) | No | Live °C (temp_mc / 1000) | Start TEMP, wait 15 s, then hold the band in your fist for 1 minute | A frame every 5 s, reading about 28 to 38 °C (the chip warms itself, so it reads above room temperature, in 0.25° steps). It rises slowly in the fist. This is not skin temperature. | |
| D5 | Mic level (MIC_LEVEL bit 7) | No (the app's meter is decoded from Opus instead) | Peak and RMS bar from the stream. Warn that it lights the blue LED. | Start it with AUDIO off: silence, then speak, then clap | 10 frames a second, values in dB below full scale: silence about 80 to 96, speech about 30 to 50 RMS, a clap peak under 10. The LED is solid blue the whole time, even though no audio is sent. | |
| D6 | Mic gain (MIC_SET_GAIN 0x30) | No | Stepper 40 (0 dB) to 80 (+20 dB, the default) | During A1, set 40 and speak | The level drops about 20 dB within one frame. Restore 80. | |
| D7 | Motion (MOTION bit 0, about 320 B/s at 25 Hz) | No | Show live ax, ay, az in g (milli-g / 1000) and gyro dps (/10). Optionally a tiny sparkline. | Start it, keep the wrist flat, then rotate | Flat and still: az about ±1.0 g, ax and ay about 0, gyro about 0 (0 for the first 100 ms). Rotating moves gyro values in tenths of °/s. A frame about every 0.4 s (10 samples). | |
| D8 | Fast motion (MOTION2 bit 8, MOTION2_SET 0x24) | No | Low priority for field visits. Rate picker 25 to 416 Hz, and show `period_us` and sample_no jumps. | Start at 208 Hz with both sensors, with audio off, then with audio on | No Notice 3 at 208 Hz. `period_us` is measured, about 4800 µs ±3%. With audio on at 416 Hz both, expect Notice 3 and gaps in sample_no. Taps feel slightly different above 208 Hz. | |

### 2.4 LED, identify, storage

| # | Capability | Now | Next build | Physical action | Expected result | Result |
|---|---|---|---|---|---|---|
| L1 | IDENTIFY (0x04) | Yes: "Flash light" button (only while the mic is off), 5 s | Show the response status | Tap Flash light with the mic off, then again during the mic test (send it from diagnostics) | White blink 4 times a second for 5 s, then the previous LED returns. With the mic on: DENIED (status 6), and the LED stays solid blue. | |
| L2 | LED patterns (LED_SET 0x50, LED_GET 0x51) | No | "LED test" button that cycles solid green, blink red 500 ms, breathe blue 2 s, flash white 1 s and rainbow, 3 s each, then off. Show the LED_GET result. | Watch the band | Each pattern as named. Brightness capped at 64 if Notice 1 (low battery) is active. With the mic on, every LED_SET is DENIED. After a disconnect the LED goes off (settings reset when no transport is open). Use for field status, e.g. green breathe = "connected, not recording". | |
| L3 | Storage (STORE_INFO 0x70, PUT 0x71, GET 0x72, DEL 0x73) | No | "Storage test": STORE_INFO, then PUT key 900 = "glasscam-test", then GET, DEL and GET | Tap it | INFO: keys_max 1000, value_max 232, free_bytes 242,164 when empty. GET returns the same bytes. GET after DEL gives NOT_FOUND (7). More than 10 writes a second gives BUSY. **Anyone who connects can read the store: never store client data.** | |
| L4 | Stream intervals (STREAM_SET_INTERVAL 0x13) | No | Optional: BATTERY interval 60 s for a steady log. LINK 5 s to save air time. | Set BATTERY to 60000 | A battery frame every about 60 s even with no change | |
| L5 | Sleep / restart (0x06 / 0x05) | No | Don't expose in the field UI. SLEEP = "band off until double-tap", which could be useful at the end of a visit to save the battery. | (optional) SLEEP from diagnostics | The link closes about 400 ms after the response, with no 120 s reopen window. A double-tap is needed to find the band again. | |

### 2.5 Suggested order for one session (about 40 minutes)

1. D1 (info and caps), A3 (battery), D2 (clock): 3 minutes.
2. A1 and A2 (audio and range), A5 (double-tap): 10 minutes.
3. A6 (reconnect, including the 3-minute-away case): 6 minutes.
4. A8 (locked phone during a real visit to the dev server): 5 minutes.
5. A7 (steps), then E1 to E5 (events): 8 minutes. The current build can't run these.
6. D3 to D7, L1 to L3: 8 minutes. These are next build only.

---

## 3. Missing pieces for a robust field app

### 3.1 Background BLE while locked

What exists (`GlassCam/Info.plist`):

- `UIBackgroundModes` has `bluetooth-central`, `bluetooth-peripheral`, `external-accessory` and
  `processing`. These were added for the Meta glasses SDK.
- Both Bluetooth usage strings are there.
- No `BGTaskSchedulerPermittedIdentifiers` key, even though `processing` is declared. That
  harmless mismatch triggers an App Store validation warning, so add the key or drop the mode.

How it behaves:

- `bluetooth-central` is the mode that matters. While AUDIO streams, the band sends 50
  notifications a second. Each one wakes the app, so in practice it keeps running locked, and the
  URLSession WebSocket keeps working while the process runs.
- Risk: when nothing streams (connected but idle), the app is suspended between rare BATTERY
  frames. That is fine for BLE, but timers such as `scanTimeout` and the WebSocket keepalive
  don't fire while suspended.
- `isIdleTimerDisabled = true` (`BandVisitModel.swift:208`) only applies in the foreground.
- `beginBackgroundTask` is only used in `finish()`.

Still to do:

1. Run test A8 to prove the locked behaviour on device.
2. Optionally show a Live Activity or lock-screen "Recording" indicator, so the user knows
   recording continues.
3. Wrap `start()` in a background task too, so a lock during the `startVisit` HTTP call doesn't
   stall it.

### 3.2 State restoration (`CBCentralManagerOptionRestoreIdentifierKey`)

Not implemented. `VexoBand.swift:68` creates `CBCentralManager(delegate: self, queue: nil)` with no
options, and only lazily, inside `connect()`. If iOS kills the app in the background (memory
pressure during a long visit), the visit dies.

To add:

1. Create the central at launch (in the app's `init` or `didFinishLaunching`) with
   `[CBCentralManagerOptionRestoreIdentifierKey: "glasscam.band"]`. Restoration only works if the
   same ID is passed when the process is relaunched.
2. Implement `centralManager(_:willRestoreState:)`. Take
   `CBCentralManagerRestoredStatePeripheralsKey`, set `delegate`, keep `self.peripheral`, and
   re-discover services and characteristics once `.poweredOn` arrives. A restored peripheral has
   `services` cached but you still need `rx` and `tx`.
3. Persist what a relaunch needs in UserDefaults or Keychain: band number, the peripheral
   `identifier` (for `retrievePeripherals(withIdentifiers:)`), `wantAudio`, the active visit ID
   and stream link (the token is a secret, so use the Keychain) and `runStartMs`.
4. On a restore with a visit in progress: rebuild the `VisitStreamer`, re-run the handshake and
   `startStreams()` (new run, seq 0, a new `start` message with a new `audioStartMs`).
5. Limits: restoration doesn't happen after the user force-quits the app or after a reboot until
   first unlock. Say so in the field guide ("don't swipe the app away during a visit").

### 3.3 Reconnect

What exists: a rescan for 120 s while `wantAudio`. Missing pieces, all from section 1:

- Notify the visit (B3).
- Handle Bluetooth off (B4).
- Use a direct `connect(peripheral)` (B13).
- Keep one deadline (B8).
- Retry on `didFailToConnect`.

Also add:

- Reconnect when **not** recording. The band reopens its window for 120 s after any link close,
  so "Reconnect" works without a double-tap. Fix the footer text, and auto-reconnect quietly if
  the app had a band.
- **Silent-stream watchdog**: if `.streaming` and no AUDIO frame arrives for 2 s, send
  STREAM_GET. Active means another client took the stream (§2.3, for example the laptop
  dashboard over USB), so show "taken by another device". Not active means it was stopped, so
  restart it.
- A STREAM_STOP for everything (`0xFFFF`) as the first command after the handshake, so leftover
  state is known. Mainly relevant if a USB session is open too.

### 3.4 Audio buffering when the server is unreachable (B2)

Today `VisitStreamer.send` drops every packet unless the socket is `ready`. That happens at visit
start, during every reconnect, and during the whole time there is no signal (lifts, basements,
rural visits).

Design:

1. **Buffer.** A FIFO of entries `.start(audioStartMs)` or `.packet(Data)`. Run boundaries are
   needed because seq restarts at 0 after each band reconnect. Memory: about 62 B per packet
   × 50/s ≈ 3 KB/s ≈ 11 MB/hour. Keep about 5 minutes in RAM, and spill older entries to a file in
   `Application Support/visits/<id>/` (length-prefixed records, `NSFileProtectionComplete`), so a
   crash or a full hour offline loses nothing.
2. **Send.** On `ready`, replay from the oldest entry not yet acknowledged, in order. Pace it with
   the `send` completion handler, so only a few messages are in flight at a time, rather than
   firing thousands at once.
3. **Server ack (needs a server change).** The server has to accept a backlog faster than real
   time. It also needs acks (e.g. `stats.packets` per run, or an explicit `{type:"ack",run,seq}`),
   so the phone can drop what was delivered and resend after a reconnect without duplicates.
   Check that the Deepgram proxy can take bursts faster than real time; Deepgram's live endpoint
   generally can. Otherwise the server has to queue them.
4. **Fallback upload.** If the socket never reaches `ready` before Stop, keep the file and
   upload it with a plain HTTPS POST (e.g. `POST /api/visits/:id/audio`, Opus records plus run
   start times) when the network returns, using a background `URLSession` upload task. The server
   then transcribes it in batch. Until that exists, `finish()` should not report "sent" for a
   visit whose audio is still on the phone.
5. **UI.** Show "N s of audio waiting to send" next to the packets counter, and block Unpair or
   new visits while unsent audio exists.

### 3.5 Other gaps for field use

- **Command queue** (B5) and **length and `active` checks** (B6). These are prerequisites for
  diagnostics.
- **Critical and low battery** (B1, B9). Also check the battery before Start: refuse below about
  10% with a clear message.
- **Event timestamps**: keep `(unix_ms, t_ms)` from the TIME_SET response (B12) and convert EVENT
  and ACTIVITY `t_ms` with the §5.8 formula, so a double-tap or "motion stopped" can be placed on
  the visit timeline.
- **Double-tap debounce and confirmation**: ignore a second toggle within about 1.5 s. Give
  feedback that the tap registered. The LED is owned by the mic indicator while recording, so
  use a short phone haptic or sound instead.
- **Caps check** before offering features (B12): bit 4 mic, 2 events, 3 steps.
- **Another client holding the band**: if the scan finds nothing, the message already says "Close
  anything else connected to it". Add STREAM_GET take-over detection (3.3).
- **Privacy**: the band's key-value storage is readable by anyone, so never use it for client
  data. The relay token in the stream URL must stay out of logs (it already does: `VisitStreamer`
  never logs it).
