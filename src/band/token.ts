/**
 * Short-lived stream token for one visit, so a native bridge (GlassCam on iPhone)
 * can stream without the browser's cookie. HMAC-signed with a key derived from
 * SESSION_SECRET; it only authorizes streaming audio into that one visit.
 * A stream token can never be used as a login cookie (different key, and the
 * identity "visit:<id>" maps to no provider).
 */
import { signSession, verifySession } from "../security";

export const STREAM_TOKEN_TTL_SECONDS = 4 * 60 * 60;

function streamSecret(sessionSecret: string): string {
  return `${sessionSecret}:band-visit-stream:v1`;
}

export async function signStreamToken(
  args: { providerId: string; visitId: string; nowMs: number },
  sessionSecret: string,
): Promise<{ token: string; expiresAt: string }> {
  const exp = Math.floor(args.nowMs / 1000) + STREAM_TOKEN_TTL_SECONDS;
  const token = await signSession({ providerId: args.providerId, identity: `visit:${args.visitId}`, exp }, streamSecret(sessionSecret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The provider id the token was issued to, or null if invalid, expired or for another visit. */
export async function verifyStreamToken(
  token: string,
  visitId: string,
  sessionSecret: string,
  nowMs: number,
): Promise<string | null> {
  const p = await verifySession(token, streamSecret(sessionSecret), nowMs);
  if (!p || p.identity !== `visit:${visitId}`) return null;
  return p.providerId;
}
