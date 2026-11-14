/** Mistral Chat Completions (OpenAI-style tools) with tool_choice "any". */
import type { InferenceProvider, InferenceRequest, InferenceResult } from "../../contracts/v2";
import { defaultFetch, isRecord, notConfigured, postJson, trimSlash, type ProviderOptions } from "./http";
import { openAiStyleTool, parseToolCallArguments } from "./openai";

export const MISTRAL_DEFAULT_BASE_URL = "https://api.mistral.ai/v1";

export function buildMistralBody(model: string, req: InferenceRequest) {
  return {
    model,
    max_tokens: req.maxTokens,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    tools: [openAiStyleTool(req)],
    tool_choice: "any",
  };
}

export function createMistralProvider(
  cfg: { apiKey: string | undefined; baseUrl?: string; model: string },
  opts: ProviderOptions = {},
): InferenceProvider {
  const fetchFn = opts.fetch ?? defaultFetch();
  const url = `${trimSlash(cfg.baseUrl ?? MISTRAL_DEFAULT_BASE_URL)}/chat/completions`;
  return {
    id: "mistral",
    model: cfg.model,
    async generateStructured(req): Promise<InferenceResult> {
      if (!cfg.apiKey) throw notConfigured("mistral", "MISTRAL_API_KEY");
      const body = await postJson(
        "mistral",
        fetchFn,
        url,
        { authorization: `Bearer ${cfg.apiKey}` },
        buildMistralBody(cfg.model, req),
        { signal: req.signal, timeoutMs: opts.timeoutMs },
      );
      const output = parseToolCallArguments("mistral", body, req.tool.name);
      const model = isRecord(body) && typeof body.model === "string" ? body.model : cfg.model;
      return { output, provider: "mistral", model };
    },
  };
}
