/**
 * Device keys: "vfad_" + base64url(32 random bytes) (43 chars). The server stores only the
 * SHA-256 hex of the full key. Never log a key.
 */
import { DEVICE_KEY_PREFIX } from "../contracts/devices";

const KEY_RE = /^vfad_[A-Za-z0-9_-]{43}$/;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateDeviceKey(): string {
  return `${DEVICE_KEY_PREFIX}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** Well-formed device key (prefix + 43 base64url chars). */
export function isDeviceKey(value: string): boolean {
  return KEY_RE.test(value);
}

/** SHA-256 of the full key, lowercase hex (64 chars). */
export async function hashDeviceKey(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  let hex = "";
  for (let i = 0; i < digest.length; i++) hex += digest[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** The device key from an `Authorization: Bearer vfad_…` header, or null. */
export function bearerDeviceKey(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const key = m?.[1];
  return key && key.startsWith(DEVICE_KEY_PREFIX) ? key : null;
}
