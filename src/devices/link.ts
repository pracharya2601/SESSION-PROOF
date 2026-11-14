/**
 * Pairing link: glasscam://pair?server=<origin>&key=<key>&name=<name>
 * `server` is the http(s) origin the phone calls: PUBLIC_APP_ORIGIN, else PUBLIC_STREAM_ORIGIN
 * with ws→http / wss→https, else APP_ORIGIN. `server` (an origin) and `key` (base64url) are URL-safe
 * and go in as is; `name` is percent-encoded (encodeURIComponent).
 */
import type { Env } from "../env";

function httpOrigin(raw: string | undefined, protocols: Record<string, string>): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    const proto = protocols[u.protocol];
    if (proto && u.host) return `${proto}//${u.host}`;
  } catch {
    /* invalid */
  }
  return null;
}

export function devicePublicOrigin(env: Pick<Env, "PUBLIC_APP_ORIGIN" | "PUBLIC_STREAM_ORIGIN" | "APP_ORIGIN">): string {
  return (
    httpOrigin(env.PUBLIC_APP_ORIGIN, { "http:": "http:", "https:": "https:" }) ??
    httpOrigin(env.PUBLIC_STREAM_ORIGIN, { "ws:": "http:", "wss:": "https:" }) ??
    httpOrigin(env.APP_ORIGIN, { "http:": "http:", "https:": "https:" }) ??
    env.APP_ORIGIN
  );
}

export function pairingLink(args: { server: string; key: string; name: string }): string {
  return `glasscam://pair?server=${args.server}&key=${args.key}&name=${encodeURIComponent(args.name)}`;
}
