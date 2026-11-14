/**
 * Shared access and privacy helpers (Agent 19). Export names are frozen in docs/interfaces.md.
 *
 * Auth model:
 *  - AUTH_MODE "dev": HMAC-SHA256 signed server session cookie `vfa_session` issued by
 *    POST /auth/dev-login for a *known seeded* identity. Local/synthetic demo only; refused
 *    when RUNTIME_MODE is "deployed" (no public login bypass, handoff §16.1).
 *  - AUTH_MODE "access": Cloudflare Access in front of the Worker. The Access JWT
 *    (`Cf-Access-Jwt-Assertion` header, else the `CF_Authorization` cookie) is verified
 *    against the team JWKS (RS256, iss, aud, exp; ./access-jwt.ts) and its `email` claim is
 *    mapped server-side to a provider id. The plain `Cf-Access-Authenticated-User-Email`
 *    header is never trusted. ACCESS_TEAM_DOMAIN / ACCESS_AUD unset → 503 (fail closed).
 *
 * Provider identity is ALWAYS derived server-side; never accept providerId from clients.
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiDeps, Actor, AppBindings } from "../api/deps";
import type { ApiFailure } from "../contracts/schemas";
import { ACCESS_JWT_COOKIE, ACCESS_JWT_HEADER, accessConfig, isAmbiguousPath, verifyAccessJwt } from "./access-jwt";

export {
  ACCESS_JWT_COOKIE,
  ACCESS_JWT_HEADER,
  accessConfig,
  isAmbiguousPath,
  normaliseTeamDomain,
  resetAccessJwksCache,
  verifyAccessJwt,
} from "./access-jwt";

export const SESSION_COOKIE = "vfa_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

/** Access vars (plain `vars`, not secrets). Read through this type so src/env.ts stays frozen. */
type AccessEnv = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };

// ------------------------------------------------------------------ encoding utils
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/** Constant-time byte comparison (length leak only). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ------------------------------------------------------------------ correlation id
export function correlationId(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const id = crypto.randomUUID();
    c.set("correlationId", id);
    c.header("X-Correlation-Id", id);
    // First middleware on every API request, so it doubles as the path-normalisation guard:
    // an encoded dot/slash or dot segment could match an Access bypass path at the edge and
    // a different route here (docs/deploy.md §5.1). Rejected before any router runs.
    if (isAmbiguousPath(c.req.raw.url)) {
      return apiError(c, 400, "BAD_PATH", "Request path is not in canonical form.", false);
    }
    await next();
    // Ensure header survives handlers that build their own Response.
    if (!c.res.headers.has("X-Correlation-Id")) {
      try {
        c.res.headers.set("X-Correlation-Id", id);
      } catch {
        /* immutable headers; ignore */
      }
    }
  };
}

function getCorrelationId(c: Context): string {
  const existing = (c as Context<AppBindings>).get("correlationId");
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    (c as Context<AppBindings>).set("correlationId", id);
  } catch {
    /* ignore */
  }
  return id;
}

// ------------------------------------------------------------------ errors
export function apiError(
  c: Context,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): Response {
  const error: ApiFailure["error"] & { details?: unknown } = {
    code,
    message,
    retryable,
    correlationId: getCorrelationId(c),
  };
  if (details !== undefined) error.details = details;
  return c.json({ error }, status as ContentfulStatusCode);
}

// ------------------------------------------------------------------ session cookie
interface SessionPayload {
  providerId: string;
  identity: string;
  exp: number; // epoch seconds
}

function secretUsable(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Returns the payload only if the signature is valid and not expired. */
export async function verifySession(token: string, secret: string, nowMs: number): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sigPart] = parts as [string, string];
  try {
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
    if (!timingSafeEqual(expected, b64urlToBytes(sigPart))) return null;
    const p = JSON.parse(dec.decode(b64urlToBytes(body))) as Partial<SessionPayload>;
    if (typeof p.providerId !== "string" || !p.providerId) return null;
    if (typeof p.identity !== "string" || !p.identity) return null;
    if (typeof p.exp !== "number" || p.exp * 1000 <= nowMs) return null;
    return { providerId: p.providerId, identity: p.identity, exp: p.exp };
  } catch {
    return null;
  }
}

type ActorResult = { ok: true; actor: Actor } | { ok: false; status: number; code: string; message: string };

async function resolveActor(deps: ApiDeps, c: Context): Promise<ActorResult> {
  const env = deps.env;
  if (env.AUTH_MODE === "access") {
    const cfg = accessConfig(env as AccessEnv);
    if (!cfg) {
      return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED", message: "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD)." };
    }
    const token = c.req.header(ACCESS_JWT_HEADER)?.trim() || getCookie(c, ACCESS_JWT_COOKIE)?.trim();
    if (!token) return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Authentication required." };
    const verified = await verifyAccessJwt(token, cfg, { nowMs: deps.clock.now().getTime(), fetch: deps.fetch });
    if (!verified.ok) {
      log("warn", "auth.access_jwt_rejected", { reason: verified.reason });
      return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Access token is invalid or expired." };
    }
    const email = verified.email;
    const providerId = await deps.repo.findProviderByIdentity(email);
    if (!providerId) return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Identity is not mapped to a provider." };
    return { ok: true, actor: { providerId, identity: email } };
  }
  if (env.AUTH_MODE === "dev") {
    if (!secretUsable(env.SESSION_SECRET)) {
      return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED", message: "Session signing is not configured." };
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Authentication required." };
    const payload = await verifySession(cookie, env.SESSION_SECRET, deps.clock.now().getTime());
    if (!payload) return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Session is invalid or expired." };
    // Re-check mapping so a removed/remapped identity loses access immediately.
    const mapped = await deps.repo.findProviderByIdentity(payload.identity);
    if (mapped !== payload.providerId) {
      return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Session is no longer valid." };
    }
    return { ok: true, actor: { providerId: payload.providerId, identity: payload.identity } };
  }
  if (env.AUTH_MODE === "public") {
    // Open public access, by the owner's explicit decision: no login; everyone acts as one provider.
    // Device keys, stream tokens and review links keep their own checks.
    const providerId = env.PUBLIC_PROVIDER_ID;
    if (!providerId) return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED", message: "PUBLIC_PROVIDER_ID is not set." };
    return { ok: true, actor: { providerId, identity: "public" } };
  }
  return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED", message: "Unknown authentication mode." };
}

export function requireActor(deps: ApiDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const r = await resolveActor(deps, c);
    if (!r.ok) return apiError(c, r.status, r.code, r.message, false);
    c.set("actor", r.actor);
    await next();
  };
}

/** Ownership check helper: true only when the record belongs to the authenticated actor. */
export function isOwner(actor: Actor | undefined, ownerProviderId: string | null | undefined): boolean {
  return !!actor && !!ownerProviderId && actor.providerId === ownerProviderId;
}

// ------------------------------------------------------------------ origin / CSRF
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originGuard(deps: ApiDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();
    const origin = c.req.header("Origin");
    let selfOrigin: string | null = null;
    try {
      selfOrigin = new URL(c.req.url).origin;
    } catch {
      selfOrigin = null;
    }
    const allowed = !!origin && origin !== "null" && (origin === deps.env.APP_ORIGIN || origin === selfOrigin);
    if (!allowed) return apiError(c, 403, "ORIGIN_REJECTED", "Request origin is not allowed.", false);
    await next();
  };
}

// ------------------------------------------------------------------ auth routes
/** Dev login is only served to loopback hosts (defense in depth if vars are misconfigured on deploy). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function authRoutes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post("/auth/dev-login", async (c) => {
    const env = deps.env;
    if (env.AUTH_MODE !== "dev") return apiError(c, 404, "NOT_FOUND", "Not found.", false);
    if (env.RUNTIME_MODE === "deployed" || !isLoopbackHost(new URL(c.req.url).hostname)) {
      // Dev login on a deployed origin would be a public login bypass (handoff §16.1).
      return apiError(c, 404, "NOT_FOUND", "Not found.", false);
    }
    if (!secretUsable(env.SESSION_SECRET)) {
      return apiError(c, 503, "AUTH_NOT_CONFIGURED", "Session signing is not configured.", false);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_FAILED", "Body must be JSON.", false);
    }
    const raw = (body as { identity?: unknown } | null)?.identity;
    if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 320) {
      return apiError(c, 400, "VALIDATION_FAILED", "identity is required.", false);
    }
    const identity = raw.trim().toLowerCase();
    let providerId = await deps.repo.findProviderByIdentity(identity);
    // Local dev bootstrap: a fresh DB has no providers yet, and seeding needs a
    // login. Seed the synthetic demo data once (idempotent), then retry. Only
    // reachable here: AUTH_MODE dev, non-deployed runtime, loopback host.
    if (!providerId && deps.seed) {
      await deps.seed();
      providerId = await deps.repo.findProviderByIdentity(identity);
    }
    if (!providerId) return apiError(c, 401, "UNAUTHENTICATED", "Unknown identity.", false);

    const exp = Math.floor(deps.clock.now().getTime() / 1000) + SESSION_TTL_SECONDS;
    const token = await signSession({ providerId, identity, exp }, env.SESSION_SECRET);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: new URL(c.req.url).protocol === "https:",
      maxAge: SESSION_TTL_SECONDS,
    });
    log("info", "auth.dev_login", { providerId });
    return c.json({ data: { providerId, identity }, correlationId: getCorrelationId(c) });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
      secure: new URL(c.req.url).protocol === "https:",
      httpOnly: true,
      sameSite: "Strict",
    });
    return c.json({ data: { ok: true }, correlationId: getCorrelationId(c) });
  });

  app.get("/api/me", requireActor(deps), (c) => {
    const actor = c.get("actor");
    return c.json({
      data: { providerId: actor.providerId, identity: actor.identity },
      correlationId: getCorrelationId(c),
    });
  });

  return app;
}

// ------------------------------------------------------------------ token encryption
async function aesKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64ToBytes(keyB64.trim());
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64");
  }
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM, random 12-byte IV. Output: "v1." + base64url(iv || ciphertext+tag). */
export async function encryptToken(plain: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return `v1.${b64url(out)}`;
}

export async function decryptToken(blob: string, keyB64: string): Promise<string> {
  if (!blob.startsWith("v1.")) throw new Error("Unsupported token blob version");
  const key = await aesKey(keyB64);
  const bytes = b64urlToBytes(blob.slice(3));
  if (bytes.length < 12 + 16) throw new Error("Token blob too short");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return dec.decode(pt);
  } catch {
    throw new Error("Token decryption failed");
  }
}

// ------------------------------------------------------------------ redacted logging
export type LogLevel = "debug" | "info" | "warn" | "error";
const SENSITIVE_KEY = /token|secret|authorization|cookie|password|excerpt|transcript|text|prompt|content/i;
export const REDACTED = "[REDACTED]";

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ...(redact(fields) as object), ts: new Date().toISOString(), level, event });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ------------------------------------------------------------------ html escaping
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]!);
}
