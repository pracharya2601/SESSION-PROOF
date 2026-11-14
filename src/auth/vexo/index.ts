/**
 * Vexo authorization seam (Agent 06).
 *
 * The live Vexo connection (OAuth flow + MCP transport) is intentionally out of
 * scope here; see README.md for what the real connection must implement. This
 * module provides:
 *  - the `VexoTokenProvider` port consumed by the Vexo integration,
 *  - a `notConfiguredTokenProvider` default,
 *  - pure, tested security helpers the real connection will need.
 */
import { EvidenceUnavailableError } from "../../contracts";

// ------------------------------------------------------------------ port

export interface VexoTokenProvider {
  /** Returns a valid access token for the app user / provider. Never expose to the browser. */
  getAccessToken(providerId: string): Promise<string>;
  connectionStatus(providerId: string): Promise<{ connected: boolean; detail: string }>;
}

export const notConfiguredTokenProvider: VexoTokenProvider = {
  async getAccessToken(_providerId: string): Promise<string> {
    throw new EvidenceUnavailableError(
      "Vexo connection is not configured",
      "not_configured",
      false,
    );
  },
  async connectionStatus(_providerId: string) {
    return { connected: false, detail: "Vexo connection is not configured" };
  },
};

// ------------------------------------------------------------------ errors

export type VexoAuthErrorCode =
  | "invalid_state"
  | "state_expired"
  | "state_binding"
  | "unsafe_redirect"
  | "issuer_mismatch";

export class VexoAuthError extends Error {
  constructor(
    readonly code: VexoAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VexoAuthError";
  }
}

// ------------------------------------------------------------------ encoding

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// ------------------------------------------------------------------ PKCE (RFC 7636, S256)

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  // 32 random bytes -> 43-char base64url verifier (within the 43..128 range).
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = await pkceChallenge(codeVerifier);
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

export async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

// ------------------------------------------------------------------ OAuth state

/**
 * State format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payload))>`.
 * Payload: { v: 1, p: providerId (app user), iat: issued-at seconds, n: nonce }.
 *
 * HMAC + timestamp make it unforgeable, user-bound and time-limited. It is NOT
 * one-time by itself: the caller must persist `nonce` (e.g. D1/KV with TTL =
 * maxAgeSec) when starting the flow and atomically consume it on callback.
 */
interface StatePayload {
  v: 1;
  p: string;
  iat: number;
  n: string;
}

export interface VerifiedOAuthState {
  providerId: string;
  nonce: string;
  issuedAt: number; // epoch seconds
}

function toEpochSec(now: Date | number): number {
  return Math.floor((typeof now === "number" ? now : now.getTime()) / 1000);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("OAuth state secret is required");
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `now` is a Date or epoch milliseconds. */
export async function createOAuthState(
  providerId: string,
  secret: string,
  now: Date | number,
): Promise<{ state: string; nonce: string }> {
  if (!providerId) throw new Error("providerId is required");
  const payload: StatePayload = {
    v: 1,
    p: providerId,
    iat: toEpochSec(now),
    n: base64UrlEncode(randomBytes(16)),
  };
  const body = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return { state: `${body}.${base64UrlEncode(new Uint8Array(sig))}`, nonce: payload.n };
}

/** Throws VexoAuthError on any failure. Does not enforce one-time use (see above). */
export async function verifyOAuthState(
  state: string,
  providerId: string,
  secret: string,
  now: Date | number,
  maxAgeSec = 600,
): Promise<VerifiedOAuthState> {
  const parts = typeof state === "string" ? state.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new VexoAuthError("invalid_state", "Malformed state");
  }
  const [body, sigText] = parts as [string, string];
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlDecode(sigText);
  } catch {
    throw new VexoAuthError("invalid_state", "Malformed state signature");
  }
  // crypto.subtle.verify is constant-time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) throw new VexoAuthError("invalid_state", "State signature invalid");

  let payload: StatePayload;
  try {
    payload = JSON.parse(dec.decode(base64UrlDecode(body))) as StatePayload;
  } catch {
    throw new VexoAuthError("invalid_state", "Malformed state payload");
  }
  if (
    payload?.v !== 1 ||
    typeof payload.p !== "string" ||
    typeof payload.n !== "string" ||
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat)
  ) {
    throw new VexoAuthError("invalid_state", "Invalid state payload");
  }
  if (payload.p !== providerId) {
    throw new VexoAuthError("state_binding", "State was issued to a different user");
  }
  const nowSec = toEpochSec(now);
  const age = nowSec - payload.iat;
  // Allow 30s clock skew into the future; anything older than maxAge is expired.
  if (age > maxAgeSec || age < -30) {
    throw new VexoAuthError("state_expired", "State expired");
  }
  return { providerId: payload.p, nonce: payload.n, issuedAt: payload.iat };
}

// ------------------------------------------------------------------ redirect / issuer

/**
 * Resolves `url` (absolute or path-relative) against `appOrigin` and requires the
 * result to be same-origin http(s). Returns the normalized absolute URL.
 */
export function assertSafeRedirect(url: string, appOrigin: string): string {
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new VexoAuthError("unsafe_redirect", "Invalid app origin");
  }
  if (typeof url !== "string" || url.trim() === "" || /[\\\u0000-\u001f]/.test(url)) {
    throw new VexoAuthError("unsafe_redirect", "Unsafe redirect target");
  }
  let target: URL;
  try {
    target = new URL(url, origin.origin);
  } catch {
    throw new VexoAuthError("unsafe_redirect", "Invalid redirect target");
  }
  if (
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.origin !== origin.origin ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new VexoAuthError("unsafe_redirect", "Redirect target is not same-origin");
  }
  return target.toString();
}

/** RFC 8414 / RFC 9207: issuer must match exactly (simple string comparison). */
export function assertIssuer(expected: string, actual: string | null | undefined): void {
  if (!expected || typeof actual !== "string" || actual !== expected) {
    throw new VexoAuthError("issuer_mismatch", "Authorization server issuer mismatch");
  }
}
