/**
 * Recording fetch: captures every outbound inference request body (for PII-leak and
 * injection inspection), latency and token usage. Headers are NEVER stored (they hold keys).
 * In fake mode it answers with the fake model; in live mode it forwards to the real fetch.
 */
import type { AiProviderId } from "../../src/contracts/v2";
import { TOOL_NAME } from "../../src/ai/index";
import { fakeFacts, providerResponse, userTextFromBody } from "./fake-model";
import type { EvalCase } from "./types";

export interface CallRecord {
  url: string;
  /** Exact JSON body the adapter sent. Kept in memory only (never written to reports). */
  body: string;
  requestBytes: number;
  responseBytes: number;
  status: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  error?: string;
}

export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function usageOf(provider: AiProviderId, json: any): { inTok: number; outTok: number } | null {
  if (!json || typeof json !== "object") return null;
  if (provider === "anthropic" && json.usage) return { inTok: json.usage.input_tokens ?? 0, outTok: json.usage.output_tokens ?? 0 };
  if ((provider === "openai" || provider === "mistral") && json.usage) return { inTok: json.usage.prompt_tokens ?? 0, outTok: json.usage.completion_tokens ?? 0 };
  if (provider === "gemini" && json.usageMetadata) return { inTok: json.usageMetadata.promptTokenCount ?? 0, outTok: json.usageMetadata.candidatesTokenCount ?? 0 };
  return null;
}

export function recordingFetch(opts: {
  provider: AiProviderId;
  model: string;
  mode: "fake" | "live";
  def: EvalCase;
  realFetch?: typeof fetch;
  /** Eval-only: rewrite the outbound body before forwarding (e.g. max_tokens → max_completion_tokens). */
  rewriteBody?: (body: string) => string;
}): { fetch: typeof fetch; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    const t0 = performance.now();
    const rec: CallRecord = { url: url.replace(/key=[^&]+/g, "key=REDACTED"), body, requestBytes: body.length, responseBytes: 0, status: 0, ms: 0, inputTokens: 0, outputTokens: 0, tokensEstimated: true };
    calls.push(rec);
    if (opts.mode === "fake") {
      const parsed = JSON.parse(body || "{}");
      const facts = fakeFacts(userTextFromBody(opts.provider, parsed), opts.def);
      const outText = JSON.stringify(facts);
      const inTok = estimateTokens(body.length);
      const outTok = estimateTokens(outText.length);
      const resBody = JSON.stringify(providerResponse(opts.provider, `fake-${opts.model}`, TOOL_NAME, facts, inTok, outTok));
      Object.assign(rec, { responseBytes: resBody.length, status: 200, ms: performance.now() - t0, inputTokens: inTok, outputTokens: outTok, tokensEstimated: true });
      return new Response(resBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    const real = opts.realFetch ?? fetch;
    try {
      const res = await real(input, opts.rewriteBody && init ? { ...init, body: opts.rewriteBody(body) } : init);
      const text = await res.clone().text();
      rec.status = res.status;
      rec.responseBytes = text.length;
      rec.ms = performance.now() - t0;
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      const u = usageOf(opts.provider, json);
      if (u) Object.assign(rec, { inputTokens: u.inTok, outputTokens: u.outTok, tokensEstimated: false });
      else Object.assign(rec, { inputTokens: estimateTokens(body.length), outputTokens: 0 });
      if (!res.ok) {
        // Error bodies from providers carry messages only (no secrets); keep a short code.
        const msg = (json as any)?.error?.message ?? (json as any)?.error?.code ?? "";
        rec.error = `${res.status} ${String(msg).slice(0, 200)}`;
      }
      return res;
    } catch (err) {
      rec.ms = performance.now() - t0;
      rec.error = err instanceof Error ? err.name : "fetch_error";
      throw err;
    }
  }) as typeof fetch;
  return { fetch: fn, calls };
}
