#!/usr/bin/env -S node --experimental-websocket
// Black-box "provider's day" demo against a running server: plays every SYNTHETIC day script
// (fixtures/schedule/day-scripts.ts) as a client-less band recording over the real device API +
// WebSocket, stops it, waits for the calendar partition (+ content pass 2) and the drafted
// sessions, then reports per recording: sessions (client, minutes, status), unassigned /
// ambiguous counts, suggestions, conversation types, blockers, checklist fails, invoice total and
// whether CLAIM_EXCEEDS_EVIDENCE refused the overstatement bait.
//
// Usage (Node 20 needs --experimental-websocket; 22+ does not):
//   node --experimental-websocket scripts/demo/run-day.mjs [--only day-handoff] [--speed 20] [--gap-speed 200]
//        [--session-timeout 240] [--out docs/reports]
// Env: BASE_URL (default http://127.0.0.1:8787) · DEVICE_KEY (vfad_…; otherwise pairs a phone via
//      dev-login, local dev only) · SESSION_COOKIE (optional web cookie for a non-local server).
//
// Day scripts need the simulated transcriber in local dev (POST /api/device/recordings { scenario });
// a deployed server answers 400 SCENARIO_DEV_ONLY. Writes docs/reports/demo-day-<date>.{json,md}.
// Exit 0 when every recording partitioned and matched its script's expectations, 1 otherwise, 2 unreachable.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const base = (process.env.BASE_URL ?? arg("base", "http://127.0.0.1:8787")).replace(/\/$/, "");
const only = arg("only", null);
const speed = Math.max(1, Number(arg("speed", 20)));
// Silence between lines (travel, a quiet task) streams faster: the timing of every line is kept,
// but a 17-minute drive does not hold a socket open for a minute (a dev-server reload drops it).
const gapSpeed = Math.max(speed, Number(arg("gap-speed", 200)));
const LINE_MARGIN_SEC = 5;
const sessionTimeoutMs = Number(arg("session-timeout", 240)) * 1000;
const outDir = resolve(ROOT, arg("out", "docs/reports"));
const origin = new URL(base).origin;
const PPS = 50; // band packets per second (20 ms Opus frames)
const CHUNK = 10;
const TRANSIENT = ["SCHEDULED", "QUEUED", "PROCESSING", "WAITING_FOR_EVIDENCE"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket === "undefined") {
  console.error("No global WebSocket: run with `node --experimental-websocket` (Node 20) or Node 22+.");
  process.exit(2);
}

// ---------------------------------------------------------------- day scripts (TS → ESM via esbuild)
async function loadDayScripts() {
  const esbuild = await import("esbuild").catch(() => {
    throw new Error("esbuild is needed to read fixtures/schedule/day-scripts.ts (it ships with vite/wrangler: npm install)");
  });
  const r = await esbuild.build({ entryPoints: [resolve(ROOT, "fixtures/schedule/day-scripts.ts")], bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`);
}

// ---------------------------------------------------------------- http
let cookie = process.env.SESSION_COOKIE ?? "";
let deviceKey = process.env.DEVICE_KEY ?? "";

async function call(method, path, body, { auth = "cookie", allow = [] } = {}) {
  const headers = { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
  if (auth === "device") headers.authorization = `Bearer ${deviceKey}`;
  else if (cookie) headers.cookie = cookie;
  const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* non-json */
  }
  if (!r.ok && !allow.includes(r.status)) {
    const err = new Error(`${method} ${path} → ${r.status} ${j?.error ? `${j.error.code}: ${j.error.message}` : text.slice(0, 200)}`);
    err.status = r.status;
    err.code = j?.error?.code;
    throw err;
  }
  return { status: r.status, data: j?.data ?? null, error: j?.error ?? null };
}

async function poll(fn, done, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v)) return { value: v, ms: Date.now() - t0, timedOut: false };
    if (Date.now() - t0 > timeoutMs) return { value: v, ms: Date.now() - t0, timedOut: true };
    await sleep(everyMs);
  }
}

async function authenticate() {
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname);
  if (!cookie && local) {
    const login = await fetch(`${base}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ identity: "demo.provider@example.invalid" }),
    });
    if (!login.ok) throw new Error(`dev-login ${login.status}`);
    cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  if (!deviceKey) {
    if (!cookie) throw new Error("Set DEVICE_KEY (and SESSION_COOKIE for session details) for a non-local server.");
    const paired = await call("POST", "/api/devices", { name: `run-day ${new Date().toISOString().slice(0, 16)}` });
    deviceKey = paired.data.key;
    return { pairedDeviceId: paired.data.device.id };
  }
  return { pairedDeviceId: null };
}

// ---------------------------------------------------------------- stream one recording
function packet(seq) {
  const b = new Uint8Array(42);
  b[0] = (seq >> 8) & 0xff;
  b[1] = seq & 0xff;
  b.fill(0xab, 2);
  return b;
}

/** Opens the stream the way the phone does: token in the vfa-token subprotocol, else the URL carries it. */
function openStream(start) {
  if (start.streamToken) return new WebSocket(start.streamUrl, ["vfa-stream", `vfa-token.${start.streamToken}`]);
  return new WebSocket(start.streamUrl);
}

async function streamScript(start, seconds, lines) {
  const near = (sec) => lines.some((l) => sec >= l.atSec - LINE_MARGIN_SEC && sec <= l.atSec + l.durationSec + LINE_MARGIN_SEC);
  const ws = openStream(start); // never log the URL or token
  ws.binaryType = "arraybuffer";
  const msgs = [];
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  const done = new Promise((resolveDone) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
      msgs.push(m);
      if (m.type === "ready") readyResolve(m);
      if (m.type === "done") resolveDone(m);
      if (m.type === "error" && m.code !== "no_start") resolveDone({ type: "error", code: m.code });
    };
    ws.onclose = (e) => resolveDone({ type: "closed", code: e.code });
  });
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error("could not open the stream"));
  });
  await Promise.race([ready, sleep(5000).then(() => Promise.reject(new Error("no ready within 5 s")))]);
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "start", audioStartMs: Date.now() }));
  const total = Math.ceil(seconds * PPS) + PPS; // one extra second so the last line is reached
  let lastLog = 0;
  for (let i = 0; i < total; i++) {
    ws.send(packet(i & 0xffff));
    if (i % CHUNK === CHUNK - 1) {
      await sleep((CHUNK * 20) / (near(i / PPS) ? speed : gapSpeed));
      if (process.stdout.isTTY && Date.now() - lastLog > 1000) {
        lastLog = Date.now();
        process.stdout.write(`\r    streaming ${Math.round((i / total) * 100)}% (${Math.round(i / PPS / 60)} of ${Math.round(seconds / 60)} audio min)   `);
      }
    }
  }
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(70) + "\r");
  ws.send(JSON.stringify({ type: "stop" }));
  const end = await Promise.race([done, sleep(20_000).then(() => ({ type: "timeout" }))]);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  return { streamMs: Date.now() - t0, packets: total, finals: msgs.filter((m) => m.type === "final").length, end };
}

// ---------------------------------------------------------------- session analysis
// Every claim an issue may name (goal claims included: a refusal of "goal1_claim1" must resolve).
const claimsOf = (facts) => (facts ? [...facts.activities, ...facts.observations, ...facts.progress, ...facts.followUps, ...facts.goals.flatMap((g) => g.claims)] : []);
const BAIT_RE = /\bpay(?:s|ing)?\s+(?:all\s+)?(?:of\s+)?(?:her\s+|the\s+)?bills\b[^.]*\b(?:alone|independently|every\s+month|on\s+her\s+own)|\bcan\s+now\s+pay\b/i;
const SUBMITTED_RE = /\b(?:submitted|sent in|filed|applied)\b[^.]*\b(?:application|bus pass|fare)\b|\b(?:application|bus pass)\b[^.]*\b(?:was|has been|were)\s+(?:submitted|sent|filed)\b/i;
const NEGATION_RE = /\b(?:not|n't|yet|pending|has not|have not|will|plan(?:ned)? to|next)\b/i;

function analyseBundle(bundle, script) {
  const issues = bundle?.checks?.issues ?? [];
  const claims = claimsOf(bundle?.facts);
  const out = {
    blockers: issues.filter((i) => i.blocking).map((i) => i.code),
    nonBlocking: issues.filter((i) => !i.blocking).map((i) => i.code),
    checklistFails: (bundle?.checks?.checklist?.items ?? []).filter((i) => i.status === "fail").map((i) => i.id),
    checklistSummary: bundle?.checks?.checklist?.summary ?? null,
    invoiceTotalCents: bundle?.billing?.invoice?.totalCents ?? bundle?.billing?.amountCents ?? null,
    estimateCents: bundle?.billing?.estimateAmountCents ?? null,
    isEstimate: bundle?.billing?.isEstimate ?? null,
    scheduledMinutes: bundle?.documents?.timeSummary?.scheduledMinutes ?? bundle?.billing?.scheduledMinutes ?? null,
    evidenceMinutes: bundle?.documents?.timeSummary?.evidenceWindowMinutes ?? null,
    evidence: bundle?.evidence?.length ?? 0,
    claims: claims.length,
    drafter: bundle?.provenance?.drafter?.label ?? bundle?.provenance?.extractionMode ?? null,
    completeness: bundle?.provenance?.evidenceCompleteness ?? null,
    bait: null,
    negatedPlan: null,
    refusedClaims: issues
      .filter((i) => i.code === "CLAIM_EXCEEDS_EVIDENCE")
      .map((i) => {
        const id = i.field?.startsWith("claim:") ? i.field.slice(6) : null;
        return { id, text: (claims.find((c) => c.id === id)?.text ?? "").slice(0, 160), resolved: !!claims.find((c) => c.id === id) };
      }),
  };
  if (script.expect.bait) {
    const refused = issues.filter((i) => i.code === "CLAIM_EXCEEDS_EVIDENCE");
    const baitClaims = claims.filter((c) => BAIT_RE.test(c.text));
    const baitIds = new Set(baitClaims.map((c) => c.id));
    const refusedBait = refused.filter((i) => [...baitIds].some((id) => i.field === `claim:${id}` || i.message.includes(id)));
    out.bait =
      baitClaims.length === 0
        ? { verdict: "not drafted", detail: `drafter did not write the overstatement; ${refused.length} CLAIM_EXCEEDS_EVIDENCE issue(s) on other claims` }
        : refusedBait.length === baitClaims.length
          ? { verdict: "refused", detail: `CLAIM_EXCEEDS_EVIDENCE blocked ${refusedBait.length} bait claim(s)` }
          : { verdict: "LEAKED", detail: `${baitClaims.length - refusedBait.length} bait claim(s) drafted without a refusal` };
  }
  if (script.expect.negatedPlan) {
    const wrong = claims.filter((c) => SUBMITTED_RE.test(c.text) && !NEGATION_RE.test(c.text));
    out.negatedPlan = wrong.length ? { verdict: "WRONG", detail: `${wrong.length} claim(s) say the application was submitted` } : { verdict: "ok", detail: "no claim says it was submitted" };
  }
  return out;
}

// ---------------------------------------------------------------- one day script
async function runScript(s, mod) {
  const fails = [];
  const check = (name, ok, detail) => {
    if (!ok) fails.push(`${name}: ${detail}`);
  };
  const t0 = Date.now();
  const seconds = mod.dayScriptSeconds(s);
  const obs = { id: s.id, title: s.title, audioMinutes: Math.round(seconds / 60) };

  const start = await call("POST", "/api/device/recordings", { bandNumber: null, transport: "sim", timezone: "America/Los_Angeles", scenario: s.id }, { auth: "device" });
  const rec = start.data.recording;
  obs.recordingId = rec.id;
  obs.transcriber = rec.transcriber;
  obs.currentEventAtStart = start.data.currentEvent ? `${start.data.currentEvent.clientRef} ${start.data.currentEvent.eventId}` : null;

  const st = await streamScript(start.data, seconds, s.script);
  obs.stream = st;
  check("stream", st.end.type === "done", `ended with ${JSON.stringify(st.end)}`);
  check("finals", st.finals === s.script.length, `got ${st.finals} want ${s.script.length}`);

  await call("POST", `/api/device/recordings/${rec.id}/stop`, {}, { auth: "device" });
  const part = await poll(
    async () => (await call("GET", `/api/device/recordings/${rec.id}`, undefined, { auth: "device" })).data.recording,
    (r) => r.status === "partitioned" || r.status === "failed",
    { timeoutMs: 120_000 },
  );
  const r = part.value;
  obs.status = r.status;
  obs.stopToPartitionedMs = part.ms;
  check("partitioned", r.status === "partitioned", `status ${r.status}${part.timedOut ? " (timed out)" : ""}`);
  const p = r.partition ?? { sessions: [], unassignedSegments: 0, ambiguousSegments: 0 };
  obs.unassigned = p.unassignedSegments;
  obs.ambiguous = p.ambiguousSegments;
  obs.unassignedMinutes = p.unassignedMs !== undefined ? Math.round(p.unassignedMs / 6000) / 10 : null;
  check("unassigned", p.unassignedSegments === s.expect.unassignedSegments, `got ${p.unassignedSegments} want ${s.expect.unassignedSegments}`);
  check("ambiguous", p.ambiguousSegments === s.expect.ambiguousSegments, `got ${p.ambiguousSegments} want ${s.expect.ambiguousSegments}`);
  const gotSessions = p.sessions.map((x) => `${x.clientRef}×${x.segmentCount}`);
  const wantSessions = s.expect.sessions.map((x) => `${x.clientRef}×${x.segments}`);
  check("sessions", JSON.stringify(gotSessions) === JSON.stringify(wantSessions), `got [${gotSessions}] want [${wantSessions}]`);

  // Web detail: suggestions + conversation types (pass 2; tolerate absence on older servers).
  obs.suggestions = null;
  obs.sessionConversations = null;
  obs.detailError = null;
  if (cookie) {
    const needsPass2 = p.unassignedSegments + p.ambiguousSegments > 0;
    const det = await poll(
      async () => (await call("GET", `/api/recordings/${rec.id}`)).data,
      (d) => !needsPass2 || !Array.isArray(d.suggestions) || d.suggestions.length > 0,
      { timeoutMs: 20_000, everyMs: 1000 },
    ).catch((err) => {
      // e.g. a server whose dev DB lacks the pass-2 migration: report it, keep going.
      obs.detailError = err.message;
      return { value: {} };
    });
    const d = det.value;
    if (Array.isArray(d.suggestions)) {
      obs.suggestions = d.suggestions.map((x) => ({
        client: x.suggestedClientRef ?? "none",
        kind: x.kind,
        segments: x.segmentIndexes.length,
        confidence: Math.round(x.confidence * 100) / 100,
        method: x.method,
        conversation: x.conversation ? `${x.conversation.conversationType} ${Math.round(x.conversation.confidence * 100) / 100}` : null,
        status: x.status,
      }));
      if (s.expect.suggestedClientRef !== undefined) {
        const clients = obs.suggestions.map((x) => x.client);
        check(
          "suggestion",
          s.expect.suggestedClientRef === null ? !clients.some((c) => c !== "none") : clients.includes(s.expect.suggestedClientRef),
          `got [${clients}] want ${s.expect.suggestedClientRef ?? "none"}`,
        );
        if (s.expect.suggestedKind && s.expect.suggestedClientRef) {
          const hit = obs.suggestions.find((x) => x.client === s.expect.suggestedClientRef);
          check("suggestionKind", hit?.kind === s.expect.suggestedKind, `got ${hit?.kind ?? "none"} want ${s.expect.suggestedKind}`);
        }
      }
    }
    if (Array.isArray(d.sessionConversations)) {
      obs.sessionConversations = d.sessionConversations.map((c) => ({ eventId: c.eventId, type: c.conversationType, confidence: Math.round(c.confidence * 100) / 100, needsConfirmation: c.needsConfirmation }));
    }
  }

  // Sessions: wait for each draft.
  obs.sessions = [];
  for (const x of p.sessions) {
    const so = { client: x.clientRef, sessionId: x.sessionId, segments: x.segmentCount };
    if (!cookie) {
      so.status = "(no web cookie)";
      obs.sessions.push(so);
      continue;
    }
    const sp = await poll(
      async () => (await call("GET", `/api/sessions/${x.sessionId}`)).data,
      (d) => !TRANSIENT.includes(d.session.status),
      { timeoutMs: sessionTimeoutMs, everyMs: 1000 },
    );
    so.status = sp.value.session.status + (sp.timedOut ? " (timed out)" : "");
    so.stopToDraftMs = sp.ms;
    Object.assign(so, analyseBundle(sp.value.bundle, s));
    check(`session ${x.clientRef}`, sp.value.session.status === "NEEDS_REVIEW", `status ${so.status}`);
    if (so.bait) check("bait", so.bait.verdict !== "LEAKED", so.bait.detail);
    for (const code of s.expect.sessionBlockers ?? []) check(`blocker ${code}`, so.blockers.includes(code), `session ${x.clientRef} blockers [${so.blockers}]`);
    for (const code of s.expect.forbiddenBlockers ?? []) check(`no ${code}`, !so.blockers.includes(code), `session ${x.clientRef} blockers [${so.blockers}]`);
    // Every claim-level refusal must name a claim in the bundle's facts.
    const ids = new Set(claimsOf(sp.value.bundle?.facts).map((c) => c.id));
    const dangling = (sp.value.bundle?.checks?.issues ?? []).filter((i) => i.field?.startsWith("claim:") && !ids.has(i.field.slice(6)));
    check("claimRefs", dangling.length === 0, `${dangling.length} issue(s) name a claim not in the facts: ${dangling.map((i) => i.field).join(", ")}`);
    if (so.negatedPlan) check("negatedPlan", so.negatedPlan.verdict === "ok", so.negatedPlan.detail);
    obs.sessions.push(so);
  }
  obs.totalMs = Date.now() - t0;
  obs.result = fails.length ? "FAIL" : "PASS";
  obs.failures = fails;
  return obs;
}

// ---------------------------------------------------------------- report
const money = (c) => (c === null || c === undefined ? "—" : `$${(c / 100).toFixed(2)}`);
const list = (a) => (a && a.length ? a.join(", ") : "—");

function markdown(report) {
  const L = [];
  L.push(`# Demo day report (${report.generatedAt.slice(0, 10)})`, "");
  L.push(`SYNTHETIC data only. Server \`${report.base}\` · health ${JSON.stringify(report.health)} · speed ${report.speed}× · node ${report.node}.`);
  L.push(`Generated by \`scripts/demo/run-day.mjs\` from \`fixtures/schedule/day-scripts.ts\`. Result: **${report.passed}/${report.recordings.length} PASS**.`, "");
  L.push("## Recordings", "");
  L.push("| script | result | audio min | sessions (client × segments) | unassigned | ambiguous | suggestions | conversation types |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const r of report.recordings) {
    const conv = [
      ...(r.sessionConversations ?? []).map((c) => `session: ${c.type}${c.needsConfirmation ? " (confirm)" : ""}`),
      ...(r.suggestions ?? []).filter((x) => x.conversation).map((x) => `block: ${x.conversation}`),
    ];
    L.push(
      `| ${r.id} | ${r.result} | ${r.audioMinutes ?? "—"} | ${list((r.sessions ?? []).map((s) => `${s.client} × ${s.segments}`))} | ${r.unassigned ?? "—"}${r.unassignedMinutes !== null && r.unassignedMinutes !== undefined ? ` (${r.unassignedMinutes} min)` : ""} | ${r.ambiguous ?? "—"} | ${r.suggestions === null || r.suggestions === undefined ? "n/a" : list(r.suggestions.map((x) => `${x.client} ${x.kind} ${x.confidence} ${x.method}`))} | ${conv.length ? conv.join("; ") : r.sessionConversations === null ? "n/a" : "—"} |`,
    );
  }
  L.push("", "## Sessions", "");
  L.push("| script | client | status | scheduled / evidence min | blockers | checklist fails | invoice total | bait (CLAIM_EXCEEDS_EVIDENCE) | negated plan |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of report.recordings) {
    for (const s of r.sessions ?? []) {
      L.push(
        `| ${r.id} | ${s.client} | ${s.status} | ${s.scheduledMinutes ?? "—"} / ${s.evidenceMinutes ?? "—"} | ${list(s.blockers)} | ${list(s.checklistFails)} | ${s.invoiceTotalCents !== null ? money(s.invoiceTotalCents) : `${money(s.estimateCents)} (estimate)`} | ${s.bait ? `${s.bait.verdict}: ${s.bait.detail}` : "—"} | ${s.negatedPlan ? `${s.negatedPlan.verdict}` : "—"} |`,
      );
    }
  }
  const refusals = report.recordings.flatMap((r) => (r.sessions ?? []).flatMap((s) => (s.refusedClaims ?? []).map((c) => ({ r, s, c }))));
  if (refusals.length) {
    L.push("", "## Refused claims (CLAIM_EXCEEDS_EVIDENCE)", "");
    for (const { r, s, c } of refusals) L.push(`- ${r.id} ${s.client} \`${c.id ?? "?"}\`${c.resolved ? "" : " (NOT in facts)"}: ${c.text || "—"}`);
  }
  const detailErrors = report.recordings.filter((r) => r.detailError);
  if (detailErrors.length) {
    L.push("", "## Recording detail unavailable", "");
    for (const r of detailErrors) L.push(`- **${r.id}**: ${r.detailError} (suggestions / conversation types not read)`);
  }
  const failing = report.recordings.filter((r) => r.failures?.length);
  if (failing.length) {
    L.push("", "## Mismatches vs the script expectations", "");
    for (const r of failing) for (const f of r.failures) L.push(`- **${r.id}**: ${f}`);
  }
  L.push("", "## Notes", "");
  L.push("- Each script brings its own calendar (minute offsets from the recording's audio start); the dev overlay `src/schedule/day-script-overlay.ts` adds it to the demo calendar and hides the weekly pattern / now-slot around the script for that recording's partition.");
  L.push("- Segment times are audio start + script seconds, so a script streamed at 20× lands its later lines in the (near) future. Unassigned text is deleted 24 h after partitioning.");
  L.push("- Invoice totals stay estimates until the provider confirms the duration in review.");
  return L.join("\n") + "\n";
}

function printTable(report) {
  console.log("\nscript | result | sessions | unassigned | ambiguous | suggestions | conversation types");
  for (const r of report.recordings) {
    const conv = [...(r.sessionConversations ?? []).map((c) => c.type), ...(r.suggestions ?? []).map((x) => x.conversation).filter(Boolean)];
    console.log(
      [r.id, r.result, list((r.sessions ?? []).map((s) => `${s.client}×${s.segments}`)), r.unassigned ?? "-", r.ambiguous ?? "-", r.suggestions ? list(r.suggestions.map((x) => `${x.client}/${x.kind}/${x.confidence}`)) : "n/a", conv.length ? conv.join(", ") : "-"].join(" | "),
    );
  }
  console.log("\nscript | client | status | sched/evid min | blockers | checklist fails | invoice | bait | negated plan");
  for (const r of report.recordings)
    for (const s of r.sessions ?? [])
      console.log(
        [r.id, s.client, s.status, `${s.scheduledMinutes ?? "-"}/${s.evidenceMinutes ?? "-"}`, list(s.blockers), list(s.checklistFails), s.invoiceTotalCents !== null ? money(s.invoiceTotalCents) : `${money(s.estimateCents)} est.`, s.bait ? s.bait.verdict : "-", s.negatedPlan ? s.negatedPlan.verdict : "-"].join(" | "),
      );
}

/** Wall-clock seconds to stream a script at speed (near lines) / gapSpeed (silence). */
function streamEstimateSec(lines, seconds) {
  let t = 0;
  for (let sec = 0; sec < seconds + 1; sec++) {
    const near = lines.some((l) => sec >= l.atSec - LINE_MARGIN_SEC && sec <= l.atSec + l.durationSec + LINE_MARGIN_SEC);
    t += 1 / (near ? speed : gapSpeed);
  }
  return t;
}

// ---------------------------------------------------------------- main
async function main() {
  let health;
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()).data;
    health = { evidence: d.evidenceMode, extraction: d.extractionMode, runtime: d.runtimeMode };
  } catch (err) {
    console.error(`Server unreachable at ${base}: ${err.message}`);
    process.exit(2);
  }
  const mod = await loadDayScripts();
  const scripts = only ? mod.DAY_SCRIPTS.filter((s) => s.id === only) : [...mod.DAY_SCRIPTS];
  if (!scripts.length) {
    console.error(`No day script "${only}". Known: ${mod.DAY_SCRIPTS.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }
  const auth = await authenticate();
  console.log(`run-day against ${base} (${JSON.stringify(health)}), ${scripts.length} script(s) at ${speed}×${auth.pairedDeviceId ? ", paired a demo phone" : ""}`);

  const recordings = [];
  for (const s of scripts) {
    console.log(`▶ ${s.id}: ${s.title} (${Math.round(mod.dayScriptSeconds(s) / 60)} audio min ≈ ${Math.round(streamEstimateSec(s.script, mod.dayScriptSeconds(s)))} s)`);
    try {
      let r = await runScript(s, mod);
      if (r.stream?.end?.type === "closed" && r.stream.end.code === 1006) {
        // The dev server dropped the socket (e.g. a hot reload). Retry once with a new recording.
        console.log(`  stream dropped (1006) after ${Math.round(r.stream.streamMs / 1000)} s; retrying with a new recording`);
        const retry = await runScript(s, mod);
        retry.retriedAfter = { recordingId: r.recordingId, failures: r.failures };
        r = retry;
      }
      recordings.push(r);
      console.log(`  ${r.result} in ${Math.round(r.totalMs / 1000)} s${r.failures.length ? `\n    ${r.failures.join("\n    ")}` : ""}`);
    } catch (err) {
      recordings.push({ id: s.id, title: s.title, result: "FAIL", failures: [`error: ${err.message}`] });
      console.log(`  FAIL: ${err.message}`);
      if (err.code === "SCENARIO_DEV_ONLY") break;
    }
  }
  if (auth.pairedDeviceId) await call("DELETE", `/api/devices/${auth.pairedDeviceId}`).catch(() => undefined);

  const report = { generatedAt: new Date().toISOString(), base, health, speed, node: process.version, passed: recordings.filter((r) => r.result === "PASS").length, recordings };
  printTable(report);
  mkdirSync(outDir, { recursive: true });
  const stem = resolve(outDir, `demo-day-${report.generatedAt.slice(0, 10)}`);
  writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${stem}.md`, markdown(report));
  console.log(`\nwrote ${stem}.md and .json`);
  process.exit(report.passed === recordings.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
