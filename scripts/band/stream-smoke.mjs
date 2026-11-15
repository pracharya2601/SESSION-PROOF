#!/usr/bin/env -S node --experimental-websocket
// Black-box smoke test of a band visit against a running dev server, with fake audio
// packets (no band needed). Uses the stream token, like the GlassCam bridge would: in the
// `vfa-token.<token>` WebSocket subprotocol (never the URL) and as a Bearer header on stop.
// `--first-message` sends it as the first `auth` message instead (the fallback).
// Usage (Node 20 needs the flag; 22+ does not): node --experimental-websocket scripts/band/stream-smoke.mjs [baseUrl] [seconds]
const firstMessage = process.argv.includes("--first-message");
const args = process.argv.slice(2).filter((a) => a !== "--first-message");
const base = args[0] ?? "http://localhost:8787";
const seconds = Number(args[1] ?? 8);
const origin = new URL(base).origin;

const login = await fetch(`${base}/auth/dev-login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ identity: "demo.provider@example.invalid" }),
});
if (!login.ok) throw new Error(`dev-login ${login.status}`);
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const call = async (method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j.error)}`);
  return j.data;
};

console.log("capture:", await call("GET", "/api/visits/capture-status"));
const start = await call("POST", "/api/visits", { clientRef: "C-104", bandNumber: null, transport: "sim" });
console.log("visit:", start.visit.id, "transcriber:", start.visit.transcriber);

// Token auth, no cookie; the URL carries no token. Never log the token.
const ws = firstMessage ? new WebSocket(start.streamUrl) : new WebSocket(start.streamUrl, ["vfa-stream", `vfa-token.${start.streamToken}`]);
ws.binaryType = "arraybuffer";
const done = new Promise((resolve, reject) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "final") console.log(`  final #${m.segment.index} [${m.segment.speaker}] ${m.segment.text}`);
    else if (m.type !== "interim") console.log("  ", m);
    if (m.type === "done") resolve(m);
    if (m.type === "error" && m.code !== "no_start") reject(new Error(m.message));
  };
  ws.onclose = (e) => resolve({ closed: e.code });
  ws.onerror = () => reject(new Error("socket error"));
});
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("could not open the stream")); });
console.log("protocol:", JSON.stringify(ws.protocol), firstMessage ? "(first-message auth)" : "(subprotocol auth)");
if (firstMessage) ws.send(JSON.stringify({ type: "auth", token: start.streamToken }));
await new Promise((r) => setTimeout(r, 300)); // wait for "ready"
ws.send(JSON.stringify({ type: "start", audioStartMs: Date.now() }));
const packets = seconds * 50;
for (let seq = 0; seq < packets; seq++) {
  const b = new Uint8Array(42);
  b[0] = (seq >> 8) & 0xff; b[1] = seq & 0xff; b.fill(0xab, 2);
  ws.send(b);
  if (seq % 50 === 49) await new Promise((r) => setTimeout(r, 20));
}
ws.send(JSON.stringify({ type: "stop" }));
console.log("done:", await done);
// Stop like the phone: Bearer stream token (no cookie), Origin for the origin guard.
const stopRes = await fetch(`${base}/api/visits/${start.visit.id}/stop`, {
  method: "POST",
  headers: { authorization: `Bearer ${start.streamToken}`, origin, "content-type": "application/json" },
  body: "{}",
});
const stopJson = await stopRes.json();
if (!stopRes.ok) throw new Error(`stop ${stopRes.status} ${JSON.stringify(stopJson.error)}`);
const stop = stopJson.data;
console.log("stopped:", { session: stop.sessionId, segments: stop.visit.segmentCount, packets: stop.visit.packets, lost: stop.visit.lostPackets });
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const d = await call("GET", `/api/sessions/${stop.sessionId}`);
  if (!["QUEUED", "PROCESSING", "WAITING_FOR_EVIDENCE", "SCHEDULED"].includes(d.session.status)) {
    console.log("session:", d.session.status, "evidence:", d.bundle?.evidence.length, "mode:", d.bundle?.provenance.evidenceMode);
    process.exit(d.session.status === "NEEDS_REVIEW" ? 0 : 1);
  }
}
console.log("session did not finish processing in 30 s");
process.exit(1);
