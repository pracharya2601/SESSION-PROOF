/**
 * Shared HTTP plumbing for the cloud adapters: bearer auth, error mapping,
 * bounded retry with backoff. Never logs or embeds tokens / file contents in
 * errors — only the provider's short error message (truncated).
 */

export type CloudErrorCode = "auth" | "rate_limited" | "not_found" | "quota" | "provider";

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: CloudErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

/** Caller-side input rejected before any request (header injection, bad email, bad name). */
export class CloudInputError extends CloudApiError {
  constructor(message: string) {
    super(400, "provider", message, false);
    this.name = "CloudInputError";
  }
}

export interface CloudAdapterOptions {
  /** Injectable for tests. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries on retryable failures (default 2, capped at 2). */
  maxRetries?: number;
  /** Base backoff in ms (default 500; doubles per attempt). */
  baseDelayMs?: number;
  /** MIME determinism for tests. */
  now?: () => Date;
  messageId?: () => string;
  boundary?: () => string;
}

const MAX_RETRY_AFTER_MS = 10_000;

export interface RequestInit2 {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Statuses returned to the caller instead of throwing (e.g. 404 lookups, 409 races). */
  allow?: number[];
  /** Omit the Authorization header (pre-authenticated upload URLs). */
  noAuth?: boolean;
}

export class CloudHttp {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly label: string,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch,
    opts: CloudAdapterOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = Math.max(0, Math.min(2, opts.maxRetries ?? 2));
    this.baseDelayMs = opts.baseDelayMs ?? 500;
  }

  async request(url: string, init: RequestInit2): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const headers: Record<string, string> = { ...(init.headers ?? {}) };
        if (!init.noAuth) headers.Authorization = `Bearer ${this.accessToken}`;
        const doFetch = this.fetchImpl; // unbound call: workerd rejects fetch with a foreign `this`
        res = await doFetch(url, { method: init.method, headers, body: init.body as BodyInit | undefined });
      } catch {
        const err = new CloudApiError(0, "provider", `${this.label}: network error`, true);
        if (attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
      if (res.ok || init.allow?.includes(res.status)) return res;
      const err = await mapError(this.label, res);
      if (err.retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(res, this.baseDelayMs * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }

  async json<T>(url: string, init: RequestInit2): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }
}

function retryDelay(res: Response, fallback: number): number {
  const h = res.headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return fallback;
}

interface ProviderErrorBody {
  error?: {
    message?: string;
    code?: string | number;
    status?: string;
    errors?: { reason?: string }[];
    details?: { reason?: string }[];
  };
}

export async function mapError(label: string, res: Response): Promise<CloudApiError> {
  let body: ProviderErrorBody = {};
  try {
    body = (await res.json()) as ProviderErrorBody;
  } catch {
    /* non-JSON error body */
  }
  const e = body.error ?? {};
  const reasons = [
    ...(e.errors ?? []).map((x) => x.reason),
    ...(e.details ?? []).map((x) => x.reason),
    typeof e.code === "string" ? e.code : undefined,
    e.status,
  ].filter((x): x is string => typeof x === "string");
  const detail = typeof e.message === "string" ? `: ${e.message.slice(0, 200)}` : "";
  const msg = `${label} failed (HTTP ${res.status})${detail}`;
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));
  const s = res.status;

  if (has("storageQuotaExceeded", "quotaLimitReached", "insufficientStorage") || s === 507) {
    return new CloudApiError(s, "quota", msg, false);
  }
  if (s === 429 || (s === 403 && has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED"))) {
    return new CloudApiError(s, "rate_limited", msg, true);
  }
  if (s === 401 || s === 403) return new CloudApiError(s, "auth", msg, false);
  if (s === 404) return new CloudApiError(s, "not_found", msg, false);
  if (s >= 500) return new CloudApiError(s, "provider", msg, true);
  return new CloudApiError(s, "provider", msg, false);
}

// ------------------------------------------------------------------ validation

const CTL = /[\u0000-\u001f\u007f]/;

export function assertNoControl(what: string, value: string): void {
  if (CTL.test(value)) throw new CloudInputError(`${what} contains control characters (CR/LF not allowed)`);
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function assertEmail(addr: string): void {
  assertNoControl("Recipient", addr);
  if (addr.length > 254 || !EMAIL_RE.test(addr)) throw new CloudInputError("Invalid recipient email address");
}

export function assertFilename(name: string): void {
  if (!name || name.length > 255) throw new CloudInputError("Invalid file name");
  assertNoControl("File name", name);
}

export function assertContentType(ct: string): void {
  assertNoControl("Content type", ct);
  if (!/^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(ct)) throw new CloudInputError("Invalid content type");
}

export interface DraftInput {
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  attachments: { filename: string; contentType: string; bytes: Uint8Array }[];
}

export function validateDraft(d: DraftInput): void {
  if (d.to.length === 0) throw new CloudInputError("At least one recipient is required");
  for (const a of [...d.to, ...d.cc]) assertEmail(a);
  assertNoControl("Subject", d.subject);
  for (const a of d.attachments) {
    assertFilename(a.filename);
    assertContentType(a.contentType);
  }
}

export function splitPath(path: string): string[] {
  const segs = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of segs) {
    assertNoControl("Folder name", s);
    if (s === "." || s === "..") throw new CloudInputError("Folder path may not contain '.' or '..'");
  }
  return segs;
}

// ------------------------------------------------------------------ base64

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
