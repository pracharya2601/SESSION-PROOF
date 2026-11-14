#!/usr/bin/env -S node --experimental-websocket
// End-to-end smoke test of a band visit against the DEPLOYED Worker, through the paired-device
// API only (no cookie, no Access session), with REAL band-format Opus packets so Deepgram returns
// real text.
//
//   DEVICE_KEY=vfad_… BASE_URL=https://field-assist.example.com \
//     node --experimental-websocket scripts/band/deployed-smoke.mjs [packets.bin] [clientRef]
//
// packets.bin: concatenated [u16 little-endian length][Opus packet] records (20 ms each), e.g. from
// demuxing an Ogg Opus file. The key is read from the environment only (never argv: shell history,
// ps). It is never printed. Optional RESOLVE=host:ip pins DNS (like curl --resolve).
//
// Checks, in order: /api/health JSON; unauthenticated /api/sessions is 401/503 (never 200);
// a forged Cf-Access-Authenticated-User-Email is rejected; device me + clients; start a visit;
// stream audio over wss with the visit token; stop via the device API; poll the device visit
// until it has a session; optional /api/device/inbox. Exit 0 only when all pass.
import dns from "node:dns";
import { readFileSync } from "node:fs";

const KEY = process.env.DEVICE_KEY ?? "";
const BASE = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const PACKETS = process.argv[2];
const CLIENT = process.argv[3] ?? "C-104";
if (!/^vfad_[A-Za-z0-9_-]{43}$/.test(KEY)) throw new Error("Set DEVICE_KEY=vfad_… (env only)");
if (!/^https:\/\//.test(BASE)) throw new Error("Set BASE_URL=https://<host>");
if (!PACKETS) throw new Error("usage: deployed-smoke.mjs <packets.bin> [clientRef]");

if (process.env.RESOLVE) {
  const [rhost, rip] = process.env.RESOLVE.split(":");
  const orig = dns.lookup;
  dns.lookup = (host, opts, cb) => {
    if (typeof opts === "function") [cb, opts] = [opts, {}];
    if (host !== rhost) return orig(host, opts, cb);
    return opts?.all ? cb(null, [{ address: rip, family: 4 }]) : cb(null, rip, 4);
  };
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
const auth = { Authorization: `Bearer ${KEY}` };
async function dev(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j?.error?.code ?? ""}`);
  return j.data;
}

// 1. edges
{
  const r = await fetch(`${BASE}/api/health`);
  const j = await r.json().catch(() => null);
  check("health JSON", r.status === 200 && j?.data?.ok === true, `${r.status} runtime=${j?.data?.runtimeMode} auth=${j?.data?.authMode}`);
  const s = await fetch(`${BASE}/api/sessions`, { redirect: "manual" });
  check("unauthenticated /api/sessions refused", [401, 302, 403, 503].includes(s.status), String(s.status));
  const f = await fetch(`${BASE}/api/visits/visit_x/status`, {
    headers: { "Cf-Access-Authenticated-User-Email": process.env.FORGE_EMAIL || "provider@example.com" },
    redirect: "manual",
  });
  check("forged Access email header rejected", f.status !== 404 && f.status !== 200, String(f.status));
  const p = await fetch(`${BASE}/api/device/..%2fsessions`, { headers: auth, redirect: "manual" });
  check("encoded dot-segment path rejected", p.status === 400 || p.status === 404, String(p.status));
}

// 2. device API
const me = await dev("GET", "/api/device/me");
check("device me", !!me?.device?.id, `transcribers=${me.transcribers.join(",")}`);
const clients = await dev("GET", "/api/device/clients");
check("device clients", clients.some((c) => c.clientRef === CLIENT), `${clients.length} client(s), ${CLIENT} present`);

// 3. band visit with real audio
const buf = readFileSync(PACKETS);
const packets = [];
for (let i = 0; i + 2 <= buf.length; ) {
  const n = buf.readUInt16LE(i);
  i += 2;
  packets.push(buf.subarray(i, i + n));
  i += n;
}
const start = await dev("POST", "/api/device/visits", { clientRef: CLIENT, bandNumber: null, transport: "sim" });
check("start visit", start.visit.status === "recording" && start.streamUrl.startsWith("wss://"), `transcriber=${start.visit.transcriber}`);

const finals = [];
const ws = new WebSocket(start.streamUrl);
ws.binaryType = "arraybuffer";
const done = new Promise((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "final") finals.push(m.segment.text);
    if (m.type === "ready") console.log(`      ready (${m.transcriber})`);
    if (m.type === "error") console.log(`      stream error ${m.code}`);
    if (m.type === "done") resolve(m);
  };
  ws.onclose = (e) => resolve({ closed: e.code });
});
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = () => j(new Error("could not open the stream"));
});
await new Promise((r) => setTimeout(r, 800));
ws.send(JSON.stringify({ type: "start", audioStartMs: Date.now() }));
for (let s = 0; s < packets.length; s++) {
  const b = new Uint8Array(2 + packets[s].length);
  b[0] = (s >> 8) & 0xff;
  b[1] = s & 0xff;
  b.set(packets[s], 2);
  ws.send(b);
  if (s % 5 === 4) await new Promise((r) => setTimeout(r, 100)); // ~real time (5 × 20 ms)
}
ws.send(JSON.stringify({ type: "stop" }));
const end = await Promise.race([done, new Promise((r) => setTimeout(() => r({ timeout: true }), 30_000))]);
const words = finals.join(" ").trim().split(/\s+/).filter(Boolean).length;
// Transcript text is printed as a word count only (it would be PII with real audio).
check("Deepgram returned text", words > 0, `${finals.length} final segment(s), ${words} words; end=${JSON.stringify(end)}`);

const stop = await dev("POST", `/api/device/visits/${start.visit.id}/stop`);
check("stop via device API", !!stop.sessionId && stop.visit.status === "stopped", `segments=${stop.visit.segmentCount} packets=${stop.visit.packets} lost=${stop.visit.lostPackets}`);

// 4. processing (queue + workflow): the device can't read /api/sessions (Access); poll the visit.
let detail;
for (let i = 0; i < 20; i++) {
  detail = await dev("GET", `/api/device/visits/${start.visit.id}`);
  if (detail.visit.sessionId) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check("visit has a session", !!detail?.visit?.sessionId, `segments stored=${detail?.segments?.length ?? 0}`);
const inbox = await fetch(`${BASE}/api/device/inbox`, { headers: auth });
if (inbox.status === 200) {
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    const j = await (await fetch(`${BASE}/api/device/inbox`, { headers: auth })).json();
    found = JSON.stringify(j.data ?? "").includes(stop.sessionId);
    if (!found) await new Promise((r) => setTimeout(r, 2000));
  }
  check("session reached the review inbox", found);
} else {
  console.log(`INFO  /api/device/inbox → ${inbox.status}; check the session status with:`);
  console.log(`      npx wrangler d1 execute vexo-field-assistant --remote --env production --command "SELECT status FROM sessions WHERE id = '${stop.sessionId}'"`);
}
console.log(`\nsession ${stop.sessionId}`);
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
