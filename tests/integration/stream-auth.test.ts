/**
 * Stream auth without a token in the URL (docs/deploy.md §13, docs/band-bridge.md §1).
 * Cloudflare logs full request URLs, so the stream URL carries no token. A client authenticates
 * with `Sec-WebSocket-Protocol: vfa-stream, vfa-token.<token>` (the 101 echoes `vfa-stream`), or
 * with a first message {"type":"auth","token":"…"} within the deadline; anything else → 1008.
 * `?token=` (stream, stop, status) still works for one release and is counted in the logs.
 * stop/status take `Authorization: Bearer <token>`.
 *
 * Node has no WebSocketPair and refuses `status: 101`, so both are faked here: the route runs
 * for real (Hono + Miniflare D1 + CaptureSession + simulated transcriber) and the test drives
 * the server end of the socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { ORIGIN } from "../e2e/harness";
import { createVisitStore } from "../../src/band/store";
import { createRecordingStore } from "../../src/recordings";
import { DemoCalendarSource } from "../../src/schedule";
import { legacyQueryTokenCount } from "../../src/api/visits";

// ------------------------------------------------------------------ fake socket + 101 response
class FakeSocket extends EventTarget {
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  accept() {}
  send(d: unknown) {
    if (this.closed) throw new Error("closed");
    this.sent.push(d);
  }
  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.dispatchEvent(new Event("close"));
  }
  /** A message from the client. */
  deliver(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  messages(): Array<{ type: string; [k: string]: unknown }> {
    return this.sent.map((s) => JSON.parse(String(s)));
  }
}
const servers: FakeSocket[] = [];
class FakePair {
  0 = new FakeSocket();
  1 = new FakeSocket();
  constructor() {
    servers.push(this[1]);
  }
}
const RealResponse = globalThis.Response;
class UpgradeResponse extends RealResponse {
  private readonly upgraded: boolean;
  override readonly webSocket: WebSocket | null;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    const up = init?.status === 101;
    super(body, up ? { status: 200, headers: init?.headers } : init);
    this.upgraded = up;
    this.webSocket = (init?.webSocket as WebSocket | undefined) ?? null;
  }
  override get status() {
    return this.upgraded ? 101 : super.status;
  }
}

let h: V3Harness | null = null;
let logs: string[] = [];
beforeEach(() => {
  servers.length = 0;
  logs = [];
  vi.stubGlobal("WebSocketPair", FakePair);
  vi.stubGlobal("Response", UpgradeResponse);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await h?.dispose();
  h = null;
});

async function setup(o: { authTimeoutMs?: number } = {}) {
  const hh = await createV3Harness();
  const anyH = hh as any;
  anyH.apiDeps.visits = {
    store: createVisitStore(hh.db),
    enqueueAppointment: (appt: any) => hh.mods.jobs.enqueueAppointment(hh.jobs, appt),
    streamAuthTimeoutMs: o.authTimeoutMs,
  };
  anyH.apiDeps.recordings = {
    store: createRecordingStore(hh.db),
    calendar: new DemoCalendarSource({ clock: hh.clock }),
    streamAuthTimeoutMs: o.authTimeoutMs,
  };
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  h = hh;
  return { hh, cookie };
}

async function raw(hh: V3Harness, path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res: Response = await (hh as any).app.request(
    `${ORIGIN}${path}`,
    { method: o.method ?? "GET", headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined },
    hh.env,
  );
  return res;
}

async function startVisit(hh: V3Harness, cookie: string) {
  const r = await hh.req("/api/visits", { method: "POST", cookie, body: { clientRef: "C-104", bandNumber: 7, transport: "ble" } });
  expect(r.status, r.text).toBe(201);
  return r.json.data as { visit: { id: string }; streamUrl: string; streamToken: string; streamTokenExpiresAt: string };
}

const WS = { upgrade: "websocket" };
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const hasType = (s: FakeSocket, type: string) => s.messages().some((m) => m.type === type);
function packet(seq: number): ArrayBuffer {
  const b = new Uint8Array(42);
  b[0] = (seq >> 8) & 0xff;
  b[1] = seq & 0xff;
  b.fill(0xab, 2);
  return b.buffer;
}

/** start → 50 packets → stop → done. */
async function streamOneSecond(s: FakeSocket, hh: V3Harness) {
  await until(() => hasType(s, "ready"));
  s.deliver(JSON.stringify({ type: "start", audioStartMs: hh.clock.now().getTime() }));
  for (let i = 0; i < 50; i++) s.deliver(packet(i));
  s.deliver(JSON.stringify({ type: "stop" }));
  await until(() => hasType(s, "done"));
  await until(() => s.closed !== null);
  expect(s.closed?.code).toBe(1000);
}

function expectNoTokenInLogs(...tokens: string[]) {
  const all = logs.join("\n");
  for (const t of tokens) {
    expect(all).not.toContain(t);
    expect(all).not.toContain(encodeURIComponent(t));
  }
}

describe("stream URL and token", () => {
  it("POST /api/visits returns a token-less streamUrl and a separate streamToken", async () => {
    const { hh, cookie } = await setup();
    const s = await startVisit(hh, cookie);
    expect(s.streamUrl).toBe(`ws://localhost:8787/api/visits/${s.visit.id}/stream`);
    expect(new URL(s.streamUrl).search).toBe("");
    expect(s.streamToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // valid subprotocol token chars
    expectNoTokenInLogs(s.streamToken);
  });
});

describe("visit stream auth", () => {
  it("subprotocol: token-less URL + `vfa-stream, vfa-token.<t>` → 101 echoing vfa-stream, then streams", async () => {
    const { hh, cookie } = await setup();
    const s = await startVisit(hh, cookie);
    const res = await raw(hh, new URL(s.streamUrl).pathname, { headers: { ...WS, "sec-websocket-protocol": `vfa-stream, vfa-token.${s.streamToken}` } });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("vfa-stream");
    const sock = servers.at(-1)!;
    await streamOneSecond(sock, hh);
    const v = (await hh.req(`/api/visits/${s.visit.id}`, { cookie })).json.data.visit;
    expect(v.packets).toBe(50);
    expect(legacyQueryTokenCount("visits.stream")).toBe(0);
    expectNoTokenInLogs(s.streamToken);
  });

  it("first message: {type:auth} → ready (nothing is sent before auth)", async () => {
    const { hh, cookie } = await setup();
    const s = await startVisit(hh, cookie);
    const res = await raw(hh, new URL(s.streamUrl).pathname, { headers: { ...WS, "sec-websocket-protocol": "vfa-stream" } });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("vfa-stream");
    const sock = servers.at(-1)!;
    await new Promise((r) => setTimeout(r, 30));
    expect(sock.sent).toEqual([]); // no "ready" until authenticated
    sock.deliver(JSON.stringify({ type: "auth", token: s.streamToken }));
    await streamOneSecond(sock, hh);
    // Without any Sec-WebSocket-Protocol: no echo, same flow.
    const s2 = await startVisit(hh, cookie);
    const res2 = await raw(hh, new URL(s2.streamUrl).pathname, { headers: WS });
    expect(res2.status).toBe(101);
    expect(res2.headers.get("sec-websocket-protocol")).toBeNull();
    servers.at(-1)!.deliver(JSON.stringify({ type: "auth", token: s2.streamToken }));
    await until(() => hasType(servers.at(-1)!, "ready"));
    expectNoTokenInLogs(s.streamToken, s2.streamToken);
  });

  it("missing, wrong, foreign or late auth → close 1008; a bad header token is 401 before the upgrade", async () => {
    const { hh, cookie } = await setup({ authTimeoutMs: 60 });
    const s = await startVisit(hh, cookie);
    const other = await startVisit(hh, cookie);
    const path = new URL(s.streamUrl).pathname;
    const open = async () => {
      expect((await raw(hh, path, { headers: WS })).status).toBe(101);
      return servers.at(-1)!;
    };
    // something other than auth first
    let sock = await open();
    sock.deliver(JSON.stringify({ type: "start", audioStartMs: 1 }));
    await until(() => sock.closed !== null);
    expect(sock.closed).toEqual({ code: 1008, reason: "auth required" });
    expect(hasType(sock, "ready")).toBe(false);
    // binary first
    sock = await open();
    sock.deliver(packet(0));
    await until(() => sock.closed !== null);
    expect(sock.closed?.code).toBe(1008);
    // invalid token / another visit's token
    for (const token of ["nope", other.streamToken]) {
      sock = await open();
      sock.deliver(JSON.stringify({ type: "auth", token }));
      await until(() => sock.closed !== null);
      expect(sock.closed).toEqual({ code: 1008, reason: "unauthorized" });
    }
    // nothing within the deadline; a late auth does not revive it
    sock = await open();
    await until(() => sock.closed !== null, 2000);
    expect(sock.closed).toEqual({ code: 1008, reason: "auth timeout" });
    sock.deliver(JSON.stringify({ type: "auth", token: s.streamToken }));
    await new Promise((r) => setTimeout(r, 30));
    expect(hasType(sock, "ready")).toBe(false);
    // a bad token in the subprotocol header is refused before the upgrade
    expect((await raw(hh, path, { headers: { ...WS, "sec-websocket-protocol": "vfa-stream, vfa-token.nope" } })).status).toBe(401);
    expect((await raw(hh, path, { headers: { ...WS, "sec-websocket-protocol": `vfa-stream, vfa-token.${other.streamToken}` } })).status).toBe(401);
    // a stopped visit: auth succeeds, then error + 1008
    await raw(hh, `/api/visits/${s.visit.id}/stop`, { method: "POST", headers: { authorization: `Bearer ${s.streamToken}`, origin: ORIGIN } });
    sock = await open();
    sock.deliver(JSON.stringify({ type: "auth", token: s.streamToken }));
    await until(() => sock.closed !== null);
    expect(sock.closed?.code).toBe(1008);
    expect(sock.messages()).toEqual([{ type: "error", code: "visit_stopped", message: "This visit has already been stopped." }]);
    // header auth on a stopped visit: plain 409
    expect((await raw(hh, path, { headers: { ...WS, "sec-websocket-protocol": `vfa-stream, vfa-token.${s.streamToken}` } })).status).toBe(409);
    // a cross-site page is still refused outright
    expect((await raw(hh, path, { headers: { ...WS, origin: "https://evil.example" } })).status).toBe(403);
    expectNoTokenInLogs(s.streamToken, other.streamToken);
  });

  it("deprecated ?token= still works and is counted in the logs without the token", async () => {
    const { hh, cookie } = await setup();
    const s = await startVisit(hh, cookie);
    const before = legacyQueryTokenCount("visits.stream");
    const res = await raw(hh, `${new URL(s.streamUrl).pathname}?token=${encodeURIComponent(s.streamToken)}`, { headers: WS });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBeNull();
    await streamOneSecond(servers.at(-1)!, hh);
    expect(legacyQueryTokenCount("visits.stream")).toBe(before + 1);
    const line = logs.find((l) => l.includes('"stream.legacy_query_token"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ event: "stream.legacy_query_token", route: "visits.stream", uses: before + 1 });
    expectNoTokenInLogs(s.streamToken);
  });

  it("the browser cookie path still works (same Origin, no token)", async () => {
    const { hh, cookie } = await setup();
    const s = await startVisit(hh, cookie);
    const res = await raw(hh, new URL(s.streamUrl).pathname, { headers: { ...WS, cookie, origin: ORIGIN } });
    expect(res.status).toBe(101);
    await streamOneSecond(servers.at(-1)!, hh);
  });
});

describe("stop / status with the stream token", () => {
  it("Authorization: Bearer works; ?token= still works (counted); a device key is not a stream token", async () => {
    const { hh, cookie } = await setup();
    const s = await startVisit(hh, cookie);
    const bearer = { authorization: `Bearer ${s.streamToken}` };
    const st = await raw(hh, `/api/visits/${s.visit.id}/status`, { headers: bearer });
    expect(st.status).toBe(200);
    expect(((await st.json()) as any).data.visit.status).toBe("recording");
    expect((await raw(hh, `/api/visits/${s.visit.id}/status`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    // device-key shaped bearer → not a stream token → cookie route → 401 without a cookie
    expect((await raw(hh, `/api/visits/${s.visit.id}/status`, { headers: { authorization: "Bearer vfad_x" } })).status).toBe(401);

    const before = legacyQueryTokenCount("visits.status");
    expect((await raw(hh, `/api/visits/${s.visit.id}/status?token=${encodeURIComponent(s.streamToken)}`)).status).toBe(200);
    expect(legacyQueryTokenCount("visits.status")).toBe(before + 1);

    // POST still needs Origin (global origin guard)
    expect((await raw(hh, `/api/visits/${s.visit.id}/stop`, { method: "POST", headers: bearer, body: {} })).status).toBe(403);
    const stop = await raw(hh, `/api/visits/${s.visit.id}/stop`, { method: "POST", headers: { ...bearer, origin: ORIGIN }, body: {} });
    expect(stop.status).toBe(200);
    const sessionId = ((await stop.json()) as any).data.sessionId;
    expect(sessionId).toBeTruthy();
    const again = await raw(hh, `/api/visits/${s.visit.id}/stop?token=${encodeURIComponent(s.streamToken)}`, { method: "POST", headers: { origin: ORIGIN }, body: {} });
    expect(((await again.json()) as any).data.sessionId).toBe(sessionId);
    expectNoTokenInLogs(s.streamToken);
    await hh.settle();
  });
});

describe("recording stream auth", () => {
  async function startRecording(hh: V3Harness, cookie: string) {
    const p = await hh.req("/api/devices", { method: "POST", cookie, body: { name: "Field phone" } });
    expect(p.status, p.text).toBe(201);
    const key: string = p.json.data.key;
    const r = await raw(hh, "/api/device/recordings", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: { bandNumber: 7, transport: "ble" } });
    expect(r.status).toBe(201);
    const data = ((await r.json()) as any).data;
    return { key, id: data.recording.id as string, streamUrl: data.streamUrl as string, streamToken: data.streamToken as string };
  }

  it("token-less URL; subprotocol, first message, and ?token= all work; missing auth → 1008", async () => {
    const { hh, cookie } = await setup({ authTimeoutMs: 60 });
    const rec = await startRecording(hh, cookie);
    expect(rec.streamUrl).toBe(`ws://localhost:8787/api/recordings/${rec.id}/stream`);
    const path = new URL(rec.streamUrl).pathname;

    const a = await raw(hh, path, { headers: { ...WS, "sec-websocket-protocol": `vfa-stream, vfa-token.${rec.streamToken}` } });
    expect(a.status).toBe(101);
    expect(a.headers.get("sec-websocket-protocol")).toBe("vfa-stream");
    await until(() => hasType(servers.at(-1)!, "ready"));
    servers.at(-1)!.close(1000, "bye");

    expect((await raw(hh, path, { headers: WS })).status).toBe(101);
    servers.at(-1)!.deliver(JSON.stringify({ type: "auth", token: rec.streamToken }));
    await until(() => hasType(servers.at(-1)!, "ready"));
    servers.at(-1)!.close(1000, "bye");

    expect((await raw(hh, path, { headers: WS })).status).toBe(101);
    const late = servers.at(-1)!;
    await until(() => late.closed !== null, 2000);
    expect(late.closed?.code).toBe(1008);

    const before = legacyQueryTokenCount("recordings.stream");
    expect((await raw(hh, `${path}?token=${encodeURIComponent(rec.streamToken)}`, { headers: WS })).status).toBe(101);
    expect(legacyQueryTokenCount("recordings.stream")).toBe(before + 1);
    await until(() => hasType(servers.at(-1)!, "ready"));

    expect((await raw(hh, path, { headers: { ...WS, "sec-websocket-protocol": "vfa-stream, vfa-token.bad" } })).status).toBe(401);
    expectNoTokenInLogs(rec.streamToken, rec.key);
  });
});
