# SessionProof strategy vs the Vexo Field Assistant build

Compares the teammate's strategy PDF *SessionProof: VexoHacks finals playbook* (17 pages, dated 2026-11-14; file `14nov Updated v2 SessionProof_Strategy_for_Prakash.pdf`) with what is built in this repo and in GlassCam.

- Written 2026-11-14. Analysis only; no code was changed.
- Labels: **[F]** = fact, cited as `PDF p.N` or a repo path or commit. **[J]** = my judgement or inference.
- Work in progress, **not counted as built**: hands-free double-tap recording and a remembered band in GlassCam (`GlassCam/Band/HANDSFREE-INTERFACE.md`, marked frozen interface, build ongoing), review links and notifications, and the Cloudflare deploy with Access JWT verification (`docs/deploy.md` §5.4 is a spec; `docs/deploy.md` and `scripts/platform/preflight.mjs` are uncommitted).

---

## 1. The strategy in five lines

1. **Product and promise:** *SessionProof*, a consent-first, camera-free wearable voice agent. It turns support sessions into source-linked draft documentation, asks one missing question live, and refuses unsupported outcomes. Tagline: "the bracelet that refuses unsupported paperwork" [F PDF p.1–2].
2. **Customer:** users are field support, transition and life-skills staff who cannot hold a phone mid-session. Buyers are provider schools or agencies, program directors and compliance leads. The story is a coach (Maria) supporting a 19-year-old in a self-directed services program (Daniel) [F PDF p.7, p.12].
3. **Business model:** a paid pilot now, then a subscription priced per active staff member, then later FMS, SETWorks and Therap integrations. SessionProof is the "evidence step before" the system of record. It does not decide eligibility, payment or submission [F PDF p.4, p.12–13].
4. **Go-to-market:** win the hackathon finals with a 30-second kinetic demo ending in a red refusal, earn a YC interview, then get written employer IP clearance and one authorized paid pilot [F PDF p.2, p.8, p.17].
5. **MVP scope and timeline:** the band connects over **direct laptop BLE**. Vexo raw Opus goes to Deepgram (Flux, with a Nova-3 fallback), then to Pipecat, then to deterministic rules, then to human review. Phone-in-pocket is a later hypothesis. Build order: band 20 min, evidence UI 45 min, rules 75 min, voice 120 min, then rehearsals in the final hour [F PDF p.6, p.16].

---

## 2. Aligned

| Strategy point | What we built | Evidence |
|---|---|---|
| Human review is non-negotiable; nothing auto-submits [F PDF p.9, p.14] | Approval is required and durable; approved = locked; changes go through Amend; email is draft-only and the user presses Send | `CLAUDE.md` (core line, invariants); `src/services/approval/`; commits `3a5d986`, `d31db70` |
| Every field linked to source evidence; deterministic checks, not model opinion [F PDF p.2, p.6, p.9] | Claims carry `evidenceIds`. Rules are pure code: a supported claim citing evidence outside the session is blocking `UNSUPPORTED_CLAIM`; missing duration or progress blocks approval | `src/contracts/schemas.ts:139-145` (`FactClaim`); `src/domain/rules/index.ts:60-95`; core principle in `astro_handoff.md` l.27 |
| "Missing" state shown legibly [F PDF p.2] | Review rail `ApprovalChecklist`: blockers → Fix → Save → Approve (after the session, not live) | `docs/architecture.md` (UI section); commit `d31db70` |
| Vexo band as capture device; 16 kHz Opus, 20 ms packets [F PDF p.5] | Band → bridge → Worker `CaptureSession` → Deepgram; Opus forwarded byte-for-byte | `docs/band-bridge.md` §Flow, §2; commit `52791a2` |
| Exact assigned band; never list all bands [F PDF p.5, p.16] | Scan by exact name `Vexo-HACK-NN`, check `band_no` with GET_INFO | `docs/band-bridge.md` §GlassCam bridge; GlassCam `Band/VexoBand.swift` |
| Laptop/browser BLE path [F PDF p.6] | Web Bluetooth transport in the web app (BandPanel), as well as the phone path | `src/ui/vendor/vexo-open/transports/web-bluetooth.js`; `src/ui/components/visit/BandPanel.tsx` |
| Consent before mic [F PDF p.5, p.8] | Record visit needs a consent checkbox ("Everyone present knows…"), and says audio goes to Deepgram | `src/ui/pages/RecordVisit.tsx:207-216` |
| Data path truth: raw audio leaves via BLE to Deepgram; host redacts before the LLM [F PDF p.5, p.15] | Audio reaches Deepgram before the scrubber; every live inference goes tokenize → infer → restore; logs carry ids and counts only | `docs/band-bridge.md` §Transcribers; `src/privacy/`; `CLAUDE.md` invariants |
| No raw audio retention; `mip_opt_out=true` [F PDF p.5, p.14] | Audio is never stored (segments hold text and times only); Deepgram called with `mip_opt_out=true` | `docs/band-bridge.md` §Flow, §Transcribers; migration `0006_band_visits` |
| Packet loss is visible, never silently filled [F PDF p.5, p.16] | Lost packets counted from `seq` gaps → `partial` completeness and a `PARTIAL_EVIDENCE` warning (3.8% loss in the lossy scenario) | `docs/reports/band-pipeline-observation.md` §1 |
| Wait for final words before the gate [F PDF p.16] | Socket `stop` flushes the transcriber and waits for `done` before the HTTP stop | `docs/band-bridge.md` §2–3 |
| Internet unstable → clearly labelled simulator [F PDF p.16] | `simulated` transcriber labels evidence `fixture` with a "Simulated transcript" warning | `docs/band-bridge.md` §Transcribers |
| Synthetic data only [F PDF p.14, p.17] | Demo client `C-104`; 8 synthetic band scenarios; deploy guide is "synthetic-data demo" | `CLAUDE.md`; commit `930f9ac`; `docs/deploy.md` l.3 |
| Wearer is the coach/staff member, not the participant [F PDF p.7] | Provider-worn by design; participant-worn only with documented opt-in | `docs/research/vexo-band-use-cases.md` §3 |
| Mic light truth; LED denied while mic on; one BLE owner; no BLE encryption claim [F PDF p.5, p.14] | Same facts recorded from the kit contract and carried into product rules | `docs/research/vexo-band-capabilities.md` §1, §3.1, §6; `vexo-band-use-cases.md` §2 |
| No claims of legal proof, diagnosis, eligibility or certification [F PDF p.14, p.17] | Original spec forbids claiming "legal, clinical, payer, or HIPAA certification" and asking an LLM to declare compliance | `astro_handoff.md` l.3400-3401 |
| Optional Gemini only if grounded [F PDF p.6, p.9] | Gemini is one of four inference adapters; extraction output must cite evidence ids | `src/ai/providers/gemini.ts`; `src/ai/index.ts` (`validateExtraction`) |
| Self-directed services program (Daniel) [F PDF p.7] | Self-determination fields (funding source, authorization number, fiscal intermediary, authorized hours); `participantDirected`; CA SDP code research | `src/contracts/v3.ts:29-34`; `src/contracts/schemas.ts:325-326`; `docs/research/self-determination-codes.md`; commits `6c59708`, `4832618` |
| Tap = evidence marker [F PDF p.8] | **Not yet**: proposed as double-tap bookmarks (research), and double-tap events are in the WIP GlassCam interface | `vexo-band-use-cases.md` row 3; `HANDSFREE-INTERFACE.md` (`onTap`) |

---

## 3. Not aligned / gaps

### 3a. In the strategy, not built

| Item | Strategy ref | State in repo | Effort | Owner area |
|---|---|---|---|---|
| **Live clarifying question during the session** (agent asks one missing fact and the answer turns gold to green) | PDF p.2, p.8 | Not built. The pipeline runs **after stop**: stop → queue → workflow → draft (`docs/architecture.md` §Flow). No streaming extraction, no TTS, no Pipecat (grep finds none in `src/`) | **L** | `src/band/` streaming + new voice service; UI live view |
| **Live supported / missing / blocked field board** (3 green, 1 gold) during capture | PDF p.2, p.8 | Review page shows a checklist after processing only | M | `src/ui/pages/RecordVisit.tsx`, `src/domain/rules` run on interim segments |
| **Semantic refusal of a claim that exceeds the session** ("Daniel can now shop alone every week") | PDF p.8, p.15 | `UNSUPPORTED_CLAIM` only catches citations to evidence ids **outside** the session (`src/domain/rules/index.ts:82-95`). A claim with valid but non-supporting citations is not refused; extraction can mark it `uncertain` | M | `src/domain/rules`, `src/ai` extraction prompt + validator |
| **Tap marker → instant screen marker → evidence** | PDF p.5, p.8 | No server-side `band_event`/marker; `EvidenceItem` has no `kind` | M (GlassCam part is WIP) | `src/contracts/band.ts`, `src/band/`, GlassCam |
| **Double-tap stops; green flash after audio stops** | PDF p.5, p.8 | GlassCam WIP uses double-tap to start **and** stop; LED acknowledge is a white blink before the mic starts | S | GlassCam (WIP) |
| **Consent recorded** as a record | PDF p.7 | Consent is a client-side checkbox only; no consent field found in `src/contracts/band.ts`, `src/api/visits.ts` or migrations | S | `src/contracts/band.ts`, migration, session note |
| **Retention and deletion controls** ("consent and retention infrastructure") | PDF p.13 | No DELETE route for visits, segments or sessions (`docs/architecture.md` §Routes); transcripts persist in D1 | M | `src/api/`, `src/db/` |
| **Deepgram Flux STT** (Nova-3 as fallback) | PDF p.6, p.16 | Nova-3 only (`src/band/transcriber.ts:44`) | S | `src/band/transcriber.ts` |
| **TTS gating** (stop Vexo audio during laptop playback) | PDF p.16 | N/A, no TTS | S once voice exists | voice service |
| **Integrations into FMS, SETWorks, Therap** | PDF p.12–13 ("later") | None; we export JSON/HTML/PDF and deliver to Drive/OneDrive/Gmail/Outlook drafts | L | `src/export/`, new adapters |
| **Our own pricing (per active staff) and a pilot scorecard** (minutes/session, missing fields, source accuracy, opt-out) | PDF p.12 | No product billing; run history has per-stage timings, but no pilot metrics view | M | `src/history/`, new metrics page |
| **Goal-evidence graph / structured corrections as learning data** | PDF p.13 | Partly: plan goals ↔ claims ↔ evidence ids exist; corrections create bundle revisions, but are not mined | M–L | `src/domain`, `src/services/approval` |

### 3b. Built, not in the strategy

| Built | Evidence | Suggestion [J] |
|---|---|---|
| **Draft invoice, per-client hourly rate, rate freeze, SDP receipt items** | `src/contracts/v3.ts`; commit `6c59708` | **Conflict of emphasis (see 3c).** Keep it, but frame it as a "draft service record with time summary", not billing, in the pitch. Add it to the strategy as the paid-pilot hook only after the provider side confirms they want it |
| **Calendar discovery cron + queue + Workflow** | `docs/architecture.md` §Flow | Keep (it is the reliability backbone); not pitch-relevant |
| **Drive/OneDrive upload, Gmail/Outlook drafts, OAuth connections** | commit `aa3bdce`; `src/connections/` | Cut from the demo; mention as "export into existing tools". It widens the data-handling surface |
| **Template designer, one DocModel → HTML + PDF** | commit `6c59708`; `src/documents/` | Add to the strategy as "human-reviewed export" (PDF p.13 already wants export) |
| **Amend with superseded finals, revisions, run history** | commits `3a5d986`, `6c59708` | **Add to the strategy**: it is a concrete audit-trail story that backs "field provenance" |
| **Multi-provider AI (Anthropic, OpenAI, Gemini, Mistral) + PII tokenizer** | `src/ai/providers/`, `src/privacy/` | Add the tokenizer to the trust slide; the provider list is not pitch material |
| **iPhone bridge (GlassCam), paired devices, USB bridge** | commits `1c36cc1`, `995d24a`; `docs/usb-bridge.md` | The strategy calls phone-in-pocket a later hypothesis (PDF p.6, p.16). Decide explicitly; see 3c |
| **CA SDP code, unit and EVV research; 8 SDP-coded band scenarios** | `docs/research/self-determination-codes.md`; commit `930f9ac` | Add a slimmed version to the strategy: it is the concrete "program pack" the moat slide (PDF p.13) talks about |
| **Band data research** (battery, recording span, taps, privacy pause) | `docs/research/vexo-band-use-cases.md` | Privacy pause and recording span strengthen the strategy's consent story; add them |

### 3c. Conflicts

| Topic | Strategy assumes | Build / research shows | Note |
|---|---|---|---|
| **Name** | "SessionProof" throughout [F PDF p.1] | "Vexo Field Assistant" everywhere (`CLAUDE.md` l.1, UI) | [J] "Vexo" is the hardware sponsor's brand; shipping a product under it implies affiliation. Pick one name before the finals |
| **Transport priority** | Direct laptop BLE for judging; "do not spend the finals window proving a mobile app"; stop building mobile if unstable [F PDF p.6, p.16] | Most recent band work is the iPhone path: GlassCam handoff, paired device keys, USB bridge, hands-free WIP (`git log` `1c36cc1`, `2ae9420`, `995d24a`) | The laptop Web Bluetooth path exists, but rehearsals target the phone |
| **Camera-free story vs the bridge app** | "Camera-free" is the advantage [F PDF p.5] | The iPhone bridge is **GlassCam, a Meta-glasses camera app**; Band visit is a tab beside the camera tab (GlassCam `README.md`) | [J] Optics risk on stage and in privacy review; a band-only build or app name would remove it |
| **Auto-reconnect** | "No auto reconnect: keep autoReconnect false" [F PDF p.5] | GlassCam reconnects within 120 s (`README.md` file table); WIP `keepConnected` reconnects automatically | The research shows reconnect is handled without counting it as loss (`band-pipeline-observation.md` §1). Fine for production, but against the demo rule |
| **Double-tap semantics** | Single tap = marker; double-tap = stop [F PDF p.5, p.8] | WIP: double-tap = start/stop (`HANDSFREE-INTERFACE.md`); research proposes double-tap = bookmark (`vexo-band-use-cases.md` row 3) | Three different mappings. Also: a double-tap opens the band's connect window only when no client is connected (`vexo-band-capabilities.md` §1) |
| **Unsupported outcomes can be attested** | System blocks a conclusion the session does not support [F PDF p.2] | `allowProviderProgressAttestation: true` in fixtures (`fixtures/scenario.ts:63`) lets a provider attestation clear `MISSING_PROGRESS`; claims can be `provider_confirmed` (`schemas.ts:143`) | [J] Defensible (the human is accountable), but it is not "refusal". Label provider-attested fields distinctly in the demo |
| **Billing emphasis** | Prior strategy's "billing emphasis" was removed; "not a submitted invoice"; skip Stripe [F PDF p.3, p.7, p.9] | A draft invoice with amounts is a core output (`CLAUDE.md` l.3; observation report amounts per scenario) | Not submitted, so no factual contradiction, but the pitch and the product lead with different things |
| **Program scope** | Program-neutral; CMS/Chafee only "adjacent context" [F PDF p.3, p.7, p.17] | Research and scenarios are California SDP specific (320/331/334/335) | [J] Our specificity is an asset for a pilot, but the strategy should name the first program |
| **Who decides payment** | Provider and FMS/administrator decide eligibility, payment, submission [F PDF p.7, p.12] | Same, but our research shows that under bill-payer FMS the provider business is the employer of record and owns EVV for covered codes (`self-determination-codes.md` §1.5 [I]) | The buyer may carry EVV duties the strategy does not mention |
| **Transcription vendor/model** | Deepgram Flux STT + Flux TTS; Pipecat [F PDF p.6] | Deepgram Nova-3, diarized; no TTS (`docs/band-bridge.md` §Transcribers) | The strategy's own reliability rule says prove Nova-3 first (PDF p.6), so this is a sequencing gap, not a disagreement |
| **Data location** | "Band → laptop BLE → cloud", unspecified [F PDF p.6] | Cloudflare Worker + D1 holds transcript text, client names and rates; Deepgram processes audio (`docs/deploy.md` l.3-7) | The strategy should name Cloudflare and Deepgram as processors |
| **Units/pricing** | Our product: per active staff member [F PDF p.12] | Client invoices are hourly only; SDP 331 is estimated per **day** and is billed hourly without conversion (`band-pipeline-observation.md` §3) | Separate issues: our price unit is unbuilt, and the client-billing unit is wrong for 331 |

---

## 4. Risks the strategy underplays or overstates

| Risk | Strategy | What the code and research show | Judgement |
|---|---|---|---|
| **Transcription accuracy** | Assumes quotes and timestamps are exact enough to make a field "supported" [F PDF p.2, p.8] | Only synthetic or simulated transcripts have been run end to end; live extraction latency and live scrubbing were not observed (`band-pipeline-observation.md` §3, §4 step 7). Speakers stay `Speaker 0/1`, never names (`band-bridge.md`) | [J] Underplayed. The demo's "Independently" answer must be attributed to the right speaker; diarization on a wrist mic in a noisy room is unproven |
| **Recording consent law** | Consent screen + blue light [F PDF p.5] | CA Penal Code § 632 requires all-party consent; participants with developmental disabilities may need an authorized representative; consent is not persisted (`vexo-band-use-cases.md` §3 [L]; `RecordVisit.tsx`) | [J] Underplayed. Persisted, per-participant consent (and who gave it) is needed before any pilot |
| **HIPAA / BAA with Deepgram and Cloudflare** | Says nothing about HIPAA or BAAs; synthetic demo only [F PDF p.14, p.17] | No BAA mention anywhere in `src/` or `docs/` except "HIPAA applies only if the provider is a covered entity" (`vexo-band-use-cases.md` l.125). CMIA/CCPA flagged [L] | [J] Underplayed for the paid pilot. Real participant audio goes to Deepgram before any redaction (`band-bridge.md`). Get BAAs or a counsel opinion that HIPAA does not apply, plus a DPA, before real data |
| **EVV** | Lists EVV only as a Therap feature [F PDF p.13] | SDP 320 is EVV-covered since 2023-01-01; EVV needs six elements including location; the band has no location sensor; we capture no EVV element (`self-determination-codes.md` §1.9; `band-pipeline-observation.md` §3) | [J] Underplayed. A pilot on PCS-type services must say plainly that SessionProof is not EVV and must not conflict with CalEVV |
| **SDP codes and units** | "Program-specific rules" as moat [F PDF p.13] | Rules are not code-specific; authorization hours are not enforced; 331 day units are not converted (`band-pipeline-observation.md` §3) | [J] The moat is plausible but currently empty |
| **One BLE connection, no offline buffer** | "One BLE owner" covered [F PDF p.5]; "phone-in-pocket" left for later [F PDF p.6] | No on-band recording; a ~0.66 s send queue; a link drop loses audio (`vexo-band-capabilities.md` §6, §7). A socket closing without `stop` currently reads as **complete** (`band-pipeline-observation.md` §2.3) | [J] The "loss is visible" promise (PDF p.5) is not fully true today until §2.3 is fixed |
| **iPhone background limits** | Treated as a future hypothesis [F PDF p.6] | `bluetooth-central` is in Info.plist, but lock-screen streaming is **untested** (`glasscam-band-test-plan.md` A8); background rescans are throttled (B13) | [J] Fine for the laptop demo; blocking for the production story |
| **No security overclaim** | Correctly says BLE is unencrypted [F PDF p.14] | Also: deployed bypass paths trust a forgeable header until Access JWT verification ships (`docs/deploy.md` l.12, §5.1, H2) | [J] Must ship before any non-synthetic deploy |
| **Timeline** | Full voice loop by the 120-minute mark [F PDF p.16] | The voice loop is the largest missing piece (3a) | [J] Overstated relative to our state, unless the demo uses a scripted question |

---

## 5. Recommended next five actions (ordered) [J]

1. **Decide the name and the demo transport this week.** SessionProof vs Vexo Field Assistant, and laptop Web Bluetooth vs GlassCam for the judged demo. Freeze the tap mapping (marker vs start/stop) across the strategy, the WIP GlassCam work and the research.
2. **Close the honesty gaps the strategy already promises:** persist consent on the visit, mark sockets that close without `stop` as `partial` (observation §2.3), and add a deterministic "claim exceeds session" refusal plus a distinct label for provider-attested fields. These are S–M and make the trust slide true.
3. **Build the live loop in its smallest form:** tap marker → server marker evidence, then run the rules on interim segments to show supported/missing live, then one scripted clarifying question (TTS) before adding Pipecat and Flux. Keep the post-stop workflow as the system of record.
4. **Rewrite the strategy's business section with the build's real assets:** name California SDP as the first program pack, and add the audit trail (revisions, Amend, run history) and the PDF export. Reframe the invoice as a draft service record, and state "not EVV" explicitly.
5. **Pre-pilot compliance pack:** BAA/DPA status for Deepgram and Cloudflare (or a counsel opinion), all-party and representative consent flow, retention and deletion routes, Access JWT verification shipped, and the employer IP clearance the strategy already requires (PDF p.4).
