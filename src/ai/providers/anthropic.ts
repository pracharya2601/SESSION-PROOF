/** Anthropic Messages API with forced tool use for structured output. */
import type { InferenceProvider, InferenceRequest, InferenceResult } from "../../contracts/v2";
import { defaultFetch, invalidOutput, isRecord, notConfigured, postJson, trimSlash, type ProviderOptions } from "./http";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export function buildAnthropicBody(model: string, req: InferenceRequest) {
  return {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.inputSchema }],
    tool_choice: { type: "tool", name: req.tool.name },
  };
}

export function createAnthropicProvider(
  cfg: { apiKey: string | undefined; baseUrl?: string; model: string },
  opts: ProviderOptions = {},
): InferenceProvider {
  const fetchFn = opts.fetch ?? defaultFetch();
  const url = `${trimSlash(cfg.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL)}/v1/messages`;
  return {
    id: "anthropic",
    model: cfg.model,
    async generateStructured(req): Promise<InferenceResult> {
      if (!cfg.apiKey) throw notConfigured("anthropic", "ANTHROPIC_API_KEY");
      const body = await postJson(
        "anthropic",
        fetchFn,
        url,
        { "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION },
        buildAnthropicBody(cfg.model, req),
        { signal: req.signal, timeoutMs: opts.timeoutMs },
      );
      const content = isRecord(body) ? body.content : undefined;
      const block = Array.isArray(content)
        ? content.find((b) => isRecord(b) && b.type === "tool_use" && b.name === req.tool.name)
        : undefined;
      if (!isRecord(block) || !("input" in block)) throw invalidOutput("anthropic", "response has no tool_use output");
      const model = isRecord(body) && typeof body.model === "string" ? body.model : cfg.model;
      // `input` is normally an object; a string is passed through for the caller to validate.
      return { output: block.input, provider: "anthropic", model };
    },
  };
}
