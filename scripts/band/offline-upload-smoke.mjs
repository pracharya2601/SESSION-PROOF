#!/usr/bin/env node
/**
 * Offline-recording smoke test against a running LOCAL dev server (npm run dev).
 * Plays what GlassCam does after an offline visit: create the offline visit, PUT a VXREC1 file
 * built from real band Opus packets, then poll until the session is ready for review.
 *
 *   node scripts/band/offline-upload-smoke.mjs [--server http://127.0.0.1:8787] [--key vfad_…]
 *        [--packets <file of [u16 LE len][opus]…>] [--client C-104] [--runs 2]
 *
 * Without --key it pairs a throwaway device through the dev login (local dev only).
 * Audio: src/ui/public/sample-speech.opus (synthetic demo speech), or --packets.
 * With DEEPGRAM_API_KEY in .dev.vars this calls real Deepgram; without it, the simulated script.
 * Prints ids, sizes, counts and times only: never the device key or transcript text.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { oggPackets } from "../../src/ui/vendor/vexo-open/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : (all[i + 1] ?? "1")]] : acc), []),
);
const server = (args.server ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const clientRef = args.client ?? "C-104";
const runCount = Math.max(1, Math.min(4, Number(args.runs ?? 2)));

function loadPackets() {
  if (args.packets) {
    const b = readFileSync(args.packets);
    const out = [];
    for (let at = 0; at + 2 <= b.length; ) {
      const n = b.readUInt16LE(at);
      out.push(new Uint8Array(b.subarray(at + 2, at + 2 + n)));
      at += 2 + n;
    }
    return out;
  }
  return oggPackets(new Uint8Array(readFileSync(resolve(ROOT, "src/ui/public/sample-speech.opus"))));
}

function buildVxrec(header, records) {
  const head = Buffer.from(`VXREC1\n${JSON.stringify(header)}\n`, "utf8");
  const parts = [head];
  for (const r of records) {
    const h = Buffer.alloc(5);
    h.writeUInt8(r.runIndex, 0);
    h.writeUInt16BE(r.seq, 1);
    h.writeUInt16BE(r.opus.length, 3);
    parts.push(h, Buffer.from(r.opus));
  }
  return Buffer.concat(parts);
}

async function call(path, { method = "GET", key, json, body, cookie, origin } = {}) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (json !== undefined) headers["content-type"] = "application/json";
  if (body) headers["content-type"] = "application/octet-stream";
  const res = await fetch(`${server}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, data, headers: res.headers };
}

function fail(msg, r) {
  console.error(`FAIL ${msg}${r ? ` (HTTP ${r.status}${r.data?.error ? ` ${r.data.error.code}: ${r.data.error.message}` : ""})` : ""}`);
  process.exit(1);
}

async function deviceKey() {
  if (args.key) return args.key;
  const origin = server;
  const login = await fetch(`${server}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ identity: "demo.provider@example.invalid" }),
  });
  if (login.status >= 300) fail("dev login (local dev only; or pass --key)", { status: login.status, data: null });
  const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
  const p = await call("/api/devices", { method: "POST", json: { name: "offline smoke" }, cookie, origin });
  if (p.status !== 201) fail("pair device", p);
  console.log(`paired throwaway device ${p.data.data.device.id} (remove it in Settings → Devices)`);
  return p.data.data.key;
}

const packets = loadPackets();
const key = await deviceKey();
const now = Date.now();
const from = now - 5 * 60_000;
const perRun = Math.ceil(packets.length / runCount);
const runs = [];
const records = [];
for (let r = 0; r < runCount; r++) {
  const slice = packets.slice(r * perRun, (r + 1) * perRun);
  if (!slice.length) break;
  runs.push({ runIndex: r, audioStartMs: from + 2000 + r * 60_000 });
  slice.forEach((opus, i) => records.push({ runIndex: r, seq: (65500 + i) % 65536, opus })); // seq wraps in each run
}
const recordedTo = new Date(from + 2000 + (runs.length - 1) * 60_000 + perRun * 20 + 3000).toISOString();
const localId = `smoke-${now.toString(36)}`;
const header = {
  version: 1,
  bandNumber: 7,
  audioRuns: runs,
  recordedFrom: new Date(from).toISOString(),
  recordedTo,
  clientRef,
  localId,
  appVersion: "offline-upload-smoke",
};
const file = buildVxrec(header, records);

const create = await call("/api/device/offline-visits", {
  method: "POST",
  key,
  json: { localId, clientRef, bandNumber: 7, recordedFrom: header.recordedFrom, recordedTo, consentConfirmedAt: new Date(from - 10_000).toISOString() },
});
if (create.status !== 201) fail("create offline visit", create);
const { visit, uploadUrl, statusUrl } = create.data.data;
console.log(`visit ${visit.id} transcriber=${visit.transcriber} status=${create.data.data.status}`);
const again = await call("/api/device/offline-visits", {
  method: "POST",
  key,
  json: { localId, clientRef, bandNumber: 7, recordedFrom: header.recordedFrom, recordedTo, consentConfirmedAt: new Date(from - 10_000).toISOString() },
});
if (again.status !== 200 || again.data.data.visit.id !== visit.id) fail("idempotent create", again);

const up = await call(new URL(uploadUrl).pathname, { method: "PUT", key, body: file });
if (up.status !== 202) fail("upload", up);
console.log(`uploaded ${file.length} bytes, ${records.length} packets in ${runs.length} run(s) → ${up.data.data.status}`);

const started = Date.now();
let st;
for (;;) {
  st = await call(new URL(statusUrl).pathname, { key });
  if (st.status !== 200) fail("status", st);
  const s = st.data.data;
  if (s.status === "needs_review" || s.status === "failed") break;
  if (Date.now() - started > 180_000) fail(`timed out in status ${s.status}`);
  await new Promise((r) => setTimeout(r, 1500));
}
const s = st.data.data;
console.log(`status=${s.status} segments=${s.segmentCount} session=${s.sessionId} canDeleteLocalFile=${s.canDeleteLocalFile} after ${Math.round((Date.now() - started) / 100) / 10}s`);
if (s.status === "failed") fail(`job failed: ${s.error?.code} ${s.error?.message}`);
const det = await call(`/api/device/visits/${visit.id}`, { key });
for (const seg of det.data.data.segments) {
  const off = (iso) => ((Date.parse(iso) - from) / 1000).toFixed(2);
  console.log(`  #${seg.index} +${off(seg.observedFrom)}s..+${off(seg.observedTo)}s ${seg.speaker ?? "-"} ${seg.sourceMode} (${seg.text.length} chars)`);
}
console.log(`packets=${det.data.data.visit.packets} lost=${det.data.data.visit.lostPackets}; runs start at +2.00s${runs.length > 1 ? " and +62.00s…" : ""} (recordedFrom = +0)`);
console.log("OK");
