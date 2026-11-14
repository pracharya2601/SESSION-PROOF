/**
 * Paired devices: pairing (key shown once), list/revoke from the web (cookie), and the
 * device-key API (/api/device/*) for a phone: me, clients, start/stop/get visits.
 * Real modules + Miniflare D1 via the v3 harness.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createVisitStore } from "../../src/band/store";
import { ORIGIN } from "../e2e/harness";

let h: V3Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function setup() {
  const hh = await createV3Harness();
  const anyH = hh as any;
  anyH.apiDeps.visits = {
    store: createVisitStore(hh.db),
    enqueueAppointment: (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt),
  };
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, cookie };
}

/** Device request: bearer key, NO cookie and NO Origin (like URLSession). */
async function dev(hh: V3Harness, path: string, key: string | null, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (key) headers["authorization"] = `Bearer ${key}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await (hh as any).app.request(
    `${ORIGIN}${path}`,
    { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) },
    hh.env,
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status as number, json, text };
}

async function pair(hh: V3Harness, cookie: string, name = "Sam's iPhone") {
  const r = await hh.req("/api/devices", { method: "POST", cookie, body: { name } });
  expect(r.status, r.text).toBe(201);
  return r.json.data as { device: any; key: string; pairingLink: string };
}

describe("paired devices (web)", () => {
  it("pairs once with a key + link; list never shows key or hash; revoke works", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const p = await pair(hh, cookie, "Sam's iPhone & co");
    expect(p.key).toMatch(/^vfad_[A-Za-z0-9_-]{43}$/);
    expect(p.device).toMatchObject({ name: "Sam's iPhone & co", providerId: "provider_demo_001", lastSeenAt: null, revokedAt: null });
    expect(p.pairingLink).toBe(`glasscam://pair?server=http://localhost:8787&key=${p.key}&name=${encodeURIComponent("Sam's iPhone & co")}`);

    const list = await hh.req("/api/devices", { cookie });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.text).not.toContain(p.key);
    expect(list.text).not.toMatch(/key|hash/i);
    expect(Object.keys(list.json.data[0]).sort()).toEqual(["createdAt", "id", "lastSeenAt", "name", "providerId", "revokedAt"]);

    // validation
    expect((await hh.req("/api/devices", { method: "POST", cookie, body: { name: "  " } })).status).toBe(400);
    expect((await hh.req("/api/devices", { method: "POST", cookie, body: { name: "x", providerId: "p" } })).status).toBe(400);

    // other provider can't see or revoke it
    const other = await hh.login("other.provider@example.invalid");
    expect((await hh.req("/api/devices", { cookie: other })).json.data).toEqual([]);
    expect((await hh.req(`/api/devices/${p.device.id}`, { method: "DELETE", cookie: other })).status).toBe(404);

    const del = await hh.req(`/api/devices/${p.device.id}`, { method: "DELETE", cookie });
    expect(del.status, del.text).toBe(200);
    expect(del.json.data).toEqual({ revoked: true });
    expect((await hh.req("/api/devices", { cookie })).json.data[0].revokedAt).toBeTruthy();
    // idempotent
    expect((await hh.req(`/api/devices/${p.device.id}`, { method: "DELETE", cookie })).status).toBe(200);
  });

  it("PUBLIC_APP_ORIGIN, else PUBLIC_STREAM_ORIGIN, goes into the link", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const env = hh.env as any;
    env.PUBLIC_STREAM_ORIGIN = "wss://field.example.com";
    expect((await pair(hh, cookie)).pairingLink.startsWith("glasscam://pair?server=https://field.example.com&key=vfad_")).toBe(true);
    env.PUBLIC_APP_ORIGIN = "http://192.168.1.20:8787";
    expect((await pair(hh, cookie)).pairingLink.startsWith("glasscam://pair?server=http://192.168.1.20:8787&key=vfad_")).toBe(true);
  });

  it("cookie routes require the cookie; cookie POSTs without Origin are still rejected", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    expect((await hh.req("/api/devices")).status).toBe(401);
    expect((await hh.req("/api/devices", { method: "POST", body: { name: "x" } })).status).toBe(401);
    expect((await hh.req("/api/devices/dev_x", { method: "DELETE" })).status).toBe(401);
    expect((await hh.req("/api/devices", { method: "POST", cookie, origin: null, body: { name: "x" } })).status).toBe(403);
    expect((await hh.req("/api/devices", { method: "POST", cookie, origin: "https://evil.example", body: { name: "x" } })).status).toBe(403);
    expect((await hh.req("/api/visits", { method: "POST", cookie, origin: null, body: { clientRef: "C-104", bandNumber: 1, transport: "ble" } })).status).toBe(403);
    // A device key does not unlock the cookie API, nor skip the origin guard outside /api/device/*.
    const p = await pair(hh, cookie);
    expect((await dev(hh, "/api/devices", p.key)).status).toBe(401);
    expect((await dev(hh, "/api/visits", p.key, { method: "POST", body: { clientRef: "C-104", bandNumber: 1, transport: "ble" } })).status).toBe(403);
    // /api/device/* POST without a bearer still hits the origin guard.
    expect((await dev(hh, "/api/device/visits", null, { method: "POST", body: {} })).status).toBe(403);
  });

  it("caps active devices at 10 (revoked ones don't count)", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const made = [];
    for (let i = 0; i < 10; i++) made.push(await pair(hh, cookie, `Phone ${i}`));
    const over = await hh.req("/api/devices", { method: "POST", cookie, body: { name: "Phone 11" } });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe("TOO_MANY_DEVICES");
    await hh.req(`/api/devices/${made[0]!.device.id}`, { method: "DELETE", cookie });
    await pair(hh, cookie, "Phone 11");
  });
});

describe("device API (bearer key)", () => {
  it("me, clients, start (server transcriber by default / device on request), get, stop", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const { key, device } = await pair(hh, cookie);

    const me = await dev(hh, "/api/device/me", key);
    expect(me.status, me.text).toBe(200);
    expect(me.json.data.device).toMatchObject({ id: device.id, name: device.name });
    expect(me.json.data.provider).toEqual({ id: "provider_demo_001", identity: "demo.provider@example.invalid" });
    expect(me.json.data.transcribers).toEqual(["simulated", "device"]);

    const clients = await dev(hh, "/api/device/clients", key);
    expect(clients.status).toBe(200);
    const refs = clients.json.data.map((c: any) => c.clientRef);
    expect(refs).toContain("C-104");
    expect(new Set(refs).size).toBe(refs.length);
    for (const c of clients.json.data) expect(Object.keys(c).sort()).toEqual(["clientRef", "displayName", "preferredName"]);

    // validation + no service plan
    expect((await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104" } })).status).toBe(400);
    expect((await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104", bandNumber: 1, transport: "ble", providerId: "x" } })).status).toBe(400);
    const none = await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "NOPE-1", bandNumber: 1, transport: "ble" } });
    expect(none.status).toBe(422);
    expect(none.json.error.code).toBe("NO_SERVICE_PLAN");

    // default: server transcriber (simulated locally without a Deepgram key)
    const s1 = await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104", bandNumber: 7, transport: "ble" } });
    expect(s1.status, s1.text).toBe(201);
    expect(s1.json.data.visit).toMatchObject({ clientRef: "C-104", transcriber: "simulated", status: "recording", bandNumber: 7 });
    expect(s1.json.data.streamUrl).toMatch(/^ws:\/\/localhost:8787\/api\/visits\/visit_[0-9a-f]+\/stream\?token=/);

    // explicit device transcriber
    const s2 = await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104", bandNumber: null, transport: "ble", transcriber: "device" } });
    expect(s2.status, s2.text).toBe(201);
    expect(s2.json.data.visit.transcriber).toBe("device");
    const v = s2.json.data.visit;

    const got = await dev(hh, `/api/device/visits/${v.id}`, key);
    expect(got.status).toBe(200);
    expect(got.json.data).toMatchObject({ visit: { id: v.id, status: "recording" }, segments: [] });

    const stop = await dev(hh, `/api/device/visits/${v.id}/stop`, key, { method: "POST" });
    expect(stop.status, stop.text).toBe(200);
    expect(stop.json.data.visit).toMatchObject({ id: v.id, status: "stopped" });
    const sid = stop.json.data.sessionId;
    expect(sid).toBeTruthy();
    expect((await dev(hh, `/api/device/visits/${v.id}/stop`, key, { method: "POST" })).json.data.sessionId).toBe(sid);
    // the web sees the same visit
    expect((await hh.req(`/api/visits/${v.id}`, { cookie })).json.data.visit.sessionId).toBe(sid);
    await hh.settle();
  });

  it("POST /api/visits (cookie) honours transcriber: device", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const r = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: 1, transport: "ble", transcriber: "device" } });
    expect(r.status, r.text).toBe(201);
    expect(r.json.data.visit.transcriber).toBe("device");
    const plain = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: 1, transport: "ble" } });
    expect(plain.json.data.visit.transcriber).toBe("simulated");
  });

  it("deployed without Deepgram: server default is 503, device transcriber still works", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const { key } = await pair(hh, cookie);
    (hh.env as any).RUNTIME_MODE = "deployed";
    expect((await dev(hh, "/api/device/me", key)).json.data.transcribers).toEqual(["device"]);
    const s = await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104", bandNumber: 1, transport: "ble" } });
    expect(s.status).toBe(503);
    expect(s.json.error.code).toBe("TRANSCRIPTION_NOT_CONFIGURED");
    const d = await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104", bandNumber: 1, transport: "ble", transcriber: "device" } });
    expect(d.status, d.text).toBe(201);
    expect(d.json.data.visit.transcriber).toBe("device");
  });

  it("missing, wrong or revoked key is 401; another provider's visit is 404", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const { key, device } = await pair(hh, cookie);
    expect((await dev(hh, "/api/device/me", null)).status).toBe(401);
    expect((await dev(hh, "/api/device/me", "vfad_" + "A".repeat(43))).status).toBe(401);
    expect((await dev(hh, "/api/device/me", "vfad_short")).status).toBe(401);
    expect((await dev(hh, "/api/device/me", null, { headers: { authorization: `Basic ${key}` } })).status).toBe(401);
    // a cookie is not enough on the device API
    expect((await hh.req("/api/device/me", { cookie })).status).toBe(401);

    // other provider's device can't see this provider's visit
    const mine = await dev(hh, "/api/device/visits", key, { method: "POST", body: { clientRef: "C-104", bandNumber: 1, transport: "ble" } });
    const visitId = mine.json.data.visit.id;
    const otherCookie = await hh.login("other.provider@example.invalid");
    const other = await pair(hh, otherCookie, "Other phone");
    expect((await dev(hh, `/api/device/visits/${visitId}`, other.key)).status).toBe(404);
    expect((await dev(hh, `/api/device/visits/${visitId}/stop`, other.key, { method: "POST" })).status).toBe(404);
    const otherClients = (await dev(hh, "/api/device/clients", other.key)).json.data.map((c: any) => c.clientRef);
    expect(otherClients).not.toContain("C-104");
    expect((await hh.req(`/api/visits/${visitId}`, { cookie })).json.data.visit.status).toBe("recording");

    // revoke → 401 DEVICE_REVOKED immediately
    await hh.req(`/api/devices/${device.id}`, { method: "DELETE", cookie });
    const after = await dev(hh, "/api/device/me", key);
    expect(after.status).toBe(401);
    expect(after.json.error.code).toBe("DEVICE_REVOKED");
    expect((await dev(hh, `/api/device/visits/${visitId}/stop`, key, { method: "POST" })).status).toBe(401);
  });

  it("updates last_seen_at at most once a minute", async () => {
    const { hh, cookie } = await setup();
    h = hh;
    const { key } = await pair(hh, cookie);
    const seen = async () => (await hh.req("/api/devices", { cookie })).json.data[0].lastSeenAt as string | null;
    expect(await seen()).toBeNull();
    await dev(hh, "/api/device/me", key);
    const first = await seen();
    expect(first).toBe(hh.clock.now().toISOString());
    hh.clock.advance(30_000);
    await dev(hh, "/api/device/me", key);
    expect(await seen()).toBe(first);
    hh.clock.advance(31_000);
    await dev(hh, "/api/device/me", key);
    expect(await seen()).toBe(hh.clock.now().toISOString());
  });
});
