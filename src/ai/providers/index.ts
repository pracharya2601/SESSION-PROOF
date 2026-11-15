/** Multi-provider inference adapter (v2). Keys never leave the server. */
import {
  AI_DEFAULT_MODELS,
  AI_PROVIDER_LABELS,
  AiProviderId,
  type AiProviderStatus,
  type InferenceProvider,
} from "../../contracts/v2";
import type { Env } from "../../env";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import { createMistralProvider } from "./mistral";
import { createOpenAiProvider, isOpenAiReasoningModel } from "./openai";
import { resolveProviderTimeoutMs, type ProviderOptions } from "./http";

export { InferenceError } from "../../contracts/v2";
export { createAnthropicProvider } from "./anthropic";
export { createOpenAiProvider, isOpenAiReasoningModel } from "./openai";
export { createGeminiProvider, toGeminiSchema } from "./gemini";
export { createMistralProvider } from "./mistral";
export { PROVIDER_TIMEOUT_MS, REASONING_PROVIDER_TIMEOUT_MS, parseRetryAfter, resolveProviderTimeoutMs, type ProviderOptions } from "./http";

const nonEmpty = (v: string | undefined): string | undefined => (v && v.trim() ? v : undefined);

export function apiKeyFor(env: Env, provider: AiProviderId): string | undefined {
  switch (provider) {
    case "anthropic":
      return nonEmpty(env.ANTHROPIC_API_KEY) ?? nonEmpty(env.AI_API_KEY);
    case "openai":
      return nonEmpty(env.OPENAI_API_KEY);
    case "gemini":
      return nonEmpty(env.GEMINI_API_KEY);
    case "mistral":
      return nonEmpty(env.MISTRAL_API_KEY);
  }
}

export function createInferenceProvider(
  env: Env,
  sel: { provider: AiProviderId; model: string },
  opts?: ProviderOptions,
): InferenceProvider {
  const apiKey = apiKeyFor(env, sel.provider);
  const model = sel.model;
  const reasoning = sel.provider === "openai" && isOpenAiReasoningModel(model);
  const timeoutEnv = (env as Env & { AI_TIMEOUT_MS?: string }).AI_TIMEOUT_MS;
  opts = { ...opts, timeoutMs: opts?.timeoutMs ?? resolveProviderTimeoutMs(timeoutEnv, reasoning) };
  switch (sel.provider) {
    case "anthropic":
      return createAnthropicProvider({ apiKey, model, baseUrl: nonEmpty(env.AI_GATEWAY_URL) }, opts);
    case "openai":
      return createOpenAiProvider({ apiKey, model, baseUrl: nonEmpty(env.OPENAI_BASE_URL) }, opts);
    case "gemini":
      return createGeminiProvider({ apiKey, model, baseUrl: nonEmpty(env.GEMINI_BASE_URL) }, opts);
    case "mistral":
      return createMistralProvider({ apiKey, model, baseUrl: nonEmpty(env.MISTRAL_BASE_URL) }, opts);
  }
}

export function aiProviderStatuses(env: Env): AiProviderStatus[] {
  return AiProviderId.options.map((provider) => ({
    provider,
    label: AI_PROVIDER_LABELS[provider],
    configured: apiKeyFor(env, provider) !== undefined,
    models: [...AI_DEFAULT_MODELS[provider]],
  }));
}
