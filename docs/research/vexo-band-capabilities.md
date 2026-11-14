# Vexo Open band: capability catalog (firmware 1.1.0, contract v1.1)

Research note. What a client can get from, and do with, a Vexo Open band today, over
Bluetooth LE from a phone, with USB differences noted. Source: the Vexo Open kit (MIT),
cloned at `scratchpad/vexo-open-kit`. Contract revision 2026-11-12, `proto_major` 1,
`proto_minor` 1, firmware 1.1.0 (C§intro).

## How to read this

**Citation keys** (every fact carries one):

| Key | File |
|---|---|
| C§n | `contract/contract.md`, section n (the byte-level contract; authoritative) |
| BT:"heading" | `docs/bluetooth-contract.md`, that heading |
| API:"heading" | `docs/api.md`, that heading |
| SP | `docs/speech.md` |
| DG | `docs/deepgram.md` |
| AG:"heading" | `AGENTS.md`, that heading (rule n = numbered rule under "Rules that surprise people") |
| GS | `docs/getting-started.md` (troubleshooting table) |
| PRJ:name | `projects/<name>/README.md` |
| SIM | `python/vexo_open/transports/sim.py` (pretend band) |
| WB | `js/src/transports/web-bluetooth.js` |

**Fact status.** Plain table cells are verified: they are stated in the cited file.
Anything marked **[Inferred]** is my own calculation or reading-between-the-lines and is not
stated in the kit. "Needs 1.1" = not available on firmware 1.0 (no event band runs 1.0,
API:"Firmware 1.0 and 1.1"); the three 1.1 features are `fast-motion`, `intervals`,
`clock` (API:"Firmware 1.0 and 1.1").

**Byte rates** are whole frames including the 1-byte type (C§5.2 convention). Where the
contract gives no number, the derived figure is marked [Inferred].

---

## 1. Link facts that every item depends on

| Fact | Value | Source |
|---|---|---|
| Name / discovery | `Vexo-HACK-XX` (2 digits for 1..99, 3 for 100..999); service UUID `254f0001-df82-4a9c-a2b5-563a0f6b2021` in the advert; name only in scan response; manufacturer data `0xFFFF: 4F 01 lo hi` carries the band number. Scan at least 5 s | C§1 |
| Connect window | Idle band is not advertising. Double-tap opens 60 s window (blue blink 1 Hz); after power-on/restart 60 s; after link closes 120 s (not after SLEEP). Double-tap while a BLE client is connected does nothing. The window double-tap always uses 800 mg | C§1, C§5.2 |
| Connections | **One BLE connection at a time**; advertising stops while connected | C§1 |
| Security | **None**: no pairing, no bonding, no encryption; pairing request rejected | C§1 |
| GATT | RX `254f0002` (write / write-no-response, one frame per write), TX `254f0003` (notify, one frame per notification). Device Information `0x180A` (fw rev `open-1.1.0`, hw `vexo_open_xiao`). No other services | C§2.1 |
| Client rules | Subscribe to TX before first command (otherwise commands fail/drop). Write-with-response; one command at a time, 2 s timeout. At most 4 commands waiting (both transports together), else BUSY | C§2.1, C§3 |
| MTU / max_frame | Band asks for ATT MTU 247; `max_frame` = MTU - 3 (244 at 247), reported in `GET_INFO`. Frame = 1..244 bytes | C§1, C§2 |
| PHY / interval | Band chooses: 2M when allowed; 30-50 ms idle (requested 5 s after connect); 15 ms while AUDIO streams, or while MOTION2 over BLE exceeds 2000 B/s (208 Hz both sensors, 416 Hz+ one sensor). Central may refuse. Client cannot set these | C§1 |
| Send queue | 4096 bytes per transport, shared by all streams. Full queue drops new frames; a frame the link does not take within 100 ms is dropped. Both give Notice 3 (STREAM_DROPPED) | C§4 (AUDIO details) |
| Everything off at connect | All streams off after connect; when no transport is open every setting returns to default and LED turns off. Only band number, storage, and (while powered) the clock persist | C§2.3, C§4, C§6 |
| Phone platforms | Web Bluetooth: Chrome/Edge on laptops and **Android**; **no iPhone/iPad browser** (no Web Bluetooth on iOS), no Firefox/Safari. Native Android (`ScanFilter` + `connectGatt`) and iOS CoreBluetooth are described as possible, but the sample code "has been run against a pretend Bluetooth layer, not against a real band" | WB line 1; AG rule 9; BT:"Connecting with your own Bluetooth code" |
| Android permissions | "Nearby devices" permission; older Android needs Location permission and Location on | GS |

---

## 2. Streams (data the band sends)

Start with `STREAM_START` (`0x10`, `mask u16`), stop with `STREAM_STOP` (`0x11`), query with
`STREAM_GET` (`0x12`). Bit n arrives as frame type `0x10 + n` (C§3, C§4). Mask values: 1
MOTION, 2 EVENT, 4 ACTIVITY, 8 AUDIO, 16 BATTERY, 32 TEMP, 64 LINK, 128 MIC_LEVEL, 256 MOTION2
(BT:"Switching data on and off").

### 2.1 Summary table

| Stream | Bit / type | Measures (units) | Default rate | Allowed rates | Bytes/s over BLE | Needs 1.1 | Timestamp | Source |
|---|---|---|---|---|---|---|---|---|
| MOTION | 0 / `0x10` | accel `ax,ay,az` i16 milli-g; gyro `gx,gy,gz` i16 tenths of deg/s | 25 Hz | 10, 25, 50, 100 Hz (`IMU_SET`) | 320 @25 Hz, 1270 @100 Hz; [Inferred] 127 @10 Hz, 635 @50 Hz | No | `t_ms` of first sample; sample i at `t_ms + i*period_ms` | C§4, C§5.2 |
| MOTION2 (fast motion) | 8 / `0x18` | same units as MOTION; accel only, gyro only, or both | 25 Hz, both sensors | 10, 25, 50, 100, 208, 416, 833, 1666 Hz, limited per transport (table 2.3) | 210 to 5,330 over BLE (table 2.3) | **Yes** | `t_ms` of first sample + measured `period_us`; `sample_no` counter | C§4, C§5.2 |
| EVENT | 1 / `0x11` | gesture code + arg (2.4) | when it happens | on/off per kind (`EVENT_SET` mask) | < 50 | No | `t_ms` | C§4 |
| ACTIVITY | 2 / `0x12` | `steps_total` u32 (lifetime), `cadence_spm` u8, `state` (0 still, 1 walk, 2 run), `motion_mg` u16 | 1 frame/s | interval 100 ms..3,600 s | 13 @1 s; [Inferred] 130 @100 ms | Interval needs 1.1 | `t_ms` | C§4, C§5.7 |
| AUDIO | 3 / `0x13` | Opus packet (`seq u16, len u8, opus[len]`) | 50 frames/s | fixed: 50 frames/s | about 3,200 | No | **none**: use `seq` x 20 ms | C§4 |
| BATTERY | 4 / `0x14` | `percent` u8, `state` (0 battery, 1 charging, 2 charged), `millivolts` u16 | once at start, then on change (other %, other state, or >=20 mV), max 1/s | interval 0 (on change) or 1,000 ms..3,600 s | < 5 | Interval needs 1.1 | **none**: arrival time | C§4, C§5.7, C§5.8 |
| TEMP | 5 / `0x15` | `temp_mc` i32, thousandths of deg C, **chip** temperature | every 5 s | 100 ms..3,600 s (`STREAM_SET_INTERVAL`), or 1..255 s (`TEMP_SET_INTERVAL`, also on 1.0) | 2 @5 s; [Inferred] 90 @100 ms | sub-second needs 1.1 | `t_ms` | C§4, C§5.7, API:"How often: intervals" |
| LINK | 6 / `0x16` | `rssi_dbm` i8 (127 = no reading), `tx_dbm` i8, `phy` u8 (1 = 1M, 2 = 2M) | 1 frame/s | 100 ms..3,600 s | 8 @1 s; [Inferred] 80 @100 ms | Interval needs 1.1 | `t_ms` | C§4, C§5.7 |
| MIC_LEVEL | 7 / `0x17` | `peak_db`, `rms_db` u8, dB below full scale (0 loudest, 96 silence) over the last interval | 10 frames/s (100 ms) | 20..10,000 ms, multiple of 20 | 70 @100 ms; [Inferred] 350 @20 ms | Interval needs 1.1 | `t_ms` | C§4, C§5.7 |

USB: LINK is not available over USB (`STREAM_START` with bit 6 returns NOT_AVAILABLE)
(C§4). All other streams work on both transports.

### 2.2 MOTION (legacy motion stream)

| Item | Value | Source |
|---|---|---|
| Frame | `t_ms u32, period_ms u8, count u8`, then `count` x 12-byte samples; 10 samples per frame (fewer if `max_frame` < 127) | C§4 |
| Sampling | Sensor runs at 208 Hz; stream takes the latest sample every `period_ms` with **no filtering**, so movement faster than `rate_hz/2` aliases | C§4 Details |
| Gyro | Fields are 0 when gyro is off (`gyro_range_dps` 0) and for the first 100 ms after the gyro switches on (off between streams) | C§4 Details |
| Ranges | `accel_range_g` 2 (default), 4, 8, 16; `gyro_range_dps` 0 (off), 250, 500, 1000, 2000 (default). Units do not change with range. Ranges shared with MOTION2 | C§5.2 |
| Library note | On firmware 1.1 the library's `configure({motion})` uses MOTION2, not this stream; MOTION is still reachable as `mask: 1` | API:"Controls" (Any command) |
| Accuracy | **2 g default clips**: "a hard shake, a punch or a clap reads exactly 2.0 and its real peak is lost". Widen with `IMU_SET` / `setMotion({accelRange: 8})`. Resets to 2 g after every disconnect | API:"Controls" (Motion); BT:"Motion" |
| Measured at rest (one band on a desk) | 2.2-2.4 deg/s gyro, accel steps of at most 0.005 g | PRJ:gesture-trainer |

### 2.3 MOTION2 (fast motion), needs 1.1

| Item | Value | Source |
|---|---|---|
| Configure | `MOTION2_SET` (`0x24`): `rate_hz u16`, `sensors u8` (1 accel, 2 gyro, 3 both); response adds `max_accel_hz`, `max_gyro_hz`, `max_both_hz` for the asking transport. `MOTION2_GET` (`0x25`) | C§3 |
| Frame | `t_ms u32, sample_no u32, period_us u32, sensors u8, count u8`, then samples of 6 (one sensor) or 12 bytes (both). Holds up to 50 ms of samples; at most `(max_frame - 15)/6` (one sensor, cap 38) or `/12` (both, cap 19). `max_frame` must be >= 21 / 27 or every frame is dropped with Notice 3 | C§4 Details |
| Timing | Up to 100 Hz: latest sample on a ms grid, `period_us` exact. From 208 Hz: sensor runs at that rate on **its own clock (a few percent off, differs band to band)**; band **measures** `period_us` (nominal for up to ~1/3 s, then refined). Always place samples with `t_ms + i*period_us/1000`, never the nominal rate. Real example: "833" measured 865/s (about 4 % fast) | C§4 Details; API:"Fast motion" |
| Loss detection | `sample_no` restarts at 0 on `STREAM_START` and any changing `MOTION2_SET`; a jump = exact samples lost. A `t_ms` step without a `sample_no` jump = sampling pause (e.g. range change) | C§4 Details |
| Side effects at >= 208 Hz | MOTION, EVENT, ACTIVITY and the connect double-tap are fed from fast samples averaged to 208 Hz (taps slightly more/less sensitive); starting/stopping/changing leaves a ~30 ms gap in MOTION and EVENT. Above 2000 B/s over BLE the band requests a 15 ms interval | C§4 Details, C§1 |
| Power | Accel-only lets the gyro sleep (saves a little power); gyro-only saves bytes, not power (accel always runs for taps) | C§4 Details |
| 1666 Hz | Accel only, USB only; cannot coexist with the gyro (MOTION with gyro on, or `IMU_SET` gyro != 0, is DENIED while it runs, and vice versa) | C§5.2 |
| Over the limit | `STREAM_START` or `MOTION2_SET`-while-streaming faster than the transport allows: DENIED, nothing changes. Not streaming: any table value accepted; checked at start | C§5.2 |
| Stale stream | Notice 3 for MOTION2 at >= 208 Hz can also mean the sensor stopped delivering: if no frames follow, restart the stream or resend `MOTION2_SET` | C§3 (Notice 3) |

Rate table (bytes/s at `max_frame` 244) (C§5.2):

| rate_hz | Samples/frame 1 sensor / both | B/s 1 sensor | B/s both | Bluetooth | USB |
|---|---|---|---|---|---|
| 10 | 1 / 1 | 210 | 270 | yes | yes |
| 25 | 1 / 1 | 525 | 675 | yes | yes |
| 50 | 2 / 2 | 675 | 975 | yes | yes |
| 100 | 5 / 5 | 900 | 1,500 | yes | yes |
| 208 | 10 / 10 | 1,560 | 2,810 | yes | yes |
| 416 | 20 / 19 | 2,810 | 5,320 | yes | yes |
| 833 | 38 / 19 | 5,330 | 10,650 | one sensor only | yes |
| 1666 | 38 / n.a. | 10,650 | n.a. | no | accel only |

BLE maxima: 833 accel, 833 gyro, 416 both. USB maxima: 1666 accel, 833 gyro, 833 both
(C§3 MOTION2_GET; API:"Fast motion"). BLE cap rationale: keeps one band's air share about
one audio stream in a room full of bands (C§5.2).

### 2.4 EVENT (gestures)

`EVENT_SET` (`0x22`): `event_mask u8` (bit 0 tap, 1 double tap, 2 free-fall, 3 tilt,
4 orientation, 5 motion start/stop; default `0x3F` = all), `tap_threshold_mg u16`
200..8000, default 800. `EVENT_GET` (`0x23`). Frame: `t_ms u32, event u8, arg u8` (C§3,
C§4, C§5.2).

| Code | Event | Detection rule (fixed unless noted) | arg | Source |
|---|---|---|---|---|
| 1 | Single tap | tap threshold, **settable** 200..8000 mg (default 800) | 0 | C§4, C§5.2 |
| 2 | Double tap | same threshold | 0 | C§4, C§5.2 |
| 3 | Free-fall | total acceleration < 0.35 g for 100 ms | 0 | C§4 Details |
| 4 | Tilt | gravity direction moved > 35 deg and held 2 s | 0 | C§4 Details |
| 5 | Orientation changed | one axis > 0.8 g for 300 ms | face up: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z | C§4 Details |
| 6 | Motion started | movement > 0.1 g for 2 s | 0 | C§4 Details |
| 7 | Motion stopped | movement < 0.05 g for 2 s | 0 | C§4 Details |

Notes: only the tap threshold can be changed (C§4). It applies to EVENT frames only; the
connect-window double-tap always uses 800 mg (C§5.2). "Above the 2 g range taps behave a
little differently (less clipping)" (C§5.2). Library name for the threshold is in g
(`tapThreshold` 0.2..8) (API:"Controls"). Event tuning in the sample projects (fall alarm,
reaction game) is "guesses, not tried on a real band" (PRJ:fall-alarm, PRJ:reaction-game).

### 2.5 ACTIVITY (steps)

| Item | Value | Source |
|---|---|---|
| Fields | `steps_total` (lifetime count, survives restarts: subtract first value seen), `cadence_spm`, `state` 0 still / 1 walk / 2 run, `motion_mg` | C§4 |
| Interval | Frame interval settable 100 ms..1 h, but steps, cadence and state are still computed once a second; `motion_mg` is fresh every frame | C§5.7 |
| Counting while disconnected | The pretend band "counts steps by its own clock, also while nothing is connected, like a real one" | SIM `set_activity` docstring. **[Inferred]** the real band keeps counting with no client; the contract itself only says the total survives restarts |
| Accuracy | Not documented. Step diary project: "nothing here was tried on a real band" | PRJ:step-diary; accuracy: not found |

### 2.6 AUDIO (microphone sound)

| Item | Value | Source |
|---|---|---|
| Codec | Opus, 16 kHz, mono, 20 ms frames, about 24 kbit/s, **CELT mode**; one complete Opus packet per frame; settings fixed (`MIC_GET` reports gain, 16000, 20, 1, 24000) | C§3, C§4 |
| Frame | `seq u16, len u8, opus[len]`; `seq` starts at 0 on every start, wraps at 65535; gap = lost frames (use decoder PLC) | C§4 |
| Rate | 50 frames/s, about 3,200 B/s; not changeable | C§4, C§5.7 |
| Timing | No timestamp. Frame time = start + `seq` x 20 ms; sound of frame 0 begins about 140 ms after `STREAM_START` (about 40 ms if MIC_LEVEL already had the mic on) | C§4, C§5.8 |
| Gain | `MIC_SET_GAIN` (`0x30`) `gain_half_db` 0..80 (40 = 0 dB, 80 = +20 dB, default 80); applies within one frame | C§5.3 |
| Side effect | **Mic indicator: LED solid blue at full brightness**, lit before first frame; `LED_SET` and `IDENTIFY` return DENIED; stored LED setting returns when both mic streams stop. If the LED is broken the mic streams will not start (NOT_AVAILABLE) | C§5.1, C§6 |
| Drops | Slow link: frames queue (4096-byte shared queue); overflow or >100 ms untaken drops with Notice 3 and `seq` gap; stopping empties the queue | C§4 |
| Decoding | Kit decoders: `BandAudio` (browser WebCodecs, Chrome/Edge, page on localhost/https) and Python `PcmDecoder` (needs `av`); 320 samples per packet; fills up to 50 lost packets (1 s) | API:"Sound: from Opus packets to samples" |
| Speech-to-text | Off-band: Deepgram (online, team key) takes the Opus packets as they are; measured WER 5.6 % on natural-sounding synthetic voices, 27.8 % across all 8 passages; "no human voice through a band has been measured yet" | SP; DG:"What it is" |
| Privacy | Records everyone nearby; tell people; with Deepgram the sound leaves the computer | SP; DG |

### 2.7 MIC_LEVEL (loudness)

| Item | Value | Source |
|---|---|---|
| Fields | `peak_db`, `rms_db` (whole dB below full scale over the last interval) | C§4 |
| Interval | 20..10,000 ms in steps of 20 (default 100); interval is also the measurement window | C§5.7 |
| Measured before Opus, follows `MIC_SET_GAIN` | yes | C§4 Details |
| Side effect | Turns the mic on even with AUDIO off and lights the blue mic indicator (LED locked); no sound leaves the band | C§4 Details, C§6 |
| Accuracy / calibration | Algorithm (window, weighting) not specified: only rely on "peak at least as loud as rms". Real band at +20 dB gain: `rms_db` about 50 in a quiet room, 20-30 for speech near the band. Library `level = 1 - rms_db/96` | API:"Loudness: what a mic-level event measures" |
| Clap threshold | `RISE_DB` 20 "measured on one band on a desk" | PRJ:clap-lights |

### 2.8 BATTERY

| Item | Value | Source |
|---|---|---|
| Read once | `BATTERY_GET` (`0x61`) returns the same body without starting the stream | C§3 |
| Measurement | Battery measured about once a second; with an interval a frame goes out at the first measurement after the interval | C§5.7 |
| Accuracy | `percent` is an **estimate from cell voltage** and never jumps upward on battery | C§4 Details |
| Timestamp | None; use arrival time | C§5.8 |
| Critical battery | `STREAM_START` of BATTERY is DENIED while critical | C§3, C§6 |

### 2.9 TEMP

**Chip** temperature, 0.25 degree steps, "a few degrees accuracy"; reads above room
temperature because the chip warms itself; **not skin temperature** (C§4 Details). DENIED to
start while battery is critical (C§6).

### 2.10 LINK and radio

| Item | Value | Source |
|---|---|---|
| LINK stream | RSSI of the central as heard by the band (`rssi_dbm`, closer to 0 = stronger, **127 = no reading**), `tx_dbm`, `phy`. Library maps 127 to `null`/`None`; can happen over BLE too, check before arithmetic. BLE only | C§4; BT:"Link quality"; API:"Controls" (Radio) |
| `RADIO_GET` (`0x41`) | `tx_dbm i8, rssi_dbm i8, phy u8, interval u16 (1.25 ms units), mtu u16`. Over USB with no BLE link: rssi 127, phy 0, interval 0, mtu 0 | C§3 |
| `RADIO_SET_TX_POWER` (`0x40`) | -20, -16, -12, -8 (default), -4, 0, +4 dBm; capped at +4. Applies to the current connection; **returns to -8 on every BLE disconnect**; advertising always -8. Over USB with no link it stores the value for the next link | C§3, C§5.4, C§6 |
| Proximity use | Band-leash thresholds (-60 / -80 dBm) are "guesses: nobody has walked away with a real band yet"; -20 dBm meter top measured on a desk | PRJ:band-leash |

---

## 3. Commands and controls

| Control | Opcode(s) | Args / data | Limits and side effects | Needs 1.1 | Source |
|---|---|---|---|---|---|
| Device info | `GET_INFO` 0x01 | 16 bytes: proto 1.1, fw 1.1.0, hw 1 (XIAO nRF52840 Sense), `band_no`, `caps`, `max_frame`, `uptime_ms` | Ask first after connecting; decide features from `proto_minor`, not fw string | No | C§3; BT:"Band information" |
| Capability bits (`caps`) | in GET_INFO | 0 accel, 1 gyro, 2 motion events, 3 step counter, 4 mic, 5 RGB LED, 6 battery, 7 chip temp, 8 storage, 9 radio power control, 10 USB transport; set only if the part passed its start-up check | A failed part gives NOT_AVAILABLE | No | C§3 |
| Name | `GET_NAME` 0x02 | 12-13 ASCII bytes | No SET_NAME; name derives from band number | No | C§3 |
| Band number | `SET_BAND_NUMBER` 0x03 | `number u16` 1..999, magic `0x5856` | **USB only** (BLE: DENIED). Persists | No | C§3 |
| Identify | `IDENTIFY` 0x04 | `seconds u8` 1..30 | White blink 4x/s, then previous LED. DENIED while mic indicator lit or battery critical | No | C§3 |
| Restart | `RESTART` 0x05 | none | Restarts 200 ms after response; BLE link not closed first (client notices at ~4 s supervision timeout); 60 s window opens; **clock lost** | No | C§3 |
| Sleep | `SLEEP` 0x06 | none | 200 ms: all streams off (both transports), LED setting off; ~400 ms: BLE link closed, no reopen window; band findable only after double-tap. USB session stays open | No | C§3 |
| Set clock | `TIME_SET` 0x07 | `unix_ms u64` (2020-01-01 <= t < 2100-01-01) | Seconds value gives BAD_ARG. Returns `set, unix_ms, t_ms` (13 bytes) | **Yes** | C§3, C§5.8 |
| Read clock | `TIME_GET` 0x08 | none | `set u8, unix_ms u64, t_ms u32` | **Yes** | C§3 |
| Streams | `STREAM_START/STOP/GET` 0x10-0x12 | `mask u16` | Start from the other transport takes the stream over (even if the start then fails) | No (bit 8 needs 1.1) | C§3 |
| Intervals | `STREAM_SET_INTERVAL` 0x13, `STREAM_GET_INTERVAL` 0x14 | `stream u8, interval_ms u32`; response adds `min_ms`, `max_ms` | Streams 2, 4, 5, 6, 7 only (others BAD_ARG). Ranges in section 2.1. Reset to defaults when no transport open | **Yes** | C§3, C§5.7 |
| Motion sensor | `IMU_SET` 0x20 / `IMU_GET` 0x21 | `rate_hz u8, accel_range_g u8, gyro_range_dps u16` | Ranges also apply to MOTION2 | No | C§3, C§5.2 |
| Gestures | `EVENT_SET` 0x22 / `EVENT_GET` 0x23 | mask, tap threshold | Section 2.4 | No | C§3 |
| Fast motion | `MOTION2_SET` 0x24 / `MOTION2_GET` 0x25 | Section 2.3 | | **Yes** | C§3 |
| Mic gain | `MIC_SET_GAIN` 0x30 / `MIC_GET` 0x31 | gain 0..80 half-dB | Opus settings fixed | No | C§3, C§5.3 |
| Radio power | `RADIO_SET_TX_POWER` 0x40 / `RADIO_GET` 0x41 | Section 2.10 | | No | C§3 |
| LED | `LED_SET` 0x50 / `LED_GET` 0x51 | `r,g,b,brightness u8, pattern u8, period_ms u16` (7 bytes) | Section 3.1 | No | C§3, C§5.1 |
| Temp interval | `TEMP_SET_INTERVAL` 0x60 | `seconds u8` 1..255 | Same setting as stream 5 interval | No | C§3 |
| Battery once | `BATTERY_GET` 0x61 | BATTERY body | | No | C§3 |
| Storage | `STORE_INFO/PUT/GET/DEL/WIPE` 0x70-0x74 | Section 3.2 | | No | C§3, C§5.5 |

### 3.1 LED

| Field | Values | Default | Source |
|---|---|---|---|
| r, g, b | 0..255 | 0 | C§5.1 |
| brightness | 0..255 (scales all three); library uses 0..1 | 0 | C§5.1; API:"Controls" |
| pattern | 0 off, 1 solid, 2 blink (half on/off), 3 breathe, 4 flash (60 ms every period), 5 rainbow (ignores colour) | 0 | C§5.1 |
| period_ms | 100..10,000 (ignored for off/solid) | 1000 | C§5.1 |

Priority: mic indicator > critical battery (LED off) > IDENTIFY > connect-window blue
blink > your setting (C§5.1). One LED shared by both transports, last `LED_SET` wins; goes
off only when the last transport closes (C§2.3; API:"Two programs on one band"). Low battery
caps brightness at 64 (C§6). "A project cannot show loudness on the band's own LED" (AG rule 4).

### 3.2 Storage

| Item | Value | Source |
|---|---|---|
| Model | Key-value; key 0..999 (**1000 keys**), value 1..232 bytes and <= `max_frame` - 5; put replaces | C§5.5 |
| Capacity | 242,164 bytes free when empty; each key costs 8 bytes + value rounded up to 4; 1000 x 232-byte values fit (240,000 bytes) | C§5.5 |
| Rate limit | **10 writes (PUT/DEL) per second**; one more returns BUSY (library retries up to 3 s) | C§5.5; API:"Storage" |
| Startup | BUSY for a short time after boot | C§5.5 |
| Wipe | `STORE_WIPE` (magic `0x5856`) returns OK when erase starts; other storage commands BUSY until done; poll `STORE_INFO`. Library `wipe()` waits up to 30 s | C§5.5; API:"Storage" |
| Lifetime | Survives disconnect, restart, other users, until wipe | C§5.5 |
| **Security** | **Shared and insecure**: "Anything stored can be read, changed or wiped by the next person who connects: do not store anything private." No encryption on the link either | C§5.5, C§1 |
| USB caveat | Over USB a value can rarely arrive cut short and look complete; read twice if it must be right | API:"Storage" |

### 3.3 Clock and timestamps

| Item | Value | Source |
|---|---|---|
| Hardware | No battery-backed clock. `t_ms` = u32 ms since band start (wraps after 49.7 days); `GET_INFO.uptime_ms` is the same counter | C§5.8, C§intro |
| Lifetime | Kept across disconnects and both transports while powered; **lost on restart** (`RESTART`, reset button, watchdog) or empty battery: `TIME_GET` then returns `set` 0 | C§5.8 |
| Who sets | Anyone, anytime, last wins; unprotected | C§5.8 |
| Accuracy | Client clock at `TIME_SET` + transit (usually < 50 ms BLE, a few ms USB) + counter **drift about 2 s/day**. "Set it on every connect" | C§5.8 |
| Library | Sets the clock on every connect and auto-reconnect (opt out: `setClock: false`) and adds `time` to every event | API:"Time" |

**Converting `t_ms` to wall clock** (C§5.8): get one (`unix_ms`, `t_ms`) pair from `TIME_GET` or
the `TIME_SET` response, then for a frame stamped `T`:

    d = (T - t_ms) mod 2^32;  if d >= 2^31: d -= 2^32;  wall_ms = unix_ms + d

Valid up to 24 days either side and across the wrap; one `TIME_GET` per connection is enough.
Without a set clock, pair the client's own clock with `uptime_ms`/`t_ms` from a `GET_INFO` or
`TIME_GET` response (C§5.8).

| Stream | Timestamp | Wall-clock rule | Source |
|---|---|---|---|
| MOTION | `t_ms` + `i * period_ms` | formula above | C§4 |
| MOTION2 | `t_ms` + `i * period_us / 1000` (sub-ms) | formula above | C§5.8 |
| EVENT, ACTIVITY, TEMP, LINK, MIC_LEVEL | `t_ms` | formula above | C§4 |
| AUDIO | none | client time right after `STREAM_START` + ~140 ms + `seq` x 20 ms (library uses first-packet arrival + 20 ms per packet) | C§5.8; API:"Time" |
| BATTERY, notices | none | arrival time | C§5.8; API:"Time" |

---

## 4. Notices (unsolicited, frame type `0x03`, `[code][arg]`)

| Code | Name | Meaning | arg | Source |
|---|---|---|---|---|
| 1 | LOW_BATTERY | Below 3.5 V on battery: LED brightness capped at 64 (also IDENTIFY and window blink; not mic indicator). Ends at 3.6 V or on USB power | percent | C§3, C§6 |
| 2 | CRITICAL_BATTERY | Below 3.3 V: streams stop, LED off; `LED_SET`, `IDENTIFY`, `STREAM_START` of BATTERY/TEMP DENIED. Client stays connected; once it leaves the band does not advertise and ignores double-taps until on USB power. Library will not auto-reconnect after it | percent | C§3, C§6; AG rule 3 |
| 3 | STREAM_DROPPED | Frames lost (link too slow or frame > `max_frame`); max once a second per stream | stream bit 0..8 | C§3 |
| 4 | USB_POWER | Cable plugged / unplugged | 0 / 1 | C§3 |

---

## 5. Bluetooth vs USB

| Topic | Bluetooth | USB (CDC ACM serial, COBS + `0x00`) | Source |
|---|---|---|---|
| Availability | Only during connect window (double-tap) | Whenever plugged in, no double-tap | C§2.2 |
| LINK stream | yes | NOT_AVAILABLE | C§4 |
| `RADIO_GET` | real values | rssi 127, phy 0, interval 0, mtu 0 (no BLE link) | C§3 |
| `SET_BAND_NUMBER` | DENIED | allowed | C§3 |
| MOTION2 max | 833 accel / 833 gyro / 416 both | 1666 accel / 833 gyro / 833 both | C§3, C§5.2 |
| `SLEEP` | link closes, findable only after double-tap | session stays open and answers | C§3 |
| Session end | disconnect / unsubscribe | DTR low >= 100 ms or cable pulled; some OSes do not lower DTR, so streams (and the mic) can keep running into the next program | C§2.2 |
| Slow reader | queue + 100 ms rule | band waits at most 100 ms per frame; responses retried 4 times then lost | C§2.2 |
| Both at once | One BLE + one USB client may coexist: **shared** settings, LED, storage, clock. A stream goes to whichever transport last started it; the other gets no notice (frames just stop; `STREAM_GET` still says active). A BLE disconnect while USB stays open resets only radio power | | C§2.3; API:"Two programs on one band" |

---

## 6. What the band cannot do

| Capability | Status | Source / reasoning |
|---|---|---|
| Heart rate | **Not on the band** (verified) | C§7 ("Not on this band: heart rate, skin temperature, vibration, NFC, spare pins"); AG:"What the band can do" |
| Skin temperature | Not on the band; TEMP is chip temperature | C§7, C§4 |
| Vibration / haptics | Not on the band | C§7 |
| Screen, speaker | Not on the band | AG:"What the band can do" |
| NFC, spare pins | Not on the band | C§7 |
| GPS / location | **Not found** anywhere in the kit. The capability list (C§7) and `caps` bits (C§3) contain no location sensor. [Inferred] absent | C§3, C§7 |
| On-board transcription / speech recognition | **Not found / absent**: the band only sends Opus; text is produced off-band by Deepgram over the internet on the host | C§4, C§7; SP; DG |
| Raw PCM audio, other sample rates or bitrates | No: Opus settings fixed (16 kHz mono, 20 ms, 24 kbit/s) | C§3 (MIC_GET), C§5.3 |
| Pairing, bonding, encryption, auth | None; pairing rejected | C§1 |
| More than one BLE connection | No: one at a time, not discoverable while connected | C§1 |
| Offline recording / sensor log buffer | **Not found**. No command records or logs data on the band; streams stop when their transport closes, the audio queue empties on stop, settings reset when no transport is open. Only persistent items: 240 kB client-written KV store, lifetime step total, band number, clock (while powered). [Inferred] any offline log must be written by the client into STORE_* (as `step-diary` does from the laptop), max 10 writes/s | C§4, C§5.5, C§6; PRJ:step-diary |
| Real-time clock across power loss | No (no battery-backed RTC); time zone not stored | C§5.8 |
| Setting connection interval / PHY / MTU | No: chosen by the band | C§1 |
| Tuning event detectors other than tap | No (free-fall, tilt, orientation, motion thresholds are fixed) | C§4 |
| Anti-alias filtering on MOTION | No (latest sample, no filter) | C§4 |
| Showing anything on the LED while the mic is on | No (mic indicator owns it) | C§5.1, C§6 |
| Renaming the band | No SET_NAME | C§3 |
| Firmware update / bootloader via commands | No | C§6 |
| Battery / charging control, pins, registers, memory | No | C§6 |
| iPhone/iPad web apps | No Web Bluetooth on iOS; native CoreBluetooth described but untested against a real band | AG rule 9; BT:"Connecting with your own Bluetooth code" |

---

## 7. Combined BLE budget alongside AUDIO

### Verified facts

- AUDIO is about 3,200 B/s, always 50 frames/s (C§4).
- With AUDIO on, MOTION2 is *allowed* up to the BLE limits, but the contract advises staying
  at **208 Hz with both sensors or 416 Hz with one sensor** (each 2,810 B/s) unless you
  observe no Notice 3; audio and motion share one send queue and both lose frames if the
  phone's radio cannot keep up (C§5.2; API:"Fast motion" "With the microphone").
- BLE MOTION2 hard cap is about 5,400 B/s (416 both / 833 one), sized to roughly one audio
  stream's share of the air per band (C§5.2).
- The send queue is 4,096 bytes per transport, shared by all streams; full-queue frames and
  frames not taken within 100 ms are dropped with Notice 3 (C§4).
- While audio streams the band requests a 15 ms connection interval and 2M PHY; the phone may
  refuse, in which case the interval is the phone's choice (C§1).
- `max_frame` is 244 at MTU 247 (C§1); MOTION frames carry up to 10 samples and MOTION2 frames
  up to 50 ms of samples, so frame counts per second stay low (C§4).
- Over USB, a slow-reading host causes the same STREAM_DROPPED notices (C§2.2); web handlers
  that block the thread also cause drops (API:"Over the USB cable").

### Recommended "safe with audio" set (sums of verified per-stream figures)

| Stream | Setting | B/s |
|---|---|---|
| AUDIO | fixed | ~3,200 |
| MOTION2 | 208 Hz both sensors (or 416 Hz one sensor) | 2,810 |
| EVENT | all kinds | < 50 |
| ACTIVITY | 1 s | 13 |
| MIC_LEVEL | 100 ms | 70 |
| LINK | 1 s | 8 |
| TEMP | 5 s | 2 |
| BATTERY | on change | < 5 |
| **Total** | | **about 6,160** |

Note: MIC_LEVEL adds nothing to the mic side effect once AUDIO is on (both light the same
indicator) (C§6). Legacy MOTION at 100 Hz (1,270 B/s) is an alternative to MOTION2 at
100 Hz both (1,500 B/s) (C§5.2).

### Inference (not stated in the kit)

- [Inferred] Headroom: 4,096 bytes of queue at ~6.2 kB/s is about 0.66 s of buffering, but the
  100 ms take-or-drop rule is the tighter limit: if the phone stalls the link for more than
  ~100 ms (e.g. a missed or slow connection event, Wi-Fi coexistence on the phone), frames drop
  regardless of queue space.
- [Inferred] Raw air capacity is not the bottleneck: at a 15 ms interval even one 244-byte
  notification per connection event is ~16 kB/s. Phones often grant 30-50 ms or limit packets
  per event, which is why the contract's practical guidance (~6 kB/s total with audio) is
  conservative. Pushing MOTION2 to the BLE cap (416 both, 5,320 B/s) plus audio is ~8.5 kB/s;
  only do it after confirming no Notice 3 on the target phone.
- [Inferred] iOS often negotiates an ATT MTU of 185 (max_frame 182), not 247. Effects: MOTION2
  frames hold at most 27 one-sensor or 13 two-sensor samples (formula in C§4), so 416 Hz both
  sensors needs ~32 frames/s instead of ~22, adding header overhead; MOTION still fits 10 samples
  (127 bytes). The contract states MTU 247 is only *requested*, so always read `max_frame` from
  `GET_INFO` and `mtu` from `RADIO_GET`.
- [Inferred] An Opus 24 kbit/s 20 ms packet averages ~60 bytes (frame ~64 bytes), far below
  `max_frame`, so audio frames should never hit the "larger than max_frame" drop case.
