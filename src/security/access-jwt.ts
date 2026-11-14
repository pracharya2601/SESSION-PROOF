/**
 * Cloudflare Access JWT verification (security-review H2, docs/deploy.md §5.4).
 *
 * The token comes from the `Cf-Access-Jwt-Assertion` header (added by Access on protected
 * paths) or the `CF_Authorization` cookie (sent by the browser on every path of the host,
 * including the bypassed ones, e.g. the web UI's Stop). It is verified with WebCrypto only:
 *  - alg must be RS256; key picked by `kid` from `<team>/cdn-cgi/access/certs`
 *  - JWKS cached in module scope (1 h); an unknown kid triggers ONE refetch, throttled so a
 *    flood of random kids cannot turn every request into a JWKS fetch
 *  - iss === team domain, aud contains ACCESS_AUD, exp/nbf/iat with 60 s skew
 *  - a non-empty `email` claim (service tokens carry `common_name` only and are rejected)
 * The plain `Cf-Access-Authenticated-User-Email` header is never read.
 */

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
export const ACCESS_JWT_COOKIE = "CF_Authorization";
export const CLOCK_SKEW_SECONDS = 60;
export const JWKS_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between unknown-kid refetches for one team domain. */
export const JWKS_REFETCH_MIN_MS = 30 * 1000;
const MAX_TOKEN_LENGTH = 16 * 1024;

export interface AccessConfig {
  /** Normalised `https://<team>.cloudflareaccess.com` (no trailing slash). */
  teamDomain: string;
  aud: string;
}

export type AccessVerifyResult = { ok: true; email: string } | { ok: false; reason: string };

/**
 * Normalise ACCESS_TEAM_DOMAIN ("team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/")
 * to a bare https origin, or null when unusable (missing, placeholder, not https, has a path).
 */
export function normaliseTeamDomain(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v || /[<>\s]/.test(v)) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

/** The Access config, or null when either var is missing (caller fails closed with 503). */
export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null {
  const teamDomain = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const aud = env.ACCESS_AUD?.trim();
  if (!teamDomain || !aud || /[<>\s]/.test(aud)) return null;
  return { teamDomain, aud };
}

// ------------------------------------------------------------------ base64url
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ JWKS cache
interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}
interface CacheEntry {
  keys: Map<string, Jwk>;
  fetchedAt: number;
  imported: Map<string, CryptoKey>;
}
const jwksCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

/** Tests only. */
export function resetAccessJwksCache(): void {
  jwksCache.clear();
  inflight.clear();
}

async function fetchJwks(teamDomain: string, doFetch: typeof fetch, nowMs: number): Promise<CacheEntry> {
  const pending = inflight.get(teamDomain);
  if (pending) return pending;
  const p = (async () => {
    const res = await doFetch(`${teamDomain}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const body = (await res.json()) as { keys?: unknown };
    const keys = new Map<string, Jwk>();
    for (const k of Array.isArray(body.keys) ? (body.keys as Jwk[]) : []) {
      if (k && typeof k.kid === "string" && k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string") {
        if (k.use && k.use !== "sig") continue;
        if (k.alg && k.alg !== "RS256") continue;
        keys.set(k.kid, k);
      }
    }
    const entry: CacheEntry = { keys, fetchedAt: nowMs, imported: new Map() };
    jwksCache.set(teamDomain, entry);
    return entry;
  })();
  inflight.set(teamDomain, p);
  try {
    return await p;
  } finally {
    inflight.delete(teamDomain);
  }
}

async function keyFor(teamDomain: string, kid: string, doFetch: typeof fetch, nowMs: number): Promise<CryptoKey | null> {
  let entry = jwksCache.get(teamDomain);
  if (!entry || nowMs - entry.fetchedAt >= JWKS_TTL_MS) {
    try {
      entry = await fetchJwks(teamDomain, doFetch, nowMs);
    } catch {
      // Keep using a stale set if Access is briefly unreachable.
      if (!entry) return null;
    }
  }
  if (!entry.keys.has(kid) && nowMs - entry.fetchedAt >= JWKS_REFETCH_MIN_MS) {
    // Access rotates its signing keys: one refetch on an unknown kid.
    try {
      entry = await fetchJwks(teamDomain, doFetch, nowMs);
    } catch {
      return null;
    }
  }
  const jwk = entry.keys.get(kid);
  if (!jwk) return null;
  const cached = entry.imported.get(kid);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  entry.imported.set(kid, key);
  return key;
}

// ------------------------------------------------------------------ verify
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function verifyAccessJwt(
  token: string,
  cfg: AccessConfig,
  opts: { nowMs: number; fetch?: typeof fetch },
): Promise<AccessVerifyResult> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "kid" };

  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlToBytes(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let key: CryptoKey | null;
  try {
    key = await keyFor(cfg.teamDomain, header.kid, opts.fetch ?? fetch, opts.nowMs);
  } catch {
    key = null;
  }
  if (!key) return { ok: false, reason: "kid" };
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${h}.${p}`));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };

  if (payload.iss !== cfg.teamDomain) return { ok: false, reason: "iss" };
  const aud = payload.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.some((a) => a === cfg.aud)) return { ok: false, reason: "aud" };
  const now = Math.floor(opts.nowMs / 1000);
  const exp = num(payload.exp);
  if (exp === null || exp + CLOCK_SKEW_SECONDS <= now) return { ok: false, reason: "exp" };
  for (const claim of ["nbf", "iat"] as const) {
    if (payload[claim] === undefined) continue;
    const t = num(payload[claim]);
    if (t === null || t - CLOCK_SKEW_SECONDS > now) return { ok: false, reason: claim };
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || email.length > 320) return { ok: false, reason: "email" };
  return { ok: true, email };
}

// ------------------------------------------------------------------ path hardening
/**
 * True for /api and /auth paths that a proxy and the Worker could read differently:
 * encoded dots, slashes or backslashes (%2e, %2f, %5c), raw backslashes, dot segments and
 * empty segments. Access matches bypass paths on the raw path, the Worker's URL parser
 * resolves them, so e.g. `/api/device/%2e%2e/sessions` must never reach a router.
 */
export function isAmbiguousPath(rawUrl: string): boolean {
  // Take the path from the raw string: `new URL()` would already have resolved dot segments.
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(rawUrl);
  const path = m ? m[1]! : rawUrl.split(/[?#]/)[0]!;
  if (!/^\/(api|auth)(\/|$)/i.test(path) && !/^\/(%2e|\.)/i.test(path)) return false;
  if (/%2e|%2f|%5c|\\/i.test(path)) return true;
  if (/\/\.\.?(\/|$)/.test(path)) return true;
  if (/\/\//.test(path)) return true;
  return false;
}
