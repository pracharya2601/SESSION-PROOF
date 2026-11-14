import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { OAuthPending, StoredConnection } from "../contracts";
import type { Actor, ApiDeps, AppBindings } from "../api/deps";
import type { Env } from "../env";
import { decryptToken, encryptToken } from "../security";
import { pkceChallenge } from "../auth/vexo";
import { ConnectionError, connectionViews, connectionsRoutes, getValidAccessToken, oauthConfig } from "./index";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const ORIGIN = "https://app.example.test";
const ACTOR: Actor = { providerId: "prov-1", identity: "p1@example.test" };
const SECRETS = ["AT-secret-1", "RT-secret-1", "AT-new-2", "RT-new-2", "the-auth-code", "gsecret", "mssecret"];

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    APP_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    MS_CLIENT_ID: "msid",
    MS_CLIENT_SECRET: "mssecret",
    TOKEN_ENCRYPTION_KEY: KEY,
    ...over,
  } as Env;
}

class FakeRepo {
  conns = new Map<string, StoredConnection>();
  pending = new Map<string, OAuthPending>();
  async getConnection(pid: string, p: string) {
    return this.conns.get(`${pid}:${p}`) ?? null;
  }
  async listConnections(pid: string) {
    return [...this.conns.values()].filter((c) => c.providerId === pid);
  }
  async saveConnection(c: StoredConnection) {
    this.conns.set(`${c.providerId}:${c.provider}`, { ...c });
  }
  async deleteConnection(pid: string, p: string) {
    this.conns.delete(`${pid}:${p}`);
  }
  async saveOAuthPending(p: OAuthPending) {
    this.pending.set(p.nonce, { ...p });
  }
  async consumeOAuthPending(nonce: string, now: Date) {
    const p = this.pending.get(nonce);
    if (!p) return null;
    this.pending.delete(nonce);
    return Date.parse(p.expiresAt) > now.getTime() ? p : null;
  }
}

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

let now = new Date("2026-11-13T12:00:00.000Z");
let repo: FakeRepo;

function setup(env = makeEnv(), handler: (url: string, init?: RequestInit) => Response = () => json({})) {
  repo = new FakeRepo();
  const ff = fakeFetch(handler);
  const deps = {
    repo: repo as unknown as ApiDeps["repo"],
    env,
    clock: { now: () => now },
    fetch: ff.fn,
  } as ApiDeps;
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "cid");
    if (c.req.path.startsWith("/api/")) c.set("actor", ACTOR);
    await next();
  });
  app.route("/", connectionsRoutes(deps));
  return { app, deps, calls: ff.calls };
}

const bodies: string[] = [];
async function text(res: Response) {
  const t = await res.clone().text();
  bodies.push(t + JSON.stringify([...res.headers.entries()]));
  return t;
}

function providerHandler(opts: { tokenStatus?: number; tokenBody?: unknown } = {}) {
  return (url: string) => {
    if (url.includes("/token")) return json(opts.tokenBody ?? { access_token: "AT-secret-1", refresh_token: "RT-secret-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/drive.file" }, opts.tokenStatus ?? 200);
    if (url.includes("userinfo")) return json({ email: "user@gmail.test" });
    if (url.includes("graph.microsoft.com")) return json({ mail: null, userPrincipalName: "user@contoso.test" });
    if (url.includes("revoke")) return new Response("", { status: 200 });
    return json({}, 404);
  };
}

async function start(app: Hono<AppBindings>, provider: string, body?: unknown) {
  const res = await app.request(`/api/connections/${provider}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

beforeEach(() => {
  now = new Date("2026-11-13T12:00:00.000Z");
});

describe("oauthConfig + views", () => {
  it("returns null without client credentials and builds redirect URIs", () => {
    expect(oauthConfig(makeEnv({ GOOGLE_CLIENT_ID: undefined }), "google")).toBeNull();
    expect(oauthConfig(makeEnv({ MS_CLIENT_SECRET: undefined }), "microsoft")).toBeNull();
    expect(oauthConfig(makeEnv(), "google")!.redirectUri).toBe(`${ORIGIN}/auth/connect/google/callback`);
    expect(oauthConfig(makeEnv({ MS_TENANT: "contoso" }), "microsoft")!.authorizeUrl).toBe(
      "https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize",
    );
    expect(oauthConfig(makeEnv(), "microsoft")!.tokenUrl).toContain("/common/oauth2/v2.0/token");
  });

  it("lists both providers as not_configured when unconfigured", async () => {
    const { app } = setup(makeEnv({ GOOGLE_CLIENT_ID: undefined, MS_CLIENT_ID: undefined }));
    const res = await app.request("/api/connections");
    expect(res.status).toBe(200);
    const { data } = JSON.parse(await text(res));
    expect(data.map((c: { provider: string; status: string }) => [c.provider, c.status])).toEqual([
      ["google", "not_configured"],
      ["microsoft", "not_configured"],
    ]);
  });

  it("start returns 503 when not configured; unknown provider 404", async () => {
    const { app } = setup(makeEnv({ GOOGLE_CLIENT_ID: undefined }));
    expect((await start(app, "google")).status).toBe(503);
    expect((await start(app, "dropbox")).status).toBe(404);
    expect((await app.request("/api/connections/dropbox", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/auth/connect/dropbox/callback?code=x&state=y")).status).toBe(404);
  });
});

describe("start", () => {
  it("produces a correct Google authorize URL and stores pending", async () => {
    const { app } = setup();
    const res = await start(app, "google", { returnTo: "/#/settings" });
    expect(res.status).toBe(200);
    const { data } = JSON.parse(await text(res));
    const u = new URL(data.authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = u.searchParams;
    expect(q.get("client_id")).toBe("gid");
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/auth/connect/google/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.compose",
    );
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    const state = q.get("state")!;
    const p = repo.pending.get(state)!;
    expect(p).toBeTruthy();
    expect(p.providerId).toBe(ACTOR.providerId);
    expect(p.provider).toBe("google");
    expect(p.returnTo).toBe("/#/settings");
    expect(Date.parse(p.expiresAt) - now.getTime()).toBe(10 * 60_000);
    expect(q.get("code_challenge")).toBe(await pkceChallenge(p.codeVerifier));
    expect(data.authorizeUrl).not.toContain(p.codeVerifier);
  });

  it("Microsoft URL uses tenant + MS scopes; default returnTo", async () => {
    const { app } = setup();
    const { data } = JSON.parse(await text(await start(app, "microsoft")));
    const u = new URL(data.authorizeUrl);
    expect(u.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("openid email offline_access User.Read Files.ReadWrite Mail.ReadWrite");
    expect(u.searchParams.get("access_type")).toBeNull();
    expect(repo.pending.get(u.searchParams.get("state")!)!.returnTo).toBe("/#/connections");
  });

  it("rejects off-origin returnTo", async () => {
    const { app } = setup();
    expect((await start(app, "google", { returnTo: "https://evil.test/x" })).status).toBe(400);
    expect((await start(app, "google", { returnTo: "//evil.test/x" })).status).toBe(400);
    expect(repo.pending.size).toBe(0);
  });
});

async function startState(app: Hono<AppBindings>, provider = "google", returnTo?: string) {
  const { data } = JSON.parse(await text(await start(app, provider, returnTo ? { returnTo } : undefined)));
  return new URL(data.authorizeUrl).searchParams.get("state")!;
}

describe("callback", () => {
  it("success stores encrypted tokens + email and redirects", async () => {
    const { app, calls } = setup(makeEnv(), providerHandler());
    const state = await startState(app);
    const verifier = repo.pending.get(state)!.codeVerifier;
    const res = await app.request(`/auth/connect/google/callback?code=the-auth-code&state=${state}`);
    await text(res);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/#/connections?connected=google");

    const tokenCall = calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const form = new URLSearchParams(String(tokenCall.init!.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-auth-code");
    expect(form.get("code_verifier")).toBe(verifier);
    expect(form.get("client_secret")).toBe("gsecret");
    expect(form.get("redirect_uri")).toBe(`${ORIGIN}/auth/connect/google/callback`);

    const stored = repo.conns.get("prov-1:google")!;
    expect(stored.status).toBe("connected");
    expect(stored.accountEmail).toBe("user@gmail.test");
    expect(stored.encryptedTokens).not.toContain("AT-secret-1");
    expect(JSON.parse(await decryptToken(stored.encryptedTokens, KEY))).toEqual({
      accessToken: "AT-secret-1",
      refreshToken: "RT-secret-1",
    });
    expect(stored.accessTokenExpiresAt).toBe(new Date(now.getTime() + 3600_000).toISOString());

    const list = JSON.parse(await text(await app.request("/api/connections"))).data;
    expect(list[0]).toMatchObject({ provider: "google", status: "connected", accountEmail: "user@gmail.test" });
    expect(list[1]).toMatchObject({ provider: "microsoft", status: "not_connected" });
  });

  it("Microsoft uses mail || userPrincipalName and custom returnTo", async () => {
    const { app } = setup(makeEnv(), providerHandler());
    const state = await startState(app, "microsoft", "/#/settings?tab=email");
    const res = await app.request(`/auth/connect/microsoft/callback?code=the-auth-code&state=${state}`);
    expect(res.headers.get("Location")).toBe("/#/settings?tab=email&connected=microsoft");
    expect(repo.conns.get("prov-1:microsoft")!.accountEmail).toBe("user@contoso.test");
  });

  it("replayed state fails", async () => {
    const { app } = setup(makeEnv(), providerHandler());
    const state = await startState(app);
    await app.request(`/auth/connect/google/callback?code=the-auth-code&state=${state}`);
    const res = await app.request(`/auth/connect/google/callback?code=the-auth-code&state=${state}`);
    expect(res.headers.get("Location")).toBe("/#/connections?error=invalid_state");
  });

  it("expired state fails", async () => {
    const { app } = setup(makeEnv(), providerHandler());
    const state = await startState(app);
    now = new Date(now.getTime() + 11 * 60_000);
    const res = await app.request(`/auth/connect/google/callback?code=the-auth-code&state=${state}`);
    expect(res.headers.get("Location")).toBe("/#/connections?error=invalid_state");
    expect(repo.conns.size).toBe(0);
  });

  it("provider mismatch fails", async () => {
    const { app, calls } = setup(makeEnv(), providerHandler());
    const state = await startState(app, "google");
    const res = await app.request(`/auth/connect/microsoft/callback?code=the-auth-code&state=${state}`);
    expect(res.headers.get("Location")).toBe("/#/connections?error=provider_mismatch");
    expect(calls.length).toBe(0);
    expect(repo.conns.size).toBe(0);
  });

  it("access_denied redirects with error and burns state", async () => {
    const { app } = setup(makeEnv(), providerHandler());
    const state = await startState(app);
    const res = await app.request(`/auth/connect/google/callback?error=access_denied&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/#/connections?error=access_denied");
    expect(repo.pending.size).toBe(0);
    const res2 = await app.request(`/auth/connect/google/callback?error=server_error&state=x`);
    expect(res2.headers.get("Location")).toBe("/#/connections?error=provider_error");
  });

  it("token exchange failure redirects provider_error", async () => {
    const { app } = setup(makeEnv(), providerHandler({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } }));
    const state = await startState(app);
    const res = await app.request(`/auth/connect/google/callback?code=the-auth-code&state=${state}`);
    expect(res.headers.get("Location")).toBe("/#/connections?error=provider_error");
  });
});

async function seedConn(deps: ApiDeps, over: Partial<StoredConnection> = {}, tokens = { accessToken: "AT-secret-1", refreshToken: "RT-secret-1" as string | null }) {
  await deps.repo.saveConnection({
    providerId: "prov-1",
    provider: "google",
    accountEmail: "user@gmail.test",
    scopes: ["openid"],
    encryptedTokens: await encryptToken(JSON.stringify(tokens), KEY),
    accessTokenExpiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    status: "connected",
    lastError: null,
    connectedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...over,
  });
}

describe("getValidAccessToken", () => {
  it("returns stored token when fresh (no network)", async () => {
    const { deps, calls } = setup(makeEnv(), providerHandler());
    await seedConn(deps);
    expect(await getValidAccessToken(deps, "prov-1", "google")).toBe("AT-secret-1");
    expect(calls.length).toBe(0);
  });

  it("refreshes when expired and persists new tokens (keeps old refresh token if none)", async () => {
    const { deps, calls } = setup(makeEnv(), providerHandler({ tokenBody: { access_token: "AT-new-2", expires_in: 1800 } }));
    await seedConn(deps, { accessTokenExpiresAt: new Date(now.getTime() + 30_000).toISOString() });
    expect(await getValidAccessToken(deps, "prov-1", "google")).toBe("AT-new-2");
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("RT-secret-1");
    const s = repo.conns.get("prov-1:google")!;
    expect(JSON.parse(await decryptToken(s.encryptedTokens, KEY))).toEqual({ accessToken: "AT-new-2", refreshToken: "RT-secret-1" });
    expect(s.accessTokenExpiresAt).toBe(new Date(now.getTime() + 1800_000).toISOString());
  });

  it("stores rotated refresh token when returned", async () => {
    const { deps } = setup(makeEnv(), providerHandler({ tokenBody: { access_token: "AT-new-2", refresh_token: "RT-new-2", expires_in: 60 } }));
    await seedConn(deps, { accessTokenExpiresAt: new Date(now.getTime() - 1000).toISOString() });
    await getValidAccessToken(deps, "prov-1", "google");
    const s = repo.conns.get("prov-1:google")!;
    expect(JSON.parse(await decryptToken(s.encryptedTokens, KEY)).refreshToken).toBe("RT-new-2");
  });

  it("invalid_grant marks status error and throws reauth_required", async () => {
    const { app, deps } = setup(makeEnv(), providerHandler({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } }));
    await seedConn(deps, { accessTokenExpiresAt: new Date(now.getTime() - 1000).toISOString() });
    const err = await getValidAccessToken(deps, "prov-1", "google").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe("reauth_required");
    expect(repo.conns.get("prov-1:google")!.status).toBe("error");
    const views = await connectionViews(deps, "prov-1");
    expect(views[0]!.status).toBe("error");
    expect(views[0]!.lastError).toBeTruthy();
    await text(await app.request("/api/connections"));
    // subsequent calls fail fast
    expect((await getValidAccessToken(deps, "prov-1", "google").catch((e) => e)).code).toBe("reauth_required");
  });

  it("not_connected / not_configured / provider_error", async () => {
    const { deps } = setup(makeEnv(), providerHandler({ tokenStatus: 500, tokenBody: { error: "server_error" } }));
    expect((await getValidAccessToken(deps, "prov-1", "google").catch((e) => e)).code).toBe("not_connected");
    await seedConn(deps, { accessTokenExpiresAt: new Date(now.getTime() - 1000).toISOString() });
    expect((await getValidAccessToken(deps, "prov-1", "google").catch((e) => e)).code).toBe("provider_error");
    expect(repo.conns.get("prov-1:google")!.status).toBe("connected");
    const d2 = { ...deps, env: makeEnv({ GOOGLE_CLIENT_SECRET: undefined }) };
    expect((await getValidAccessToken(d2, "prov-1", "google").catch((e) => e)).code).toBe("not_configured");
  });
});

describe("disconnect", () => {
  it("revokes (google, best-effort) and deletes", async () => {
    const { app, deps, calls } = setup(makeEnv(), () => {
      throw new Error("network down");
    });
    await seedConn(deps);
    const res = await app.request("/api/connections/google", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await text(res)).data).toEqual({ disconnected: true });
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(repo.conns.size).toBe(0);
  });

  it("microsoft: no revoke call", async () => {
    const { app, deps, calls } = setup(makeEnv(), providerHandler());
    await seedConn(deps, { provider: "microsoft" });
    await text(await app.request("/api/connections/microsoft", { method: "DELETE" }));
    expect(calls.length).toBe(0);
    expect(repo.conns.size).toBe(0);
  });
});

describe("no token leakage", () => {
  it("no response body or header contained a token, code or secret", () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const b of bodies) for (const s of SECRETS) expect(b).not.toContain(s);
  });
});
