import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiDeps, AppBindings } from "../api/deps";
import type { Env } from "../env";
import {
  CLOCK_SKEW_SECONDS,
  JWKS_REFETCH_MIN_MS,
  accessConfig,
  isAmbiguousPath,
  normaliseTeamDomain,
  resetAccessJwksCache,
  verifyAccessJwt,
} from "./access-jwt";
import { correlationId, requireActor } from "./index";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-0123456789abcdef";
const NOW = new Date("2026-11-14T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const IDENTITIES: Record<string, string> = { "provider@example.test": "prov_1" };

const enc = new TextEncoder();
const b64url = (b: Uint8Array | string) => Buffer.from(typeof b === "string" ? enc.encode(b) : b).toString("base64url");

let keyA: CryptoKeyPair;
let keyB: CryptoKeyPair;
let jwkA: JsonWebKey;
let jwkB: JsonWebKey;

async function rsa(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

beforeAll(async () => {
  keyA = await rsa();
  keyB = await rsa();
  jwkA = await crypto.subtle.exportKey("jwk", keyA.publicKey);
  jwkB = await crypto.subtle.exportKey("jwk", keyB.publicKey);
});

beforeEach(() => resetAccessJwksCache());

type Claims = Record<string, unknown>;
const goodClaims = (over: Claims = {}): Claims => ({
  iss: TEAM,
  aud: [AUD],
  email: "Provider@Example.test",
  exp: nowSec + 3600,
  iat: nowSec - 10,
  nbf: nowSec - 10,
  type: "app",
  ...over,
});

async function sign(claims: Claims, opts: { kid?: string; key?: CryptoKey; header?: Claims } = {}): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "kid-a", typ: "JWT", ...opts.header }));
  const payload = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keyA.privateKey, enc.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

/** A fake JWKS endpoint; `sets` is served in order (last one repeats). */
function jwksFetch(sets: Array<Array<[string, JsonWebKey]>>) {
  let i = 0;
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe(`${TEAM}/cdn-cgi/access/certs`);
    const set = sets[Math.min(i++, sets.length - 1)]!;
    return new Response(
      JSON.stringify({ keys: set.map(([kid, jwk]) => ({ kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e })) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return fn as unknown as typeof fetch & typeof fn;
}

const cfg = { teamDomain: TEAM, aud: AUD };

describe("verifyAccessJwt", () => {
  it("accepts a valid token and lowercases the email", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const r = await verifyAccessJwt(await sign(goodClaims()), cfg, { nowMs: NOW.getTime(), fetch: f });
    expect(r).toEqual({ ok: true, email: "provider@example.test" });
  });

  it("accepts aud as a string", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const r = await verifyAccessJwt(await sign(goodClaims({ aud: AUD })), cfg, { nowMs: NOW.getTime(), fetch: f });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["wrong aud", { aud: ["other"] }, "aud"],
    ["wrong iss", { iss: "https://evil.cloudflareaccess.com" }, "iss"],
    ["expired beyond skew", { exp: nowSec - CLOCK_SKEW_SECONDS - 1 }, "exp"],
    ["missing exp", { exp: undefined }, "exp"],
    ["nbf in the future", { nbf: nowSec + CLOCK_SKEW_SECONDS + 5 }, "nbf"],
    ["iat in the future", { iat: nowSec + CLOCK_SKEW_SECONDS + 5 }, "iat"],
    ["service token (no email)", { email: undefined, common_name: "svc.access" }, "email"],
    ["empty email", { email: "  " }, "email"],
  ])("rejects %s", async (_name, over, reason) => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const r = await verifyAccessJwt(await sign(goodClaims(over as Claims)), cfg, { nowMs: NOW.getTime(), fetch: f });
    expect(r).toEqual({ ok: false, reason });
  });

  it("allows 60 s of clock skew on exp", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const r = await verifyAccessJwt(await sign(goodClaims({ exp: nowSec - 30 })), cfg, { nowMs: NOW.getTime(), fetch: f });
    expect(r.ok).toBe(true);
  });

  it("rejects a bad signature (signed by another key under kid-a)", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const r = await verifyAccessJwt(await sign(goodClaims(), { key: keyB.privateKey }), cfg, { nowMs: NOW.getTime(), fetch: f });
    expect(r).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a tampered payload", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const [h, , s] = (await sign(goodClaims())).split(".");
    const forged = `${h}.${b64url(JSON.stringify(goodClaims({ email: "attacker@evil.test" })))}.${s}`;
    expect(await verifyAccessJwt(forged, cfg, { nowMs: NOW.getTime(), fetch: f })).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects alg none and HS256 without fetching keys", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const payload = b64url(JSON.stringify(goodClaims()));
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "kid-a" }))}.${payload}.`;
    const hs = `${b64url(JSON.stringify({ alg: "HS256", kid: "kid-a" }))}.${payload}.${b64url("sig")}`;
    for (const t of [none, hs]) {
      expect(await verifyAccessJwt(t, cfg, { nowMs: NOW.getTime(), fetch: f })).toEqual({ ok: false, reason: "alg" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects garbage", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    for (const t of ["", "a.b", "a.b.c.d", "!!.@@.##", "x".repeat(20_000)]) {
      expect((await verifyAccessJwt(t, cfg, { nowMs: NOW.getTime(), fetch: f })).ok).toBe(false);
    }
  });

  it("caches the JWKS and refetches once on an unknown kid (key rotation)", async () => {
    const f = jwksFetch([[["kid-a", jwkA]], [["kid-a", jwkA], ["kid-b", jwkB]]]);
    const t0 = NOW.getTime();
    expect((await verifyAccessJwt(await sign(goodClaims()), cfg, { nowMs: t0, fetch: f })).ok).toBe(true);
    expect((await verifyAccessJwt(await sign(goodClaims()), cfg, { nowMs: t0 + 1000, fetch: f })).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const rotated = await sign(goodClaims(), { kid: "kid-b", key: keyB.privateKey });
    const later = t0 + JWKS_REFETCH_MIN_MS + 1;
    expect((await verifyAccessJwt(rotated, cfg, { nowMs: later, fetch: f })).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("an unknown kid refetches only once and is then rejected; refetches are throttled", async () => {
    const f = jwksFetch([[["kid-a", jwkA]]]);
    const t0 = NOW.getTime();
    await verifyAccessJwt(await sign(goodClaims()), cfg, { nowMs: t0, fetch: f });
    const bogus = await sign(goodClaims(), { kid: "kid-zzz" });
    const t1 = t0 + JWKS_REFETCH_MIN_MS + 1;
    expect(await verifyAccessJwt(bogus, cfg, { nowMs: t1, fetch: f })).toEqual({ ok: false, reason: "kid" });
    expect(f).toHaveBeenCalledTimes(2);
    // Inside the throttle window: no further fetch.
    expect(await verifyAccessJwt(bogus, cfg, { nowMs: t1 + 1000, fetch: f })).toEqual({ ok: false, reason: "kid" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("JWKS fetch failure → rejected (no key)", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyAccessJwt(await sign(goodClaims()), cfg, { nowMs: NOW.getTime(), fetch: f })).toEqual({
      ok: false,
      reason: "kid",
    });
  });
});

describe("accessConfig / normaliseTeamDomain", () => {
  it("normalises the team domain", () => {
    expect(normaliseTeamDomain("team.cloudflareaccess.com")).toBe(TEAM);
    expect(normaliseTeamDomain("https://team.cloudflareaccess.com/")).toBe(TEAM);
    expect(normaliseTeamDomain("http://team.cloudflareaccess.com")).toBeNull();
    expect(normaliseTeamDomain("https://team.cloudflareaccess.com/x")).toBeNull();
    expect(normaliseTeamDomain("https://<team>.cloudflareaccess.com")).toBeNull();
    expect(normaliseTeamDomain(undefined)).toBeNull();
  });
  it("needs both vars", () => {
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(accessConfig({ ACCESS_AUD: AUD })).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "<aud>" })).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })).toEqual(cfg);
  });
});

describe("requireActor (access mode with JWT)", () => {
  function makeApp(envOver: Partial<Env> = {}, f: typeof fetch = jwksFetch([[["kid-a", jwkA]]])) {
    const env = {
      AUTH_MODE: "access",
      APP_ORIGIN: "https://field.example.test",
      RUNTIME_MODE: "deployed",
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ...envOver,
    } as unknown as Env;
    const repo = { findProviderByIdentity: async (i: string) => IDENTITIES[i] ?? null } as unknown as ApiDeps["repo"];
    const deps = { env, repo, clock: { now: () => NOW }, fetch: f } as unknown as ApiDeps;
    const app = new Hono<AppBindings>();
    app.use("*", correlationId());
    app.use("/api/*", requireActor(deps));
    app.get("/api/who", (c) => c.json({ data: c.get("actor") }));
    return app;
  }
  const who = async (app: Hono<AppBindings>, headers: Record<string, string>) => {
    const r = await app.request("https://field.example.test/api/who", { headers });
    return { status: r.status, body: (await r.json()) as { data?: { providerId: string; identity: string }; error?: { code: string } } };
  };

  it("valid Cf-Access-Jwt-Assertion header → actor", async () => {
    const r = await who(makeApp(), { "Cf-Access-Jwt-Assertion": await sign(goodClaims()) });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ providerId: "prov_1", identity: "provider@example.test" });
  });

  it("valid CF_Authorization cookie only → actor", async () => {
    const r = await who(makeApp(), { Cookie: `other=1; CF_Authorization=${await sign(goodClaims())}` });
    expect(r.status).toBe(200);
    expect(r.body.data?.providerId).toBe("prov_1");
  });

  it("forged email header with no JWT → 401", async () => {
    const r = await who(makeApp(), { "Cf-Access-Authenticated-User-Email": "provider@example.test" });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("UNAUTHENTICATED");
  });

  it("email header does not override the JWT identity", async () => {
    const r = await who(makeApp(), {
      "Cf-Access-Jwt-Assertion": await sign(goodClaims({ email: "nobody@example.test" })),
      "Cf-Access-Authenticated-User-Email": "provider@example.test",
    });
    expect(r.status).toBe(401);
  });

  it("invalid JWT → 401 (wrong aud)", async () => {
    const r = await who(makeApp(), { "Cf-Access-Jwt-Assertion": await sign(goodClaims({ aud: ["x"] })) });
    expect(r.status).toBe(401);
  });

  it("valid JWT for an unmapped email → 401", async () => {
    const r = await who(makeApp(), { "Cf-Access-Jwt-Assertion": await sign(goodClaims({ email: "x@y.z" })) });
    expect(r.status).toBe(401);
  });

  it.each([{ ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_AUD: undefined }, { ACCESS_AUD: "" }])(
    "missing Access var %o → 503 AUTH_NOT_CONFIGURED",
    async (over) => {
      const r = await who(makeApp(over as Partial<Env>), { "Cf-Access-Jwt-Assertion": await sign(goodClaims()) });
      expect(r.status).toBe(503);
      expect(r.body.error?.code).toBe("AUTH_NOT_CONFIGURED");
    },
  );
});

describe("isAmbiguousPath / correlationId path guard", () => {
  it.each([
    "https://h/api/device/%2e%2e/sessions",
    "https://h/api/device/%2E%2E/sessions",
    "https://h/api/device/..%2fsessions",
    "https://h/api/device%2f..%2fsessions",
    "https://h/api/device/%5c..%5csessions",
    "https://h/api/device/\\..\\sessions",
    "https://h/api/device/../sessions",
    "https://h/api/device/./me",
    "https://h/api//sessions",
    "https://h/auth/%2e%2e/api/sessions",
  ])("rejects %s", (u) => {
    expect(isAmbiguousPath(u)).toBe(true);
  });

  it.each([
    "https://h/api/device/me",
    "https://h/api/visits/visit_1/stop?token=a.b%2Fc",
    "https://h/api/sessions/s1/documents/invoice",
    "https://h/assets/app.%2e.js",
    "https://h/",
  ])("allows %s", (u) => {
    expect(isAmbiguousPath(u)).toBe(false);
  });

  it("returns 400 BAD_PATH before routing", async () => {
    const app = new Hono<AppBindings>();
    app.use("*", correlationId());
    const reached = vi.fn();
    app.all("*", (c) => {
      reached();
      return c.text("ok");
    });
    const r = await app.fetch(new Request("https://h/api/device/%2fsessions"));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("BAD_PATH");
    expect(reached).not.toHaveBeenCalled();
  });
});
