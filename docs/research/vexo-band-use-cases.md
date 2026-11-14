# Vexo band data beyond audio: what helps, what is risky, what is useless

Research for Vexo Field Assistant. Question: which band data other than audio could genuinely help a field visit (SDP 320/331/334/335 and the like), and which would be risky or useless?

- Researched: 2026-11-14. Analysis only; no code was changed.
- Band: Vexo Open, contract v1.1, firmware 1.1.0 (revision 2026-11-12).
- Labels: **[F]** = fact, with a source in brackets. **[P]** = my proposal or inference. **[L]** = a legal or regulatory point I did **not** verify against primary sources in this session. Get counsel to confirm it before relying on it.

Sources:

| Key | Document |
|---|---|
| C | Kit `contract/contract.md` (section numbers given as C§n) |
| A | Kit `docs/api.md` |
| K | Kit `projects/README.md` and `projects/<name>/README.md` (step-diary, fall-alarm, gesture-trainer, band-leash, clap-lights) |
| BB | `docs/band-bridge.md` |
| OBS | `docs/reports/band-pipeline-observation.md` |
| SDP | `docs/research/self-determination-codes.md` (its §1.6, §1.7 and §1.9) |
| SRC | `src/contracts/schemas.ts` (`EvidenceItem`), `src/contracts/band.ts` |

---

## 1. Ranked recommendations

Priority order: (a) how much it improves the record or invoice we already produce, (b) how little new privacy exposure it brings, (c) effort. Effort: S = days, M = 1–2 weeks, L = more, or needs new hardware or a new consent flow. **Wearer** says who the item assumes is wearing the band. Today that is the provider: the provider records the visit with the band and GlassCam (BB).

| # | Candidate | Concrete use in a field visit | Wearer | How it enters the pipeline [P] | What NOT to claim | Effort | Priority |
|---|---|---|---|---|---|---|---|
| 1 | **Battery + band notices** (BATTERY, `BATTERY_GET`, Notice 1 LOW, 2 CRITICAL, 4 USB_POWER) | Before the visit, GlassCam checks the battery and warns below a set level. During the visit, a critical battery stops every stream, so the recording ends early. That is then explained as the cause, not left as a silent gap | Either; device data only, no personal data | Pre-flight gate in GlassCam. Visit fields `batteryStartPct`, `batteryMinPct`, `criticalAt`. A nonblocking `BAND_BATTERY_ENDED_RECORDING` warning that makes completeness `partial` (closes part of OBS §2.3) | Nothing about the service. Battery life on audio is not documented in the kit: measure it before you print "X hours left" | S | **High** |
| 2 | **Recording-span timing** (AUDIO `seq` count, start/stop/reconnect times, STREAM_DROPPED; phone/server clock as the source of truth) | Support for the time spent and EVV element 6 (begin/end time): "audio recorded 10:02–11:31, 87 min of audio, 1 band reconnect". Flags a confirmed duration far longer than what was recorded | Provider | Visit metrics (`recordedAudioMs = packets × 20 ms`, first/last packet time, gaps). New rule `CONFIRMED_EXCEEDS_RECORDED` (nonblocking at first), as OBS §3 and §4.5 ask. Shown on the session note as "Recording details (band/phone-derived)" | The recording is not proof the service happened, or that it was in-person, or where. A recording span is **not** an EVV record. EVV still needs CalEVV or an alternate EVV system, and the location (element 4) cannot come from the band | S–M | **High** |
| 3 | **Tap bookmarks** (EVENT 2 double-tap; optionally 1 single tap) | The provider double-taps at a moment worth noting ("goal practised here", "participant chose X", "incident"). On Review, the transcript around each mark is highlighted, so the provider writes progress notes faster | Provider | New WS text message from GlassCam `{"type":"band_event","event":"double_tap","atMs":…}` (strict zod). Stored as `band_markers` and surfaced as `EvidenceItem`s of a new `kind: "marker"`, with an excerpt like "Provider bookmark (band double-tap)". Extraction may use a marker to **locate** transcript evidence, never as support for a claim | A tap means "the provider pressed here", not what happened there. Single taps give false positives (bumps, claps), so prefer double-tap. There is no haptic or LED feedback while recording (row 5), so confirm on the phone (sound or haptic) | M | **High** |
| 4 | **Privacy pause / consent indicator** (mic LED rule + a tap pattern to stop and resume AUDIO) | The participant asks to go off the record (bathroom, a private call, a medical topic). The provider pauses with a tap pattern, or on the phone, and the solid blue light goes **off**, visibly. The consent script can say "solid blue = the band is listening", and the firmware guarantees that | Provider band; the indicator is for the participant and bystanders | GlassCam sends `STREAM_STOP` AUDIO and WS `keepalive`, and records `pause`/`resume` markers. Pauses are listed in recording details and excluded from the recorded span (row 2), so a gap never reads as packet loss | The LED shows the mic is on. It is not consent. Consent stays the explicit checkbox/attestation (`RecordVisit.tsx`), plus the participant's own agreement | M | **High** |
| 5 | **LED / IDENTIFY before the visit** | In an office with many bands, IDENTIFY flashes white on the band GlassCam is connected to, so the provider knows they have their own. Status colours before recording (green = ready, amber = low battery) | Provider | GlassCam UI only; nothing goes to the server | — | S | Medium |
| 6 | **MIC_LEVEL loudness** | Recording-quality hints: the mic is covered or muffled (a long flat, quiet stretch while the transcript is empty), or the room is too loud for speech recognition. Also a pre-visit "mic works" check | Provider | GlassCam computes aggregates only (minutes of near-silence, minutes of loud audio). Shown as a nonblocking quality warning. It runs beside AUDIO at about 70 B/s | Loudness is not evidence of service or speech. The kit says rms/peak are not specified beyond "peak ≥ rms" and depend on gain and distance | S–M | Medium-low |
| 7 | **Activity: steps, cadence, still/walk/run** (ACTIVITY) | For 331 community integration and 335 job coaching, context such as "the band recorded about 1,400 steps; walking about 22 of 75 min" can back a narrative of a community outing or a worksite walk-through | **Provider by default**, so the numbers describe the provider. Participant-worn only with explicit, documented opt-in (§3) | Opt-in per client. A per-visit `sensor_summary` (totals and minutes per state, no time series) shown in a labelled "Sensor summary (band-derived, unverified)" block. **Never sent to AI extraction as a fact. Never feeds billing, units or rules that unblock approval** | Steps are not proof of service, not the participant's activity (on a provider band), and not a measure of skill progress. Wrist step counting has no accuracy spec in the kit. `steps_total` is a lifetime count, so subtract the first value. Steps taken while the link is down are counted, but their seconds are not | M (L for participant-worn) | Low-medium |
| 8 | **Motion start/stop, orientation** (EVENT 5/6/7) | A "worn vs set down" hint: no motion for a long stretch plus a fixed orientation suggests the band was put on a table. That is fine for audio, but it explains muffled audio | Provider | Folded into the quality warnings (row 6); count only | Not evidence of what anyone did | M | Low |
| 9 | **Band clock / `t_ms` timestamps** | Lines up taps, pauses and battery events with the audio timeline | — | Convert with the C§5.8 formula, but anchor every EVV and document time to the **phone/server clock** (`audioStartMs`, stop time), as today | The band clock is not a trusted time source (§4) | S (the kit does it) | Supporting only |
| 10 | **LINK RSSI** | Diagnostics only: a weak or lost link explains packet loss ("phone left in the car") | Provider | Aggregate `linkLostSeconds` and a minimum RSSI, beside `lostPackets` | **Not** "the provider walked away from the participant". RSSI measures band to phone, not provider to participant, and both usually belong to the provider. The kit calls it "a rough hint, not a ruler" | S | Low |
| 11 | **On-band storage** | At most a non-personal asset label or a config version | — | None | Never store a client ref, visit id or anything personal: storage is readable and wipeable by anyone who connects | S | **Don't** (beyond an asset tag) |
| 12 | **Free-fall / fall alert** | Tempting as a "safety alert" | Participant-worn to mean anything | — | It would look like PERS (SDP 358, its own service code) or a safety device. The kit's fall-alarm is "not a medical device… Do not rely on it for anyone's safety". Free-fall = below 0.35 g for 100 ms, so a dropped band triggers it and a real wrist fall may not | M | **Risky: don't build** |
| 13 | **Raw MOTION / MOTION2** | Gesture commands, activity recognition | Either | — | Gait and motion patterns are biometric-like data (§3). At high rates it competes with audio for the shared 4096-byte send queue, so audio drops frames. The gesture trainer's thresholds are guesses, not tested on a wrist | L | **Risky / not worth it** |
| 14 | **Chip temperature** | None | — | — | It is the chip's own temperature, a few degrees off, warmed by the chip itself. "It is not skin temperature" | — | **Useless** |

---

## 2. Facts that drive the ranking (cited)

**Capabilities and limits**
- **No location sensor.** The band has accelerometer, gyroscope, taps and motion events, steps, mic, RGB LED, battery, chip temperature, storage, radio power and USB. It has no heart rate, skin temperature or vibration [F C§7]. So EVV element 4 (location) needs the phone or a manual address, never the band [F SDP §1.9; P].
- **Cheap side streams.** EVENT is under 50 B/s, ACTIVITY 13 B/s, BATTERY under 5 B/s, LINK 8 B/s and MIC_LEVEL 70 B/s, against AUDIO's ~3,200 B/s [F C§4]. All of rows 1–10 fit beside audio.
- **MOTION2 competes with audio.** All streams share one 4,096-byte send queue per transport. Full-queue frames are dropped, with Notice 3 and gaps in `seq` [F C§4 AUDIO]. Fast MOTION2 together with AUDIO should stay at 208 Hz with both sensors or 416 Hz with one, unless you see no Notice 3 [F C§5.2].
- **Tap behaviour.** Event codes: 1 tap, 2 double-tap, 3 free-fall, 4 tilt, 5 orientation, 6/7 motion start/stop. Only the tap threshold can be tuned (200–8,000 mg, default 800) [F C§4, C§5.2]. A double-tap while connected does not reopen advertising [F C§1], so the EVENT stream is free to use it during a visit.

**Mic light and LED**
- **The mic light is enforced by firmware.** Whenever AUDIO or MIC_LEVEL runs, the LED is solid blue at full brightness, lit before the first frame and off only after the mic is off. `LED_SET` and `IDENTIFY` return DENIED meanwhile, and if the LED is broken the mic streams will not start [F C§6].
  - That makes it a reliable "recording" indicator for consent [P].
  - It also means **no LED feedback is possible during a recording** [F].

**Battery**
- Below 3.5 V: Notice 1 and LED brightness capped [F C§6].
- Below 3.3 V: all streams stop and Notice 2 [F C§6].
- The percent figure is a voltage estimate [F C§4].
- No runtime figure was found in the kit [F, not found].

**Clock and timestamps**
- The band has no battery-backed clock. Any client can set it, "nothing protects it", and it drifts about 2 s a day [F C§5.8].
- The clock is lost on restart [F C§5.8].
- AUDIO frames carry no timestamp: frame time = start + ~140 ms + `seq` × 20 ms [F C§4, C§5.8].

**Steps**
- `steps_total` is a lifetime count that survives restarts [F C§4].
- Steps are counted by the band while the link is down, but those seconds are "in no column" [F K step-diary].
- No accuracy figure is given for steps [F, not found in C or A].

**Signal strength**
- RSSI is "a rough hint, not a ruler. A body, a wall or a bag … changes it a lot" [F K band-leash].
- The near and far thresholds are untested guesses [F K band-leash].

**Loudness**
- How peak and rms are computed is not specified, they follow the mic gain, and a quiet room reads rmsDb ≈ 50 [F A "Loudness"].

**Fall detection**
- Free-fall = total acceleration below 0.35 g for 100 ms [F C§4].
- The fall-alarm project is "not a medical device… Do not rely on it for anyone's safety" [F K fall-alarm].
- None of the six example projects has been tested as a whole on a real band, and most of their thresholds are guesses [F K README].

**Security and storage**
- No pairing, bonding or encryption [F C§1].
- One connection at a time, and advertising stops while connected [F C§1].
- Storage holds 1,000 keys of up to 232 bytes. "Anything stored can be read, changed or wiped by the next person who connects: do not store anything private" [F C§5.5].

**Pipeline today**
- An `EvidenceItem` is a text excerpt with an optional speaker and times. It has no `kind` field [F SRC].
- Visit metrics are `packets`, `lostPackets` and `segmentCount` [F BB].
- No rule compares confirmed minutes with the recorded span, and no EVV element is captured [F OBS §3].

**Regulation (from the project's research)**
- EVV's six elements: service type, individual, date, location, provider, begin/end time. Web timesheets alone do not satisfy EVV [F SDP §1.9].
- SDP 320 is EVV-covered (PCS). 331, 334 and 335 are not on DDS's list [F SDP §1.9].
- 17 CCR § 50604(d) requires date, start/end times and the street address (or city/county for natural environments) [F SDP §1.7].

---

## 3. Who wears the band: value, privacy and consent

| | Provider wears it (today) | Participant wears it |
|---|---|---|
| Audio | Already the design. Consent is captured in `RecordVisit` [F BB, SRC] | Same audio, but the mic is on the participant's body. Higher intrusion [P] |
| Taps, pause, battery, link, timing | High value, low intrusion. It is the provider's own tool | Low value: the participant would have to tap for the provider |
| Steps / activity | Describes the **provider** (an employee or contractor). That raises workplace-monitoring concerns [L] and gives only weak support for the service | Describes the participant. More relevant to 331/335 goals, but it is health/biometric-like data about a person with a developmental disability (below). It needs a second band or a hand-over, and one BLE connection per band [F C§1] |

Proposed rules [P]:
1. **Default: provider-worn, with activity streams off.** Turn on rows 1–6 and 9–10 only. They are device and recording-quality data.
2. **Activity summaries are per-client opt-in** and must be recorded in the person-centred plan or the service agreement before they are switched on. The participant (or authorised representative) can switch them off at any time.
3. **Minimise.** Keep per-visit totals only: steps, minutes per state, counts. Raw samples, time series and raw motion never leave the phone. Run events carry counts and codes only, as the existing privacy invariant requires (CLAUDE.md).
4. **Label every sensor-derived item** "band-derived, unverified", with `sourceMode` kept honest (`fixture` for the pretend band). Sensor items go in their own document section, never mixed into transcript evidence.
5. **Never invent claims.** The AI extractor gets no sensor numbers as facts. A claim whose only support is a marker or sensor item fails `UNSUPPORTED_CLAIM`. No sensor value changes billing, units or blockers. At most it raises a nonblocking warning.

Regulatory and privacy concerns [L unless marked]:
- **HCBS Settings Rule (42 CFR 441.301(c)(4)).** It protects privacy, dignity and freedom from coercion and restraint. Any modification (monitoring a participant's movement) must be justified and documented in the person-centred plan. Continuous participant tracking risks reading as a restrictive practice.
- **California law.**
  - W&I Code § 4502 rights of people with developmental disabilities, including privacy.
  - CCPA/CPRA treats biometric information (which by definition includes gait and exercise data that identify a person) and health data as sensitive personal information. Since 2023 it also covers employee data, which matters for provider-worn activity data.
  - CMIA (Civil Code § 56) may apply where the provider or FMS handles medical information.
  - HIPAA applies only if the provider is a covered entity.
  - Penal Code § 632 (all-party consent to record confidential conversations) already shapes the audio consent. MIC_LEVEL turns the mic on too, even though it sends no sound [F C§4].
- **EVV.** Band data is not an EVV system and must not be presented as one. CalEVV or an approved alternate EVV system is the record [F SDP §1.9]. Our recording span is supporting documentation only [P]. Location must come from the phone (with its own consent prompt) or a manual address.
- **Safety claims.** A fall alert would invite reliance and liability, and would overlap SDP 358 PERS [F SDP §1.2]. Don't build one.
- **Wireless exposure.** The BLE link is unencrypted [F C§1]. Audio already crosses it. Adding participant activity data adds little extra risk, but it is one more reason not to stream participant biometrics [P].

---

## 4. Accuracy caveats to carry into the UI and documents

- **Steps / state.** These come from a wrist accelerometer, with no published accuracy [F, not found]. Arm movement (cooking, cleaning, ILS tasks) can count as steps, and pushing a cart or wheelchair may not [P]. Show values as approximate ("about 1,400").
- **Clock.**
  - Drift is about 2 s a day [F C§5.8].
  - The clock is lost on restart [F C§5.8].
  - Any client can overwrite it [F C§5.8].
  - So the phone or server time is authoritative for every document and EVV time [P]. The kit sets the band clock from the computer on every connect [F A "Time"].
- **Recorded span.** It is accurate to the packet: lost frames show as `seq` gaps [F C§4]. But a socket that closes without `stop` currently reads as complete [F OBS §2.3]. Fix that before building row 2's rule on it.
- **RSSI and loudness.** Both depend on the room, the body, the gain and the distance. The kit's thresholds are mostly guesses or were measured on one band on a desk [F K]. Calibrate in the field before showing any zone or level.
- **Free-fall.** It fires on a dropped band and may miss a real fall [F C§4 definition; P].
- **Taps.** The 800 mg default catches bumps, so prefer double-tap and measure the false-positive rate in a real visit [P].

---

## 5. Recommended next 3 builds

1. **Band health and recording span (rows 1, 2, 10). Effort S–M.**
   - GlassCam subscribes to BATTERY, EVENT and LINK beside AUDIO, with a pre-flight battery check.
   - New strict WS message `band_status` (battery %, charging, notice codes, link-lost seconds).
   - The Worker stores the visit metrics `recordedAudioMs`, `batteryMinPct`, `linkLostSeconds`, `endedBy` (stop / socket close / critical battery).
   - Nonblocking rules: `CONFIRMED_EXCEEDS_RECORDED`, plus `RECORDING_ENDED_ABNORMALLY` (fixes OBS §2.3).
   - A "Recording details (band/phone-derived)" block on the session note.
   - No personal data; it fits the existing invariants.
2. **Double-tap bookmarks (row 3). Effort M.**
   - GlassCam forwards EVENT 2 as a `band_event` with the phone-clock time and gives haptic confirmation.
   - Add `kind: "transcript" | "marker"` to `EvidenceItem`, defaulting to transcript so existing data stays valid.
   - Review highlights transcript segments within about 30 s of each marker.
   - Extraction may not cite a marker alone (`UNSUPPORTED_CLAIM`).
   - Add a synthetic scenario with markers to `fixtures/band/scenarios.ts`.
3. **Privacy pause (row 4). Effort M.**
   - A triple double-tap pattern (or a phone button) stops AUDIO, and the blue light goes off visibly. The same action resumes.
   - Pause/resume are stored as markers, excluded from the recorded span, and never counted as packet loss.
   - Update the consent copy: "solid blue = listening".
   - This turns the firmware's mic-indicator rule into a participant-facing privacy feature at low risk.

**Deferred:** activity summaries (row 7). Build them only after a consent and person-centred-plan flow exists, and only as labelled, opt-in, nonbilling context.

**Do not build:** fall alerts, raw motion capture, temperature, and personal data in band storage.
