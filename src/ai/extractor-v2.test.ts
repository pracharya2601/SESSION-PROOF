import { describe, expect, it } from "vitest";
import { ExtractionRejectedError, type EvidenceItem, type ExtractionContext, type SessionFacts } from "../contracts";
import { DEFAULT_AI_SETTINGS, type AiProviderId, type AiSettings } from "../contracts/v2";
import type { Env } from "../env";
import { demoAppointment, demoEvidence, demoFacts, demoPlan } from "../../fixtures/scenario";
import { createExtractor, envDefaultAiSettings, isExtractionOutputV2, PROMPT_VERSION, type ExtractionOutputV2 } from "./index";

const PII_LINE = "Call Jane Doe at 555-123-4567, jane@x.org, SSN 123-45-6789";
const RAW_PII = ["Jane", "Doe", "555-123-4567", "jane@x.org", "123-45-6789"];
const piiEvidence: EvidenceItem = { ...demoEvidence[0]!, id: "ev_006", excerpt: PII_LINE };
const ctx: ExtractionContext = { appointment: demoAppointment, plan: demoPlan, evidence: [...demoEvidence, piiEvidence] };

const PROVIDERS: AiProviderId[] = ["anthropic", "openai", "gemini", "mistral"];
const MODELS: Record<AiProviderId, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4.1",
  gemini: "gemini-2.5-flash",
  mistral: "mistral-large-latest",
};

function env(over: Partial<Env> = {}): Env {
  return {
    EXTRACTION_MODE: "live",
    EVIDENCE_MODE: "fixture",
    AI_MODEL: "claude-env-model",
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

/** Wrap structured output in each vendor's response envelope. */
function vendorResponse(provider: AiProviderId, output: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const args = JSON.stringify(output);
  const body = {
    anthropic: { content: [{ type: "tool_use", id: "t1", name: "record_session_facts", input: output }] },
    openai: { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "record_session_facts", arguments: args } }] } }] },
    mistral: { choices: [{ message: { tool_calls: [{ function: { name: "record_session_facts", arguments: args } }] } }] },
    gemini: { candidates: [{ content: { parts: [{ text: args }] } }] },
  }[provider];
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Responder = Response | Error | ((body: string) => Response);
function fakeFetch(responses: Responder[]) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(body) : next;
  }) as typeof fetch;
  return { fn, calls };
}

const settingsFor = (provider: AiProviderId, privacy = DEFAULT_AI_SETTINGS.privacy): AiSettings => ({
  provider,
  model: MODELS[provider],
  privacy: { ...privacy },
});

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExtractionRejectedError) return e.reason;
    throw e;
  }
  return "no-error";
}

describe.each(PROVIDERS)("live extractor via %s", (provider) => {
  it("end-to-end: resolves settings, scrubs, calls the vendor, validates, returns provenance", async () => {
    const { fn, calls } = fakeFetch([vendorResponse(provider, demoFacts)]);
    const seen: string[] = [];
    const out = await createExtractor(env(), {
      fetch: fn,
      retryDelayMs: 0,
      resolveSettings: async (pid) => {
        seen.push(pid);
        return settingsFor(provider);
      },
    }).extractFacts(ctx);
    expect(seen).toEqual([demoAppointment.providerId]);
    expect(out.facts).toEqual(demoFacts);
    expect(out.mode).toBe("live");
    expect(out.promptVersion).toBe(PROMPT_VERSION);
    expect(out.model).toBe(MODELS[provider]);
    expect(isExtractionOutputV2(out)).toBe(true);
    const v2 = out as ExtractionOutputV2;
    expect(v2.aiProvider).toBe(provider);
    expect(v2.privacy?.scrubbed).toBe(true);
    expect(v2.privacy?.findings.NAME).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain(JSON.stringify('<evidence id="ev_006"').slice(1, -1));
    expect(calls[0]!.body).toContain("placeholders");
  });

  it("never sends unscrubbed PII to the provider", async () => {
    const { fn, calls } = fakeFetch([vendorResponse(provider, demoFacts)]);
    await createExtractor(env(), { fetch: fn, retryDelayMs: 0, resolveSettings: async () => settingsFor(provider) }).extractFacts(ctx);
    const body = calls[0]!.body;
    for (const raw of RAW_PII) expect(body).not.toContain(raw);
    expect(body).toMatch(/\[NAME_\d+\]/);
    expect(body).toMatch(/\[PHONE_\d+\]/);
    expect(body).toMatch(/\[EMAIL_\d+\]/);
    expect(body).toMatch(/\[SSN_\d+\]/);
    // Headers carry only the key, never evidence.
    for (const raw of RAW_PII) expect(JSON.stringify(calls[0]!.headers)).not.toContain(raw);
  });

  it("restores placeholder tokens in model output after validation", async () => {
    const respond = (body: string) => {
      const token = body.match(/\[NAME_\d+\]/)![0];
      const facts: SessionFacts = JSON.parse(JSON.stringify(demoFacts));
      facts.followUps = [{ id: "fact_fu_2", text: `Call ${token} back.`, evidenceIds: ["ev_006"], support: "supported" }];
      return vendorResponse(provider, facts);
    };
    const { fn } = fakeFetch([respond]);
    const out = await createExtractor(env(), { fetch: fn, retryDelayMs: 0, resolveSettings: async () => settingsFor(provider) }).extractFacts(ctx);
    expect(out.facts.followUps[0]!.text).toBe("Call Jane Doe back.");
    expect(out.facts.followUps[0]!.evidenceIds).toEqual(["ev_006"]);
  });

  it("privacy options off → excerpts sent as-is (settings are honoured)", async () => {
    const off = { redactNames: false, redactContact: false, redactIdentifiers: false, redactAddresses: false, redactDates: false };
    const { fn, calls } = fakeFetch([vendorResponse(provider, demoFacts)]);
    const out = await createExtractor(env(), { fetch: fn, resolveSettings: async () => settingsFor(provider, off) }).extractFacts(ctx);
    expect(calls[0]!.body).toContain("555-123-4567");
    expect((out as ExtractionOutputV2).privacy?.scrubbed).toBe(false);
  });

  it("invalid citation from the model is rejected after retries", async () => {
    const bad = JSON.parse(JSON.stringify(demoFacts));
    bad.activities[0].evidenceIds = ["ev_999"];
    const { fn, calls } = fakeFetch([vendorResponse(provider, bad), vendorResponse(provider, bad)]);
    expect(await reasonOf(createExtractor(env(), { fetch: fn, retryDelayMs: 0, resolveSettings: async () => settingsFor(provider) }).extractFacts(ctx))).toBe(
      "unknown_evidence",
    );
    expect(calls).toHaveLength(2);
  });

  it("auth failure → provider_error without retry", async () => {
    const { fn, calls } = fakeFetch([new Response("", { status: 401 }), vendorResponse(provider, demoFacts)]);
    expect(await reasonOf(createExtractor(env(), { fetch: fn, retryDelayMs: 0, resolveSettings: async () => settingsFor(provider) }).extractFacts(ctx))).toBe(
      "provider_error",
    );
    expect(calls).toHaveLength(1);
  });

  it("rate limit → retries once then succeeds", async () => {
    const { fn, calls } = fakeFetch([new Response("", { status: 429, headers: { "retry-after": "1" } }), vendorResponse(provider, demoFacts)]);
    const out = await createExtractor(env(), { fetch: fn, retryDelayMs: 0, resolveSettings: async () => settingsFor(provider) }).extractFacts(ctx);
    expect(out.facts).toEqual(demoFacts);
    expect(calls).toHaveLength(2);
  });
});

describe("live extractor settings + errors", () => {
  it("missing key for the selected provider → provider_error, no fetch", async () => {
    const { fn, calls } = fakeFetch([vendorResponse("openai", demoFacts)]);
    const p = createExtractor(env({ OPENAI_API_KEY: undefined }), { fetch: fn, resolveSettings: async () => settingsFor("openai") }).extractFacts(ctx);
    expect(await reasonOf(p)).toBe("provider_error");
    expect(calls).toHaveLength(0);
  });

  it("unparsable vendor JSON twice → malformed", async () => {
    const bad = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{nope" }] } }] }), { status: 200 });
    const { fn, calls } = fakeFetch([bad(), bad()]);
    const p = createExtractor(env(), { fetch: fn, retryDelayMs: 0, resolveSettings: async () => settingsFor("gemini") }).extractFacts(ctx);
    expect(await reasonOf(p)).toBe("malformed");
    expect(calls).toHaveLength(2);
  });

  it("without resolveSettings uses env.AI_PROVIDER + env.AI_MODEL and default (all-on) privacy", async () => {
    const { fn, calls } = fakeFetch([vendorResponse("mistral", demoFacts)]);
    const out = await createExtractor(env({ AI_PROVIDER: "mistral", AI_MODEL: "mistral-small-latest" }), { fetch: fn }).extractFacts(ctx);
    expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(JSON.parse(calls[0]!.body).model).toBe("mistral-small-latest");
    expect((out as ExtractionOutputV2).aiProvider).toBe("mistral");
    for (const raw of RAW_PII) expect(calls[0]!.body).not.toContain(raw);
  });

  it("envDefaultAiSettings falls back to anthropic for invalid AI_PROVIDER", () => {
    expect(envDefaultAiSettings(env({ AI_PROVIDER: "bogus" })).provider).toBe("anthropic");
    expect(envDefaultAiSettings(env({ AI_PROVIDER: "gemini", AI_MODEL: "" })).model).toBe("gemini-2.5-pro");
    expect(envDefaultAiSettings(env()).privacy).toEqual(DEFAULT_AI_SETTINGS.privacy);
  });

  it("fixture mode is unchanged and carries no v2 provenance", async () => {
    const out = await createExtractor(env({ EXTRACTION_MODE: "fixture" })).extractFacts({ ...ctx, evidence: demoEvidence });
    expect(out.mode).toBe("fixture");
    expect(isExtractionOutputV2(out)).toBe(false);
  });
});
