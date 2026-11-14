/**
 * Shared HTTP plumbing for inference providers: 30s timeout combined with the
 * caller's signal, and uniform status → InferenceError mapping. Request and
 * response bodies are never logged or included in error messages.
 */
import { InferenceError, type AiProviderId } from "../../contracts/v2";

export const PROVIDER_TIMEOUT_MS = 30_000;

export type FetchFn = typeof fetch;

export interface ProviderOptions {
  fetch?: FetchFn;
  /** Override the per-request timeout (tests). */
  timeoutMs?: number;
}

export function defaultFetch(): FetchFn {
  return (input, init) => fetch(input, init);
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Parses Retry-After (delta seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeout, timeout };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any([signal, timeout]), timeout };
  const ctl = new AbortController();
  const abort = (s: AbortSignal) => () => ctl.abort(s.reason);
  if (signal.aborted) ctl.abort(signal.reason);
  signal.addEventListener("abort", abort(signal), { once: true });
  timeout.addEventListener("abort", abort(timeout), { once: true });
  return { signal: ctl.signal, timeout };
}

/** POST JSON and return the parsed JSON response body, or throw InferenceError. */
export async function postJson(
  provider: AiProviderId,
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<unknown> {
  const { signal, timeout } = combineSignals(opts.timeoutMs ?? PROVIDER_TIMEOUT_MS, opts.signal);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (timeout.aborted || (err instanceof Error && err.name === "TimeoutError")) {
      throw new InferenceError(`${provider} request timed out`, "timeout", true);
    }
    if (opts.signal?.aborted) throw new InferenceError(`${provider} request aborted`, "provider", false);
    throw new InferenceError(`${provider} request failed (network)`, "provider", true);
  }
  if (!res.ok) {
    // Drain without reading into messages/logs.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    const s = res.status;
    if (s === 401 || s === 403) throw new InferenceError(`${provider} rejected the API key (${s})`, "auth", false);
    if (s === 429) {
      throw new InferenceError(`${provider} rate limited (429)`, "rate_limited", true, parseRetryAfter(res.headers.get("retry-after")));
    }
    if (s === 408) throw new InferenceError(`${provider} request timed out (408)`, "timeout", true);
    if (s >= 500) throw new InferenceError(`${provider} returned ${s}`, "provider", true);
    throw new InferenceError(`${provider} returned ${s}`, "provider", false);
  }
  try {
    return await res.json();
  } catch {
    throw new InferenceError(`${provider} response is not valid JSON`, "invalid_output", true);
  }
}

export function notConfigured(provider: AiProviderId, keyName: string): InferenceError {
  return new InferenceError(`${keyName} is not configured for ${provider}`, "not_configured", false);
}

export function invalidOutput(provider: AiProviderId, what: string): InferenceError {
  return new InferenceError(`${provider} ${what}`, "invalid_output", true);
}

/** Parse a JSON string produced by a model; throws invalid_output when unparsable. */
export function parseModelJson(provider: AiProviderId, text: unknown): unknown {
  if (typeof text !== "string") throw invalidOutput(provider, "returned no structured output");
  try {
    return JSON.parse(text);
  } catch {
    throw invalidOutput(provider, "returned unparsable JSON output");
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
