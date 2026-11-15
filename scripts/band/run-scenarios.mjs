#!/usr/bin/env -S node --experimental-websocket
// Black-box runner: plays every SYNTHETIC band scenario (fixtures/band/scenarios.ts) against a
// running dev server over the real HTTP API + WebSocket, then reports what the pipeline did
// (statuses, checks, evidence, amount, warnings, run-history stage timings) vs each `expect`.
//
// Usage (Node 20 needs --experimental-websocket; 22+ does not):
//   node --experimental-websocket scripts/band/run-scenarios.mjs [--base http://localhost:8787]
//        [--only <scenario-id>] [--speed 20] [--out docs/reports/band-pipeline-observation.json]
//
// It only creates synthetic data (dev-login demo provider, synthetic SD-* clients). Exit code 1
// on any FAIL, 2 when the server is unreachable.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const base = arg("base", "http://localhost:8787").replace(/\/$/, "");
const only = arg("only", null);
const speed = Math.max(10, Number(arg("speed", 20))); // at least 10x real time
const outPath = resolve(ROOT, arg("out", "docs/reports/band-pipeline-observation.json"));
const origin = new URL(base).origin;
const PPS = 50; // band audio packets per second (20 ms Opus frames)
const CHUNK = 10; // packets sent back-to-back before pacing (200 ms of audio)
const TRANSIENT = ["SCHEDULED", "QUEUED", "PROCESSING", "WAITING_FOR_EVIDENCE"];
const FAKE_PII = ["555-0100", "(555) 555-0100", "test.learner@example.invalid"];

if (typeof WebSocket === "undefined") {
  console.error("No global WebSocket: run with `node --experimental-websocket` (Node 20) or Node 22+.");
  process.exit(2);
}

// ---------------------------------------------------------------- scenarios (TS → ESM via esbuild)
async function loadScenarios() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error("esbuild is needed to read fixtures/band/scenarios.ts (it ships with vite/wrangler: npm install)");
  }
  const r = await esbuild.build({
    entryPoints: [resolve(ROOT, "fixtures/band/scenarios.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const code = r.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return mod.BAND_SCENARIOS;
}

// ---------------------------------------------------------------- http
let cookie = "";
async function call(method, path, body, { raw = false } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return r;
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* non-json */
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j?.error ? JSON.stringify(j.error) : text.slice(0, 200)}`);
  return { status: r.status, data: j?.data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(path, done, { timeoutMs = 60_000, everyMs = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await call("GET", path);
    if (done(r.data)) return { data: r.data, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { data: r.data, ms: Date.now() - t0, timedOut: true };
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- stream one scenario
function packet(seq) {
  const b = new Uint8Array(42);
  b[0] = (seq >> 8) & 0xff;
  b[1] = seq & 0xff;
  b.fill(0xab, 2);
  return b;
}

async function streamScenario(s, streamUrl, streamToken) {
  const tOpen = Date.now();
  // Token in the subprotocol (like the GlassCam bridge), never in the URL; never log the token.
  const ws = new WebSocket(streamUrl, ["vfa-stream", `vfa-token.${streamToken}`]);
  ws.binaryType = "arraybuffer";
  const msgs = [];
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  const done = new Promise((resolveDone, rejectDone) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
      msgs.push(m);
      if (m.type === "ready") readyResolve(m);
      if (m.type === "done") resolveDone(m);
      if (m.type === "error" && m.code !== "no_start") rejectDone(new Error(`stream error ${m.code}`));
    };
    ws.onclose = (e) => resolveDone({ type: "closed", code: e.code });
  });
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error("could not open the stream"));
  });
  await Promise.race([ready, sleep(5000).then(() => Promise.reject(new Error("no ready within 5 s")))]);

  const t0 = Date.now();
  const openMs = t0 - tOpen;
  const audioStartMs = Date.now();
  const total = s.audio.seconds * PPS;
  const drops = s.audio.dropPackets ?? [];
  const reconnects = new Set((s.audio.reconnectAtSec ?? []).map((sec) => sec * PPS));
  ws.send(JSON.stringify({ type: "start", audioStartMs }));
  let seq = 0;
  for (let i = 0; i < total; i++) {
    if (reconnects.has(i)) {
      // Band reconnect: seq restarts at 0; start = band-clock time of the new packet 0.
      ws.send(JSON.stringify({ type: "start", audioStartMs: audioStartMs + i * 20 }));
      seq = 0;
    }
    if (!drops.some(([a, b]) => i >= a && i < b)) ws.send(packet(seq & 0xffff));
    seq++;
    if (i % CHUNK === CHUNK - 1) await sleep((CHUNK * 20) / speed);
  }
  ws.send(JSON.stringify({ type: "stop" }));
  const end = await Promise.race([done, sleep(15_000).then(() => ({ type: "timeout" }))]);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  return {
    openToReadyMs: openMs,
    streamMs: Date.now() - t0,
    finals: msgs.filter((m) => m.type === "final").length,
    interims: msgs.filter((m) => m.type === "interim").length,
    lastStats: msgs.filter((m) => m.type === "stats").at(-1) ?? null,
    end,
  };
}

// ---------------------------------------------------------------- run-history timings
function stageSequence(events) {
  const out = [];
  for (const e of events) if (out.at(-1) !== e.stage) out.push(e.stage);
  return out;
}

/** ms spent reaching each stage: last event of the stage minus last event of the previous stage. */
function stageTimings(events) {
  const lastAt = new Map();
  const order = [];
  for (const e of events) {
    if (!lastAt.has(e.stage)) order.push(e.stage);
    lastAt.set(e.stage, Date.parse(e.at));
  }
  const out = {};
  let prev = null;
  for (const st of order) {
    out[st] = prev === null ? 0 : lastAt.get(st) - prev;
    prev = lastAt.get(st);
  }
  const pair = (stage) => {
    const a = events.find((e) => e.stage === stage && e.status === "started");
    const b = events.find((e) => e.stage === stage && e.status === "succeeded");
    return a && b ? Date.parse(b.at) - Date.parse(a.at) : null;
  };
  const at = (stage) => (lastAt.has(stage) ? lastAt.get(stage) : null);
  const span = (a, b) => (at(a) !== null && at(b) !== null ? at(b) - at(a) : null);
  return {
    perStage: out,
    evidenceMs: pair("evidence"),
    extractionMs: pair("extraction"),
    queuedToDraftMs: span("queued", "draft_saved"),
    approvedToCompletedMs: span("approved", "completed"),
  };
}

function expectedStages(s) {
  if (s.expect.afterProcessing === "NO_EVIDENCE") return ["discovered", "queued", "workflow_started", "load", "evidence", "failed"];
  const b = ["discovered", "queued", "workflow_started", "load", "evidence", "match", "extraction", "assemble", "draft_saved", "approval_wait"];
  return s.review ? [...b, "review_saved", "approved", "client_snapshot", "finalize", "files", "completed"] : b;
}

// ---------------------------------------------------------------- one scenario
async function runScenario(s) {
  const fails = [];
  const check = (name, ok, detail) => {
    if (!ok) fails.push(`${name}: ${detail}`);
  };
  const obs = { id: s.id, serviceCode: `${s.serviceCode.system} ${s.serviceCode.code} (${s.serviceCode.unit})` };
  const tStart = Date.now();

  const start = await call("POST", "/api/visits", { clientRef: s.client.clientRef, bandNumber: null, transport: "sim", scenario: s.id });
  obs.startVisitMs = Date.now() - tStart;
  const visit = start.data.visit;
  obs.visitId = visit.id;
  const st = await streamScenario(s, start.data.streamUrl, start.data.streamToken);
  obs.stream = st;
  check("streamEnd", st.end.type === "done", `stream ended with ${JSON.stringify(st.end)} (no "done")`);
  check("finals", st.finals === s.script.length, `got ${st.finals} want ${s.script.length}`);

  const tStop = Date.now();
  const stop = await call("POST", `/api/visits/${visit.id}/stop`);
  const sessionId = stop.data.sessionId;
  obs.sessionId = sessionId;
  obs.visitAfterStop = { packets: stop.data.visit.packets, lostPackets: stop.data.visit.lostPackets, segmentCount: stop.data.visit.segmentCount };
  const lost = (s.audio.dropPackets ?? []).reduce((n, [a, b]) => n + (b - a), 0);
  check("lostPackets", stop.data.visit.lostPackets === lost, `got ${stop.data.visit.lostPackets} want ${lost}`);
  check("packets", stop.data.visit.packets === s.audio.seconds * PPS - lost, `got ${stop.data.visit.packets} want ${s.audio.seconds * PPS - lost}`);

  const proc = await poll(`/api/sessions/${sessionId}`, (d) => !TRANSIENT.includes(d.session.status));
  obs.stopToProcessedMs = Date.now() - tStop;
  const d = proc.data;
  obs.afterProcessing = d.session.status;
  check("afterProcessing", d.session.status === s.expect.afterProcessing, `got ${d.session.status} want ${s.expect.afterProcessing}${proc.timedOut ? " (timed out)" : ""}`);

  const b1 = d.bundle;
  if (b1) {
    obs.evidence = b1.evidence.length;
    obs.completeness = b1.provenance.evidenceCompleteness;
    obs.promptVersion = b1.provenance.promptVersion;
    obs.warnings = b1.provenance.evidenceWarnings;
    obs.blockingAtR1 = b1.checks.issues.filter((i) => i.blocking).map((i) => i.code).sort();
    obs.nonBlockingAtR1 = b1.checks.issues.filter((i) => !i.blocking).map((i) => i.code).sort();
    obs.estimateAtR1 = b1.billing.estimateAmountCents;
    obs.scheduledMinutesAtR1 = b1.billing.scheduledMinutes;
    check("evidence", b1.evidence.length === s.script.length, `got ${b1.evidence.length} want ${s.script.length}`);
    check("completeness", obs.completeness === s.expect.evidenceCompleteness, `got ${obs.completeness} want ${s.expect.evidenceCompleteness}`);
    if (s.script.length) check("promptVersion", obs.promptVersion === "fixture-scenario-v1", `got ${obs.promptVersion}`);
    for (const w of s.expect.warningsInclude ?? []) check("warning", obs.warnings.join(" | ").includes(w), `missing "${w}"`);
    const want = [...s.expect.blockingAtR1].sort();
    check("blockingAtR1", JSON.stringify(obs.blockingAtR1) === JSON.stringify(want), `got ${obs.blockingAtR1} want ${want}`);
  } else {
    obs.evidence = 0;
    check("bundle", s.expect.afterProcessing !== "NEEDS_REVIEW", "no bundle but NEEDS_REVIEW expected");
  }

  // review + approve
  obs.amountCents = null;
  if (s.review && b1) {
    const rev = await call("PATCH", `/api/sessions/${sessionId}/review`, { expectedRevision: b1.bundleRevision, edits: s.review });
    obs.amountCents = rev.data.billing.amountCents;
    obs.canApproveAfterReview = rev.data.checks.canApprove;
    check("canApprove", rev.data.checks.canApprove === true, `blocking ${rev.data.checks.issues.filter((i) => i.blocking).map((i) => i.code)}`);
    const tAppr = Date.now();
    const ap = await call("POST", `/api/sessions/${sessionId}/approve`, {
      expectedRevision: rev.data.bundleRevision,
      idempotencyKey: `obs-${s.id}-${visit.id.slice(-12)}-r${rev.data.bundleRevision}`,
    });
    obs.approveHttp = ap.status;
    const fin = await poll(`/api/sessions/${sessionId}`, (x) => x.session.status === "COMPLETED" || x.session.status === "FAILED");
    obs.approveToCompletedMs = Date.now() - tAppr;
    obs.final = fin.data.session.status;
    obs.amountCents = fin.data.bundle?.billing.amountCents ?? obs.amountCents;
    check("final", obs.final === s.expect.final, `got ${obs.final} want ${s.expect.final}${fin.timedOut ? " (timed out)" : ""}`);
    if (obs.final === "COMPLETED") {
      const pdf = await call("GET", `/api/sessions/${sessionId}/files/invoice`, null, { raw: true });
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      obs.invoicePdf = pdf.status === 200 && new TextDecoder().decode(bytes.slice(0, 4)) === "%PDF" ? `${bytes.byteLength} B` : `HTTP ${pdf.status}`;
      check("invoicePdf", obs.invoicePdf.endsWith(" B"), obs.invoicePdf);
    }
  } else {
    obs.final = d.session.status;
    check("final", obs.final === s.expect.final, `got ${obs.final} want ${s.expect.final}`);
  }
  check("amount", obs.amountCents === s.expect.amountCentsAfterReview, `got ${obs.amountCents} want ${s.expect.amountCentsAfterReview}`);

  // run history
  const runs = await call("GET", `/api/runs?sessionId=${encodeURIComponent(sessionId)}`);
  const runId = runs.data.runs.find((r) => r.runKind === "processing")?.runId;
  if (runId) {
    const det = await call("GET", `/api/runs/${encodeURIComponent(runId)}`);
    const events = det.data.events;
    obs.runId = runId;
    obs.runStatus = det.data.summary.status;
    obs.runDurationMs = det.data.summary.durationMs;
    const want = expectedStages(s);
    // The store orders by (at_ms, id); events recorded in the same millisecond come back in id
    // (alphabetical) order. Compare with ties broken by pipeline order, and report the raw order.
    obs.stagesAsStored = stageSequence(events);
    const rank = (st) => (want.indexOf(st) < 0 ? 99 : want.indexOf(st));
    const ordered = events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at) || rank(a.e.stage) - rank(b.e.stage) || a.i - b.i)
      .map((x) => x.e);
    obs.stages = stageSequence(ordered);
    obs.sameMsTieReordered = JSON.stringify(obs.stages) !== JSON.stringify(obs.stagesAsStored);
    obs.timings = stageTimings(ordered);
    check("stages", JSON.stringify(obs.stages) === JSON.stringify(want), `got ${obs.stages.join(">")} want ${want.join(">")}`);
    const blob = JSON.stringify(events);
    const leaks = [...s.script.map((l) => l.text), ...FAKE_PII, s.client.displayName].filter((t) => blob.includes(t));
    obs.runEventLeaks = leaks.length;
    check("noTranscriptInRunEvents", leaks.length === 0, `${leaks.length} leaked string(s)`);
  } else {
    check("run", false, "no processing run recorded");
  }

  obs.totalMs = Date.now() - tStart;
  obs.result = fails.length ? "FAIL" : "PASS";
  obs.failures = fails;
  return obs;
}

// ---------------------------------------------------------------- main
function pct(values, p) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

async function main() {
  try {
    const r = await fetch(`${base}/api/visits/capture-status`);
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.error(`Dev server unreachable at ${base}: ${err.message}`);
    process.exit(2);
  }
  const all = await loadScenarios();
  const scenarios = only ? all.filter((s) => s.id === only) : all;
  if (!scenarios.length) {
    console.error(`No scenario "${only}". Known: ${all.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  const login = await fetch(`${base}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ identity: "demo.provider@example.invalid" }),
  });
  if (!login.ok) throw new Error(`dev-login ${login.status}`);
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const cap = await call("GET", "/api/visits/capture-status");
  if (cap.data.transcriber !== "simulated") {
    console.error(`Scenarios need the simulated transcriber; server reports "${cap.data.transcriber}".`);
    process.exit(1);
  }
  await call("POST", "/api/dev/seed");

  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`▶ ${s.id} … `);
    try {
      const r = await runScenario(s);
      results.push(r);
      console.log(`${r.result} (${r.totalMs} ms)${r.failures.length ? `\n    ${r.failures.join("\n    ")}` : ""}`);
    } catch (err) {
      results.push({ id: s.id, result: "FAIL", failures: [`error: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}`] });
      console.log(`FAIL\n    error: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}`);
    }
  }

  // stage timing aggregates (ms spent reaching each stage)
  const stageNames = [...new Set(results.flatMap((r) => Object.keys(r.timings?.perStage ?? {})))];
  const stageStats = Object.fromEntries(
    stageNames.map((st) => {
      const vals = results.map((r) => r.timings?.perStage?.[st]);
      return [st, { p50: pct(vals, 50), max: pct(vals, 100), n: vals.filter((x) => typeof x === "number").length }];
    }),
  );
  const agg = (k) => ({ p50: pct(results.map((r) => r.timings?.[k]), 50), max: pct(results.map((r) => r.timings?.[k]), 100) });
  const clientAgg = (k) => ({ p50: pct(results.map((r) => r[k]), 50), max: pct(results.map((r) => r[k]), 100) });

  console.log("\n" + ["scenario", "result", "after", "blockers@r1", "ev", "complete", "amount", "final", "stop→processed ms", "approve→done ms"].join(" | "));
  for (const r of results) {
    console.log(
      [r.id, r.result, r.afterProcessing ?? "-", (r.blockingAtR1 ?? []).join(",") || "-", r.evidence ?? "-", r.completeness ?? "-", r.amountCents ?? "-", r.final ?? "-", r.stopToProcessedMs ?? "-", r.approveToCompletedMs ?? "-"].join(" | "),
    );
  }
  console.log("\nstage (ms to reach) | p50 | max");
  for (const [st, v] of Object.entries(stageStats)) console.log(`${st} | ${v.p50} | ${v.max}`);

  const report = {
    generatedAt: new Date().toISOString(),
    base,
    speed,
    node: process.version,
    scenarios: results,
    aggregates: {
      stageMsToReach: stageStats,
      evidenceMs: agg("evidenceMs"),
      extractionMs: agg("extractionMs"),
      queuedToDraftMs: agg("queuedToDraftMs"),
      approvedToCompletedMs: agg("approvedToCompletedMs"),
      clientStopToProcessedMs: clientAgg("stopToProcessedMs"),
      clientApproveToCompletedMs: clientAgg("approveToCompletedMs"),
    },
    pass: results.filter((r) => r.result === "PASS").length,
    fail: results.filter((r) => r.result === "FAIL").length,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n${report.pass} PASS, ${report.fail} FAIL → ${pathToFileURL(outPath).pathname}`);
  process.exit(report.fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
