/**
 * Review-link tokens: "vfrl_" + base64url(32 bytes) (43 chars).
 *
 * The 32 bytes are HMAC-SHA256(key, "review-link:v1:<linkId>") where the key is derived from
 * SESSION_SECRET and the link id carries 16 random bytes. So a token is unguessable, the DB
 * stores only SHA-256(token) (hex), and the server, never the DB alone, can rebuild the same URL
 * for the phone inbox. Rotating SESSION_SECRET makes rebuilt tokens differ: callers check the
 * hash and mint a fresh link (old URLs keep working until they expire, as their hash is stored).
 * Never log a token.
 */
export const REVIEW_LINK_PREFIX = "vfrl_";
const TOKEN_RE = /^vfrl_[A-Za-z0-9_-]{43}$/;
const MIN_SECRET_LENGTH = 32;
const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

export function isReviewToken(value: string | undefined | null): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** `rl_` + 22 base64url chars (16 random bytes). */
export function newReviewLinkId(): string {
  return `rl_${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** The secret review-link tokens are derived from, or null when SESSION_SECRET is unusable. */
export function reviewLinkSecret(env: { SESSION_SECRET?: string }): string | null {
  const s = env.SESSION_SECRET;
  return typeof s === "string" && s.length >= MIN_SECRET_LENGTH ? `${s}:review-link:v1` : null;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(message)));
}

export async function deriveReviewToken(secret: string, linkId: string): Promise<string> {
  return `${REVIEW_LINK_PREFIX}${b64url(await hmac(secret, `review-link:v1:${linkId}`))}`;
}

/** SHA-256 of the full token, lowercase hex. */
export async function hashReviewToken(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(token))));
}
