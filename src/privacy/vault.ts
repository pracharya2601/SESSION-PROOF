/**
 * In-memory token vault (token <-> original). Lives only inside one
 * prepare()/scrubText() call's closures. Values are held in #private fields
 * so JSON.stringify / util.inspect / structured logging never expose them.
 */
import type { PiiType } from "../contracts/v2";

const TOKEN_RE = /\[(NAME|EMAIL|PHONE|SSN|ID|ADDRESS|DATE|CLIENT_REF)_(\d{1,5})\]/g;

function normalize(type: PiiType, value: string): string {
  if (type === "PHONE" || type === "SSN") {
    const digits = value.replace(/\D/g, "");
    return type === "PHONE" && digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  }
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export class PrivacyVault {
  readonly #byKey = new Map<string, string>();
  readonly #byToken = new Map<string, string>();
  readonly #counters = new Map<PiiType, number>();

  /** Same (type, normalized value) always yields the same token. */
  tokenFor(type: PiiType, original: string): string {
    const key = `${type}\u0000${normalize(type, original)}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const n = (this.#counters.get(type) ?? 0) + 1;
    this.#counters.set(type, n);
    const token = `[${type}_${n}]`;
    this.#byKey.set(key, token);
    this.#byToken.set(token, original);
    return token;
  }

  /** Replace known tokens with originals; unknown/invented tokens are left as-is. */
  restore(text: string): string {
    if (this.#byToken.size === 0 || text.indexOf("[") === -1) return text;
    return text.replace(TOKEN_RE, (tok) => this.#byToken.get(tok) ?? tok);
  }

  get size(): number {
    return this.#byToken.size;
  }

  toJSON(): string {
    return "[PrivacyVault redacted]";
  }
  toString(): string {
    return "[PrivacyVault redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[PrivacyVault redacted]";
  }
}
