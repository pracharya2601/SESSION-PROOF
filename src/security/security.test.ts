import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiDeps, AppBindings } from "../api/deps";
import type { Env } from "../env";
import {
  SESSION_COOKIE,
  apiError,
  authRoutes,
  correlationId,
  decryptToken,
  encryptToken,
  escapeHtml,
  log,
  originGuard,
  requireActor,
  signSession,
} from "./index";

const SECRET = "x".repeat(40);
const NOW = new Date("2026-05-01T12:00:00Z");
const ORIGIN = "http://localhost:8787";
const IDENTITIES: Record<string, string> = { "provider@example.test": "prov_1" };

function makeDeps(envOver: Partial<Env> = {}): ApiDeps {
  const env = {
    AUTH_MODE: "dev",
    APP_ORIGIN: ORIGIN,
    RUNTIME_MODE: "local",
    SESSION_SECRET: SECRET,
    ...envOver,
  } as unknown as Env;
  const repo = {
    findProviderByIdentity: async (identity: string) => IDENTITIES[identity] ?? null,
  } as unknown as ApiDeps["repo"];
  return { env, repo, clock: { now: () => NOW } } as unknown as ApiDeps;
}

function makeApp(deps: ApiDeps) {
  const app = new Hono<AppBindings>();
  app.use("*", correlationId());
  app.use("*", originGuard(deps));
  app.route("/", authRoutes(deps));
  app.use("/api/protected/*", requireActor(deps));
  app.get("/api/protected/who", (c) => c.json({ data: c.get("actor") }));
  app.post("/api/protected/do", (c) => c.json({ data: c.get("actor") }));
  app.get("/err", (c) => apiError(c, 409, "CONFLICT", "nope", true, { a: 1 }));
  return app;
}

const nowSec = Math.floor(NOW.getTime() / 1000);
const cookieFor = async (exp = nowSec + 3600, providerId = "prov_1", identity = "provider@example.test") =>
  `${SESSION_COOKIE}=${await signSession({ providerId, identity, exp }, SECRET)}`;

describe("requireActor (dev mode)", () => {
  const app = makeApp(makeDeps());

  it("401 without cookie", async () => {
    const r = await app.request("/api/protected/who");
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error: { code: string; correlationId: string } };
    expect(j.error.code).toBe("UNAUTHENTICATED");
    expect(j.error.correlationId).toBe(r.headers.get("X-Correlation-Id"));
  });

  it("401 with tampered cookie", async () => {
    const good = await cookieFor();
    const [name, val] = good.split("=") as [string, string];
    const [body, sig] = val.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ providerId: "prov_2", identity: "provider@example.test", exp: nowSec + 3600 }))
      .toString("base64url");
    for (const bad of [`${name}=${forged}.${sig}`, `${name}=${body}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`, `${name}=garbage`]) {
      const r = await app.request("/api/protected/who", { headers: { Cookie: bad } });
      expect(r.status).toBe(401);
    }
  });

  it("401 with expired cookie", async () => {
    const r = await app.request("/api/protected/who", { headers: { Cookie: await cookieFor(nowSec - 1) } });
    expect(r.status).toBe(401);
  });

  it("401 when identity no longer maps to signed provider", async () => {
    const c = await cookieFor(nowSec + 3600, "prov_9");
    const r = await app.request("/api/protected/who", { headers: { Cookie: c } });
    expect(r.status).toBe(401);
  });

  it("valid cookie sets actor", async () => {
    const r = await app.request("/api/protected/who", { headers: { Cookie: await cookieFor() } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { providerId: "prov_1", identity: "provider@example.test" } });
  });

  it("503 when SESSION_SECRET missing or short", async () => {
    for (const s of [undefined, "short"]) {
      const a = makeApp(makeDeps({ SESSION_SECRET: s }));
      const r = await a.request("/api/protected/who", { headers: { Cookie: await cookieFor() } });
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("AUTH_NOT_CONFIGURED");
    }
  });
});

describe("requireActor (access mode, no Access config)", () => {
  const app = makeApp(makeDeps({ AUTH_MODE: "access" }));
  it("fails closed with 503 and never trusts the plain email header", async () => {
    const r = await app.request("/api/protected/who", {
      headers: { "Cf-Access-Authenticated-User-Email": "Provider@Example.test" },
    });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("AUTH_NOT_CONFIGURED");
  });
  it("dev-login is 404 in access mode", async () => {
    const r = await app.request("/auth/dev-login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "provider@example.test" }),
    });
    expect(r.status).toBe(404);
  });
});

describe("authRoutes", () => {
  const app = makeApp(makeDeps());
  const login = (identity: string, url = `${ORIGIN}/auth/dev-login`) =>
    app.request(url, {
      method: "POST",
      headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ identity }),
    });

  it("dev-login sets a hardened cookie usable for /api/me", async () => {
    const r = await login("provider@example.test");
    expect(r.status).toBe(200);
    const set = r.headers.get("Set-Cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=28800/);
    expect(set).not.toMatch(/Secure/);
    const cookie = set.split(";")[0]!;
    const me = await app.request("/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { data: unknown }).data).toEqual({ providerId: "prov_1", identity: "provider@example.test" });
  });

  it("dev-login sets Secure on https", async () => {
    const r = await login("provider@example.test", "https://localhost/auth/dev-login");
    expect(r.headers.get("Set-Cookie")).toMatch(/Secure/);
  });

  it("dev-login unknown identity 401", async () => {
    expect((await login("nobody@example.test")).status).toBe(401);
  });

  it("dev-login refused on non-loopback host", async () => {
    const r = await login("provider@example.test", "https://app.example.test/auth/dev-login");
    expect(r.status).toBe(404);
  });

  it("dev-login refused on deployed runtime", async () => {
    const a = makeApp(makeDeps({ RUNTIME_MODE: "deployed" }));
    const r = await a.request("/auth/dev-login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "provider@example.test" }),
    });
    expect(r.status).toBe(404);
  });

  it("logout clears cookie", async () => {
    const r = await app.request("/auth/logout", { method: "POST", headers: { Origin: ORIGIN } });
    expect(r.status).toBe(200);
    expect(r.headers.get("Set-Cookie")).toMatch(new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`));
  });

  it("/api/me 401 unauthenticated", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
  });
});

describe("originGuard", () => {
  const app = makeApp(makeDeps({ APP_ORIGIN: "https://app.example.test" }));
  it("403 for bad or missing Origin on unsafe methods", async () => {
    for (const headers of [{ Origin: "https://evil.test" }, {} as Record<string, string>, { Origin: "null" }]) {
      const r = await app.request("http://localhost/api/protected/do", { method: "POST", headers });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("ORIGIN_REJECTED");
    }
  });
  it("same-origin and APP_ORIGIN pass; GET not checked", async () => {
    const c = await cookieFor();
    const r1 = await app.request("http://localhost/api/protected/do", { method: "POST", headers: { Origin: "http://localhost", Cookie: c } });
    expect(r1.status).toBe(200);
    const r2 = await app.request("http://localhost/api/protected/do", {
      method: "POST",
      headers: { Origin: "https://app.example.test", Cookie: c },
    });
    expect(r2.status).toBe(200);
    const r3 = await app.request("http://localhost/api/protected/who", { headers: { Origin: "https://evil.test", Cookie: c } });
    expect(r3.status).toBe(200);
  });
});

describe("apiError", () => {
  it("includes details and correlationId", async () => {
    const r = await makeApp(makeDeps()).request("/err");
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: Record<string, unknown> };
    expect(j.error).toMatchObject({ code: "CONFLICT", message: "nope", retryable: true, details: { a: 1 } });
    expect(typeof j.error.correlationId).toBe("string");
  });
});

describe("token encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const key2 = Buffer.alloc(32, 8).toString("base64");
  it("roundtrips with v1 prefix and random IV", async () => {
    const a = await encryptToken("refresh-token-123", key);
    const b = await encryptToken("refresh-token-123", key);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh");
    expect(await decryptToken(a, key)).toBe("refresh-token-123");
  });
  it("tamper fails", async () => {
    const a = await encryptToken("secret", key);
    const bytes = Buffer.from(a.slice(3), "base64url");
    bytes[20] = bytes[20]! ^ 0x01;
    await expect(decryptToken("v1." + bytes.toString("base64url"), key)).rejects.toThrow();
    await expect(decryptToken("v2." + a.slice(3), key)).rejects.toThrow();
  });
  it("wrong key fails; bad key length rejected", async () => {
    const a = await encryptToken("secret", key);
    await expect(decryptToken(a, key2)).rejects.toThrow();
    await expect(encryptToken("x", Buffer.alloc(16).toString("base64"))).rejects.toThrow(/32 bytes/);
  });
});

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());
  it("redacts sensitive keys recursively", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", "evt", {
      sessionId: "s1",
      accessToken: "AAA",
      nested: { Authorization: "Bearer x", list: [{ transcriptText: "hi", ok: 1 }], prompt: "p" },
      excerpt: "e",
      content: "c",
    });
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: "info", event: "evt", sessionId: "s1" });
    expect(line.accessToken).toBe("[REDACTED]");
    expect(line.nested.Authorization).toBe("[REDACTED]");
    expect(line.nested.prompt).toBe("[REDACTED]");
    expect(line.nested.list[0]).toEqual({ transcriptText: "[REDACTED]", ok: 1 });
    expect(line.excerpt).toBe("[REDACTED]");
    expect(line.content).toBe("[REDACTED]");
    expect(JSON.stringify(line)).not.toMatch(/AAA|Bearer/);
  });
});

describe("escapeHtml", () => {
  it("escapes all six characters", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&\``)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;&#96;",
    );
  });
});
