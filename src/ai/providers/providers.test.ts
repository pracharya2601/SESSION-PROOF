import { describe, expect, it } from "vitest";
import { InferenceError, type AiProviderId, type InferenceRequest } from "../../contracts/v2";
import type { Env } from "../../env";
import { jsonSchemaSessionFacts } from "../../contracts/jsonSchema";
import {
  aiProviderStatuses,
  apiKeyFor,
  createInferenceProvider,
  isOpenAiReasoningModel,
  parseRetryAfter,
  PROVIDER_TIMEOUT_MS,
  REASONING_PROVIDER_TIMEOUT_MS,
  resolveProviderTimeoutMs,
  toGeminiSchema,
} from "./index";

function env(over: Partial<Env> = {}): Env {
  return {
    EXTRACTION_MODE: "live",
    EVIDENCE_MODE: "fixture",
    AI_MODEL: "m",
    AUTH_MODE: "dev",
    APP_ORIGIN: "http://localhost",
    RUNTIME_MODE: "local",
    ANTHROPIC_API_KEY: "ak",
    OPENAI_API_KEY: "ok",
    GEMINI_API_KEY: "gk",
    MISTRAL_API_KEY: "mk",
    ...over,
  } as Env;
}

const req: InferenceRequest = {
  system: "SYS",
  user: "USER",
  tool: { name: "record_x", description: "desc", inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
  maxTokens: 123,
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init ?? {});
    return next;
  }) as typeof fetch;
  return { fn, calls };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const okBody: Record<AiProviderId, unknown> = {
  anthropic: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "record_x", input: { a: "1" } }] },
  openai: { model: "gpt-x-2026", choices: [{ message: { tool_calls: [{ type: "function", function: { name: "record_x", arguments: '{"a":"1"}' } }] } }] },
  gemini: { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '"1"}' }] } }] },
  mistral: { choices: [{ message: { tool_calls: [{ function: { name: "record_x", arguments: '{"a":"1"}' } }] } }] },
};
const PROVIDERS: AiProviderId[] = ["anthropic", "openai", "gemini", "mistral"];

async function kindOf(p: Promise<unknown>): Promise<{ kind: string; retryable: boolean; retryAfterMs?: number } | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof InferenceError) return { kind: e.kind, retryable: e.retryable, retryAfterMs: e.retryAfterMs };
    throw e;
  }
}

describe("request shapes", () => {
  it("anthropic", async () => {
    const { fn, calls } = fakeFetch([json(okBody.anthropic)]);
    const out = await createInferenceProvider(env({ ANTHROPIC_API_KEY: undefined, AI_API_KEY: "legacy" }), { provider: "anthropic", model: "claude-z" }, { fetch: fn }).generateStructured(req);
    expect(out).toEqual({ output: { a: "1" }, provider: "anthropic", model: "claude-z" });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.init.method).toBe("POST");
    const h = c.init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("legacy");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    const b = JSON.parse(String(c.init.body));
    expect(b).toEqual({
      model: "claude-z",
      max_tokens: 123,
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
      tools: [{ name: "record_x", description: "desc", input_schema: req.tool.inputSchema }],
      tool_choice: { type: "tool", name: "record_x" },
    });
  });

  it("anthropic prefers ANTHROPIC_API_KEY and honours AI_GATEWAY_URL", async () => {
    const { fn, calls } = fakeFetch([json(okBody.anthropic)]);
    await createInferenceProvider(env({ AI_API_KEY: "legacy", AI_GATEWAY_URL: "https://gw/x/" }), { provider: "anthropic", model: "c" }, { fetch: fn }).generateStructured(req);
    expect(calls[0]!.url).toBe("https://gw/x/v1/messages");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("ak");
  });

  it("openai", async () => {
    const { fn, calls } = fakeFetch([json(okBody.openai)]);
    const out = await createInferenceProvider(env(), { provider: "openai", model: "gpt-4.1" }, { fetch: fn }).generateStructured(req);
    expect(out).toEqual({ output: { a: "1" }, provider: "openai", model: "gpt-x-2026" });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer ok");
    const b = JSON.parse(String(calls[0]!.init.body));
    expect(b.model).toBe("gpt-4.1");
    expect(b.max_tokens).toBe(123);
    expect(b.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
    expect(b.tools).toEqual([{ type: "function", function: { name: "record_x", description: "desc", parameters: req.tool.inputSchema } }]);
    expect(b.tool_choice).toEqual({ type: "function", function: { name: "record_x" } });
  });

  it("openai base url override", async () => {
    const { fn, calls } = fakeFetch([json(okBody.openai)]);
    await createInferenceProvider(env({ OPENAI_BASE_URL: "https://gw/openai/" }), { provider: "openai", model: "g" }, { fetch: fn }).generateStructured(req);
    expect(calls[0]!.url).toBe("https://gw/openai/chat/completions");
  });

  it("gemini", async () => {
    const { fn, calls } = fakeFetch([json(okBody.gemini)]);
    const out = await createInferenceProvider(env(), { provider: "gemini", model: "gemini-2.5-flash" }, { fetch: fn }).generateStructured(req);
    expect(out).toEqual({ output: { a: "1" }, provider: "gemini", model: "gemini-2.5-flash" });
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["x-goog-api-key"]).toBe("gk");
    expect(calls[0]!.url).not.toContain("key=");
    const b = JSON.parse(String(calls[0]!.init.body));
    expect(b.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    expect(b.contents).toEqual([{ role: "user", parts: [{ text: "USER" }] }]);
    expect(b.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { a: { type: "STRING" } }, propertyOrdering: ["a"], required: ["a"] },
      maxOutputTokens: 123,
    });
  });

  it("mistral", async () => {
    const { fn, calls } = fakeFetch([json(okBody.mistral)]);
    const out = await createInferenceProvider(env({ MISTRAL_BASE_URL: "https://m.example/v1" }), { provider: "mistral", model: "mistral-large-latest" }, { fetch: fn }).generateStructured(req);
    expect(out).toEqual({ output: { a: "1" }, provider: "mistral", model: "mistral-large-latest" });
    expect(calls[0]!.url).toBe("https://m.example/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer mk");
    const b = JSON.parse(String(calls[0]!.init.body));
    expect(b.tool_choice).toBe("any");
    expect(b.tools[0]).toEqual({ type: "function", function: { name: "record_x", description: "desc", parameters: req.tool.inputSchema } });
    expect(b.messages[0]).toEqual({ role: "system", content: "SYS" });
  });

  it("mistral accepts object arguments", async () => {
    const { fn } = fakeFetch([json({ choices: [{ message: { tool_calls: [{ function: { name: "record_x", arguments: { a: "2" } } }] } }] })]);
    const out = await createInferenceProvider(env(), { provider: "mistral", model: "m" }, { fetch: fn }).generateStructured(req);
    expect(out.output).toEqual({ a: "2" });
  });
});

describe.each(PROVIDERS)("error mapping: %s", (provider) => {
  const run = (responses: Parameters<typeof fakeFetch>[0], e: Partial<Env> = {}, opts: { timeoutMs?: number } = {}) => {
    const f = fakeFetch(responses);
    return { p: createInferenceProvider(env(e), { provider, model: "m" }, { fetch: f.fn, ...opts }).generateStructured(req), calls: f.calls };
  };

  it("missing key → not_configured without fetching", async () => {
    const keyName = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", mistral: "MISTRAL_API_KEY" }[provider];
    const { p, calls } = run([json(okBody[provider])], { [keyName]: undefined, AI_API_KEY: undefined } as Partial<Env>);
    expect(await kindOf(p)).toEqual({ kind: "not_configured", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("401/403 → auth, not retryable", async () => {
    expect(await kindOf(run([json({ error: "secret-ish body" }, 401)]).p)).toEqual({ kind: "auth", retryable: false });
    expect(await kindOf(run([json({}, 403)]).p)).toEqual({ kind: "auth", retryable: false });
  });

  it("429 → rate_limited with retryAfterMs", async () => {
    expect(await kindOf(run([json({}, 429, { "retry-after": "3" })]).p)).toEqual({ kind: "rate_limited", retryable: true, retryAfterMs: 3000 });
    expect(await kindOf(run([json({}, 429)]).p)).toEqual({ kind: "rate_limited", retryable: true, retryAfterMs: undefined });
  });

  it("5xx and network → provider retryable; other 4xx → provider not retryable", async () => {
    expect(await kindOf(run([json({}, 503)]).p)).toEqual({ kind: "provider", retryable: true });
    expect(await kindOf(run([new TypeError("fetch failed")]).p)).toEqual({ kind: "provider", retryable: true });
    expect(await kindOf(run([json({}, 400)]).p)).toEqual({ kind: "provider", retryable: false });
  });

  it("timeout → timeout retryable", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, rej) => {
        init.signal?.addEventListener("abort", () => rej(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
      });
    expect(await kindOf(run([hang], {}, { timeoutMs: 5 }).p)).toEqual({ kind: "timeout", retryable: true });
  });

  it("caller abort is honoured (combined signal)", async () => {
    const ctl = new AbortController();
    const f = fakeFetch([
      (init) =>
        new Promise<Response>((_, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
          ctl.abort();
        }),
    ]);
    const p = createInferenceProvider(env(), { provider, model: "m" }, { fetch: f.fn }).generateStructured({ ...req, signal: ctl.signal });
    expect(await kindOf(p)).toEqual({ kind: "provider", retryable: false });
  });

  it("unparsable response body / missing structured output → invalid_output", async () => {
    expect(await kindOf(run([new Response("<html>", { status: 200 })]).p)).toMatchObject({ kind: "invalid_output" });
    expect(await kindOf(run([json({})]).p)).toMatchObject({ kind: "invalid_output" });
  });

  it("error messages never include response bodies", async () => {
    try {
      await run([json({ error: { message: "LEAKED-BODY" } }, 400)]).p;
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("LEAKED");
    }
  });
});

describe("unparsable model JSON → invalid_output", () => {
  it.each([
    ["openai", { choices: [{ message: { tool_calls: [{ function: { name: "record_x", arguments: "{bad" } }] } }] }],
    ["mistral", { choices: [{ message: { tool_calls: [{ function: { name: "record_x", arguments: "{bad" } }] } }] }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "not json" }] } }] }],
  ] as const)("%s", async (provider, body) => {
    const { fn } = fakeFetch([json(body)]);
    expect(await kindOf(createInferenceProvider(env(), { provider, model: "m" }, { fetch: fn }).generateStructured(req))).toEqual({
      kind: "invalid_output",
      retryable: true,
      retryAfterMs: undefined,
    });
  });
});

describe("toGeminiSchema", () => {
  it("strips unsupported keywords and upper-cases types", () => {
    const out = toGeminiSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        s: { type: "string", minLength: 1, maxLength: 5, pattern: "x", title: "t" },
        n: { type: ["integer", "null"], minimum: 0, maximum: 9 },
        e: { enum: ["a", "b"] },
        c: { const: "only" },
        arr: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 3 },
        u: { anyOf: [{ type: "string" }, { type: "boolean" }] },
      },
      required: ["s"],
    });
    expect(out).toEqual({
      type: "OBJECT",
      properties: {
        s: { type: "STRING" },
        n: { type: "INTEGER", nullable: true, minimum: 0, maximum: 9 },
        e: { type: "STRING", enum: ["a", "b"] },
        c: { type: "STRING", enum: ["only"] },
        arr: { type: "ARRAY", items: { type: "NUMBER" }, minItems: 1, maxItems: 3 },
        u: { anyOf: [{ type: "STRING" }, { type: "BOOLEAN" }] },
      },
      propertyOrdering: ["s", "n", "e", "c", "arr", "u"],
      required: ["s"],
    });
  });

  it("converts the SessionFacts schema with no forbidden keywords left", () => {
    const out = toGeminiSchema(jsonSchemaSessionFacts);
    const text = JSON.stringify(out);
    for (const k of ["additionalProperties", "$schema", "maxLength", "minLength"]) expect(text).not.toContain(k);
    expect(out.type).toBe("OBJECT");
    const props = out.properties as Record<string, Record<string, unknown>>;
    const claim = (props.activities!.items as Record<string, unknown>);
    expect(claim.required).toEqual(["id", "text", "evidenceIds", "support"]);
    expect((claim.properties as Record<string, Record<string, unknown>>).support).toEqual({
      type: "STRING",
      enum: ["supported", "uncertain", "provider_confirmed"],
    });
  });
});

describe("apiKeyFor / aiProviderStatuses", () => {
  it("anthropic falls back to legacy AI_API_KEY; blanks count as missing", () => {
    expect(apiKeyFor(env({ ANTHROPIC_API_KEY: undefined, AI_API_KEY: "x" }), "anthropic")).toBe("x");
    expect(apiKeyFor(env({ OPENAI_API_KEY: "" }), "openai")).toBeUndefined();
  });

  it("lists all four providers with labels, models and configured flags", () => {
    const s = aiProviderStatuses(env({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, AI_API_KEY: "legacy" }));
    expect(s.map((x) => [x.provider, x.configured])).toEqual([
      ["anthropic", true],
      ["openai", false],
      ["gemini", true],
      ["mistral", true],
    ]);
    expect(s[0]).toEqual({ provider: "anthropic", label: "Anthropic Claude", configured: true, models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] });
    expect(s[2]!.label).toBe("Google Gemini");
    expect(s[3]!.models).toContain("mistral-large-latest");
    expect(JSON.stringify(s)).not.toContain("legacy");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
    const now = Date.parse("2026-11-13T00:00:00Z");
    expect(parseRetryAfter("Fri, 13 Nov 2026 00:00:05 GMT", now)).toBe(5000);
  });
});

describe("OpenAI reasoning models + timeouts", () => {
  it("gpt-5* / o* send max_completion_tokens (never max_tokens); others keep max_tokens", async () => {
    for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.1", "o3-mini", "o4-mini", "o1"]) {
      const { fn, calls } = fakeFetch([json(okBody.openai)]);
      await createInferenceProvider(env(), { provider: "openai", model }, { fetch: fn }).generateStructured(req);
      const b = JSON.parse(String(calls[0]!.init.body));
      expect(b.max_tokens, model).toBeUndefined();
      expect(b.max_completion_tokens, model).toBeGreaterThanOrEqual(123);
    }
    for (const model of ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "omni-custom"]) {
      const { fn, calls } = fakeFetch([json(okBody.openai)]);
      await createInferenceProvider(env(), { provider: "openai", model }, { fetch: fn }).generateStructured(req);
      const b = JSON.parse(String(calls[0]!.init.body));
      expect(b.max_tokens, model).toBe(123);
      expect(b.max_completion_tokens, model).toBeUndefined();
    }
    expect(isOpenAiReasoningModel("openai/gpt-5-mini")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-50")).toBe(false);
  });

  it("timeout: AI_TIMEOUT_MS when valid, else 90 s for reasoning models, else 30 s", () => {
    expect(resolveProviderTimeoutMs(undefined, false)).toBe(PROVIDER_TIMEOUT_MS);
    expect(PROVIDER_TIMEOUT_MS).toBe(30_000);
    expect(resolveProviderTimeoutMs(undefined, true)).toBe(REASONING_PROVIDER_TIMEOUT_MS);
    expect(REASONING_PROVIDER_TIMEOUT_MS).toBe(90_000);
    expect(resolveProviderTimeoutMs("45000", false)).toBe(45_000);
    expect(resolveProviderTimeoutMs("45000", true)).toBe(45_000);
    for (const bad of ["", "abc", "-5", "10", "999999999", "1.5"]) expect(resolveProviderTimeoutMs(bad, false), bad).toBe(30_000);
  });

  it("the configured timeout is applied to the request", async () => {
    const hang = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as typeof fetch;
    const t0 = Date.now();
    const p = createInferenceProvider(env({ AI_TIMEOUT_MS: "1000" } as Partial<Env>), { provider: "openai", model: "gpt-5-mini" }, { fetch: hang }).generateStructured(req);
    await expect(p).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
