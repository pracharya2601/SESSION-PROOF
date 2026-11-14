/**
 * Cloud connections (V5): OAuth 2.0 authorization-code + PKCE for Google
 * (Drive + Gmail) and Microsoft (OneDrive + Outlook), encrypted token storage,
 * refresh, disconnect, and the HTTP routes.
 *
 * Tokens and authorization codes are never returned in responses or logged.
 */
import { Hono } from "hono";
import {
  ConnectionProvider,
  type Connection,
  type StartConnectionResponse,
  type StoredConnection,
} from "../contracts";
import type { Actor, ApiDeps, AppBindings } from "../api/deps";
import { ok } from "../api/respond";
import type { Env } from "../env";
import { apiError, decryptToken, encryptToken, log } from "../security";
import { assertSafeRedirect, base64UrlEncode, createPkcePair } from "../auth/vexo";

export type ConnectionDeps = Pick<ApiDeps, "repo" | "env" | "clock" | "fetch">;

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
}

export type ConnectionErrorCode = "not_configured" | "not_connected" | "reauth_required" | "provider_error";

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** Callback/start failures that are not ConnectionError codes. */
class FlowError extends Error {
  constructor(
    readonly code: "invalid_state" | "provider_mismatch" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "FlowError";
  }
}

const PROVIDERS: readonly ConnectionProvider[] = ["google", "microsoft"];
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_RETURN_TO = "/#/connections";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const SCOPES: Record<ConnectionProvider, string[]> = {
  google: ["openid", "email", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/gmail.compose"],
  microsoft: ["openid", "email", "offline_access", "User.Read", "Files.ReadWrite", "Mail.ReadWrite"],
};

export function oauthConfig(env: Env, provider: ConnectionProvider): OAuthConfig | null {
  const redirectUri = `${env.APP_ORIGIN}/auth/connect/${provider}/callback`;
  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      scopes: [...SCOPES.google],
      redirectUri,
    };
  }
  if (provider === "microsoft") {
    if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return null;
    const tenant = encodeURIComponent(env.MS_TENANT || "common");
    return {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      userinfoUrl: "https://graph.microsoft.com/v1.0/me",
      clientId: env.MS_CLIENT_ID,
      clientSecret: env.MS_CLIENT_SECRET,
      scopes: [...SCOPES.microsoft],
      redirectUri,
    };
  }
  return null;
}

// ------------------------------------------------------------------ helpers
interface TokenPair {
  accessToken: string;
  refreshToken: string | null;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

function fetchOf(deps: ConnectionDeps): typeof fetch {
  return deps.fetch ?? fetch;
}

function requireConfig(env: Env, provider: ConnectionProvider): OAuthConfig {
  const cfg = oauthConfig(env, provider);
  if (!cfg) throw new ConnectionError("not_configured", `${provider} OAuth client is not configured.`);
  return cfg;
}

function requireKey(env: Env): string {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new ConnectionError("not_configured", "Token encryption key is not configured.");
  return env.TOKEN_ENCRYPTION_KEY;
}

function randomNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64UrlEncode(b);
}

/** Validates and normalizes returnTo to a same-origin relative path (path + query + hash). */
function safeReturnTo(returnTo: string | undefined, appOrigin: string): string {
  if (returnTo === undefined) return DEFAULT_RETURN_TO;
  let abs: string;
  try {
    abs = assertSafeRedirect(returnTo, appOrigin);
  } catch {
    throw new FlowError("invalid_request", "returnTo must be a same-origin path.");
  }
  const u = new URL(abs);
  return `${u.pathname}${u.search}${u.hash}` || "/";
}

function expiresAt(now: Date, expiresIn: unknown): string | null {
  const n = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(now.getTime() + n * 1000).toISOString();
}

async function postForm(
  deps: ConnectionDeps,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: TokenResponse }> {
  let res: Response;
  try {
    res = await fetchOf(deps)(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new ConnectionError("provider_error", "Could not reach the provider token endpoint.");
  }
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    body = {};
  }
  return { status: res.status, body: body && typeof body === "object" ? body : {} };
}

async function fetchAccountEmail(
  deps: ConnectionDeps,
  provider: ConnectionProvider,
  cfg: OAuthConfig,
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await fetchOf(deps)(cfg.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const email = provider === "google" ? j.email : (j.mail ?? j.userPrincipalName);
    return typeof email === "string" && email.length > 0 ? email.slice(0, 254) : null;
  } catch {
    return null;
  }
}

function parseProvider(raw: string): ConnectionProvider | null {
  const p = ConnectionProvider.safeParse(raw);
  return p.success ? p.data : null;
}

// ------------------------------------------------------------------ flow
export async function startConnection(
  deps: ConnectionDeps,
  actor: Actor,
  provider: ConnectionProvider,
  returnTo?: string,
): Promise<StartConnectionResponse> {
  const cfg = requireConfig(deps.env, provider);
  requireKey(deps.env);
  const target = safeReturnTo(returnTo, deps.env.APP_ORIGIN);
  const pkce = await createPkcePair();
  const nonce = randomNonce();
  await deps.repo.saveOAuthPending({
    nonce,
    providerId: actor.providerId,
    provider,
    codeVerifier: pkce.codeVerifier,
    returnTo: target,
    expiresAt: new Date(deps.clock.now().getTime() + PENDING_TTL_MS).toISOString(),
  });
  const url = new URL(cfg.authorizeUrl);
  const p = url.searchParams;
  p.set("client_id", cfg.clientId);
  p.set("redirect_uri", cfg.redirectUri);
  p.set("response_type", "code");
  p.set("scope", cfg.scopes.join(" "));
  p.set("state", nonce);
  p.set("code_challenge", pkce.codeChallenge);
  p.set("code_challenge_method", "S256");
  if (provider === "google") {
    p.set("access_type", "offline");
    p.set("prompt", "consent");
    p.set("include_granted_scopes", "true");
  } else {
    p.set("response_mode", "query");
    p.set("prompt", "select_account");
  }
  log("info", "connection.start", { provider, providerId: actor.providerId });
  return { authorizeUrl: url.toString() };
}

export async function completeConnection(
  deps: ConnectionDeps,
  provider: ConnectionProvider,
  code: string,
  state: string,
): Promise<{ providerId: string; returnTo: string }> {
  const now = deps.clock.now();
  const pending = await deps.repo.consumeOAuthPending(state, now);
  if (!pending) throw new FlowError("invalid_state", "OAuth state is invalid, expired or already used.");
  if (pending.provider !== provider) throw new FlowError("provider_mismatch", "OAuth state does not match provider.");
  const cfg = requireConfig(deps.env, provider);
  const key = requireKey(deps.env);

  const exchange: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: pending.codeVerifier,
  };
  if (provider === "microsoft") exchange.scope = cfg.scopes.join(" ");
  const { status, body } = await postForm(deps, cfg.tokenUrl, exchange);
  if (status < 200 || status >= 300 || typeof body.access_token !== "string" || !body.access_token) {
    log("warn", "connection.exchange_failed", { provider, status, error: typeof body.error === "string" ? body.error : null });
    throw new ConnectionError("provider_error", "Authorization code exchange failed.");
  }
  const tokens: TokenPair = {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
  };
  const accountEmail = await fetchAccountEmail(deps, provider, cfg, tokens.accessToken);
  const scopes =
    typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().split(/\s+/) : [...cfg.scopes];
  const iso = now.toISOString();
  await deps.repo.saveConnection({
    providerId: pending.providerId,
    provider,
    accountEmail,
    scopes,
    encryptedTokens: await encryptToken(JSON.stringify(tokens), key),
    accessTokenExpiresAt: expiresAt(now, body.expires_in),
    status: "connected",
    lastError: null,
    connectedAt: iso,
    updatedAt: iso,
  });
  log("info", "connection.connected", { provider, providerId: pending.providerId });
  return { providerId: pending.providerId, returnTo: pending.returnTo };
}

async function readTokens(conn: StoredConnection, key: string): Promise<TokenPair> {
  try {
    const j = JSON.parse(await decryptToken(conn.encryptedTokens, key)) as Partial<TokenPair>;
    if (typeof j.accessToken !== "string") throw new Error("bad");
    return { accessToken: j.accessToken, refreshToken: typeof j.refreshToken === "string" ? j.refreshToken : null };
  } catch {
    throw new ConnectionError("reauth_required", "Stored credentials are unreadable; reconnect required.");
  }
}

async function markError(deps: ConnectionDeps, conn: StoredConnection, message: string): Promise<void> {
  await deps.repo.saveConnection({
    ...conn,
    status: "error",
    lastError: message.slice(0, 500),
    updatedAt: deps.clock.now().toISOString(),
  });
}

export async function getValidAccessToken(
  deps: ConnectionDeps,
  providerId: string,
  provider: ConnectionProvider,
): Promise<string> {
  const cfg = requireConfig(deps.env, provider);
  const key = requireKey(deps.env);
  const conn = await deps.repo.getConnection(providerId, provider);
  if (!conn) throw new ConnectionError("not_connected", `${provider} is not connected.`);
  if (conn.status === "error") throw new ConnectionError("reauth_required", `${provider} connection needs to be reconnected.`);
  const tokens = await readTokens(conn, key);

  const now = deps.clock.now();
  const exp = conn.accessTokenExpiresAt ? Date.parse(conn.accessTokenExpiresAt) : NaN;
  const fresh = Number.isFinite(exp) ? exp - now.getTime() > REFRESH_SKEW_MS : true;
  if (fresh) return tokens.accessToken;

  if (!tokens.refreshToken) {
    await markError(deps, conn, "Access expired and no refresh token is available. Reconnect required.");
    throw new ConnectionError("reauth_required", `${provider} access expired; reconnect required.`);
  }
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  };
  if (provider === "microsoft") form.scope = cfg.scopes.join(" ");
  const { status, body } = await postForm(deps, cfg.tokenUrl, form);
  if (body.error === "invalid_grant" || (status === 400 && body.error === "invalid_grant")) {
    await markError(deps, conn, "Authorization was revoked or expired. Reconnect required.");
    log("warn", "connection.refresh_invalid_grant", { provider, providerId });
    throw new ConnectionError("reauth_required", `${provider} authorization expired; reconnect required.`);
  }
  if (status < 200 || status >= 300 || typeof body.access_token !== "string" || !body.access_token) {
    log("warn", "connection.refresh_failed", { provider, providerId, status });
    throw new ConnectionError("provider_error", `${provider} token refresh failed.`);
  }
  const next: TokenPair = {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : tokens.refreshToken,
  };
  await deps.repo.saveConnection({
    ...conn,
    encryptedTokens: await encryptToken(JSON.stringify(next), key),
    accessTokenExpiresAt: expiresAt(now, body.expires_in),
    status: "connected",
    lastError: null,
    updatedAt: now.toISOString(),
  });
  return next.accessToken;
}

export async function disconnect(deps: ConnectionDeps, providerId: string, provider: ConnectionProvider): Promise<void> {
  const conn = await deps.repo.getConnection(providerId, provider);
  if (conn && provider === "google" && deps.env.TOKEN_ENCRYPTION_KEY) {
    try {
      const t = await readTokens(conn, deps.env.TOKEN_ENCRYPTION_KEY);
      await fetchOf(deps)(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refreshToken ?? t.accessToken }).toString(),
      });
    } catch {
      log("warn", "connection.revoke_failed", { provider, providerId });
    }
  }
  await deps.repo.deleteConnection(providerId, provider);
  log("info", "connection.disconnected", { provider, providerId });
}

export async function connectionViews(deps: ConnectionDeps, providerId: string): Promise<Connection[]> {
  const stored = await deps.repo.listConnections(providerId);
  return PROVIDERS.map((provider): Connection => {
    const s = stored.find((c) => c.provider === provider);
    if (!oauthConfig(deps.env, provider)) {
      return { provider, status: "not_configured", accountEmail: null, scopes: [], connectedAt: null, lastError: null };
    }
    if (!s) {
      return { provider, status: "not_connected", accountEmail: null, scopes: [], connectedAt: null, lastError: null };
    }
    return {
      provider,
      status: s.status,
      accountEmail: s.accountEmail,
      scopes: [...s.scopes],
      connectedAt: s.connectedAt,
      lastError: s.lastError,
    };
  });
}

// ------------------------------------------------------------------ routes
function appendParam(path: string, key: string, value: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${key}=${encodeURIComponent(value)}`;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

const STATUS_FOR: Record<ConnectionErrorCode, number> = {
  not_configured: 503,
  not_connected: 409,
  reauth_required: 409,
  provider_error: 502,
};

export function connectionsRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/connections", async (c) => ok(c, await connectionViews(deps, c.get("actor").providerId)));

  app.post("/api/connections/:provider/start", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return apiError(c, 404, "NOT_FOUND", "Unknown provider.", false);
    let returnTo: string | undefined;
    const raw = await c.req.text();
    if (raw.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return apiError(c, 400, "INVALID_REQUEST", "Body must be JSON.", false);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return apiError(c, 400, "INVALID_REQUEST", "Body must be an object.", false);
      }
      const rt = (body as Record<string, unknown>).returnTo;
      if (rt !== undefined && (typeof rt !== "string" || rt.length > 2000)) {
        return apiError(c, 400, "INVALID_REQUEST", "returnTo must be a string.", false);
      }
      returnTo = rt as string | undefined;
    }
    try {
      return ok(c, await startConnection(deps, c.get("actor"), provider, returnTo));
    } catch (e) {
      if (e instanceof FlowError) return apiError(c, 400, "INVALID_REQUEST", e.message, false);
      if (e instanceof ConnectionError) return apiError(c, STATUS_FOR[e.code], e.code.toUpperCase(), e.message, false);
      throw e;
    }
  });

  app.delete("/api/connections/:provider", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return apiError(c, 404, "NOT_FOUND", "Unknown provider.", false);
    await disconnect(deps, c.get("actor").providerId, provider);
    return ok(c, { disconnected: true as const });
  });

  // No actor: the session cookie is SameSite=Strict and is not sent on this cross-site
  // redirect. Identity comes from the one-time, expiring state row.
  app.get("/auth/connect/:provider/callback", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return apiError(c, 404, "NOT_FOUND", "Unknown provider.", false);
    const fail = (code: string) => redirect(appendParam(DEFAULT_RETURN_TO, "error", code));
    const state = c.req.query("state");
    const providerErr = c.req.query("error");
    if (providerErr) {
      // Burn the state row so it cannot be reused.
      if (state) await deps.repo.consumeOAuthPending(state, deps.clock.now()).catch(() => null);
      log("info", "connection.provider_denied", { provider, reason: providerErr.slice(0, 64) });
      return fail(providerErr === "access_denied" ? "access_denied" : "provider_error");
    }
    const code = c.req.query("code");
    if (!state) return fail("invalid_state");
    if (!code) return fail("invalid_request");
    try {
      const { returnTo } = await completeConnection(deps, provider, code, state);
      return redirect(appendParam(returnTo, "connected", provider));
    } catch (e) {
      if (e instanceof FlowError || e instanceof ConnectionError) return fail(e.code);
      log("error", "connection.callback_failed", { provider, error: e instanceof Error ? e.message : "unknown" });
      return fail("provider_error");
    }
  });

  return app;
}
