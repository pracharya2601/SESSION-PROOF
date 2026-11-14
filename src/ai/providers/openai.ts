/** OpenAI Chat Completions with a forced function call for structured output. */
import type { InferenceProvider, InferenceRequest, InferenceResult } from "../../contracts/v2";
import {
  defaultFetch,
  invalidOutput,
  isRecord,
  notConfigured,
  parseModelJson,
  postJson,
  trimSlash,
  type ProviderOptions,
} from "./http";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function openAiStyleTool(req: InferenceRequest) {
  return {
    type: "function" as const,
    function: { name: req.tool.name, description: req.tool.description, parameters: req.tool.inputSchema },
  };
}

export function buildOpenAiBody(model: string, req: InferenceRequest) {
  return {
    model,
    max_tokens: req.maxTokens,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    tools: [openAiStyleTool(req)],
    tool_choice: { type: "function", function: { name: req.tool.name } },
  };
}

/** Reads choices[0].message.tool_calls[0].function.arguments (JSON string) — shared with Mistral. */
export function parseToolCallArguments(provider: "openai" | "mistral", body: unknown, toolName: string): unknown {
  const choices = isRecord(body) ? body.choices : undefined;
  const message = Array.isArray(choices) && isRecord(choices[0]) ? choices[0].message : undefined;
  const calls = isRecord(message) ? message.tool_calls : undefined;
  if (!Array.isArray(calls) || calls.length === 0) throw invalidOutput(provider, "response has no tool call");
  const call =
    calls.find((c) => isRecord(c) && isRecord(c.function) && c.function.name === toolName) ?? calls[0];
  const fn = isRecord(call) ? call.function : undefined;
  if (!isRecord(fn)) throw invalidOutput(provider, "response has no tool call");
  const args = fn.arguments;
  // Mistral sometimes returns arguments as an object already.
  if (isRecord(args)) return args;
  return parseModelJson(provider, args);
}

export function createOpenAiProvider(
  cfg: { apiKey: string | undefined; baseUrl?: string; model: string },
  opts: ProviderOptions = {},
): InferenceProvider {
  const fetchFn = opts.fetch ?? defaultFetch();
  const url = `${trimSlash(cfg.baseUrl ?? OPENAI_DEFAULT_BASE_URL)}/chat/completions`;
  return {
    id: "openai",
    model: cfg.model,
    async generateStructured(req): Promise<InferenceResult> {
      if (!cfg.apiKey) throw notConfigured("openai", "OPENAI_API_KEY");
      const body = await postJson(
        "openai",
        fetchFn,
        url,
        { authorization: `Bearer ${cfg.apiKey}` },
        buildOpenAiBody(cfg.model, req),
        { signal: req.signal, timeoutMs: opts.timeoutMs },
      );
      const output = parseToolCallArguments("openai", body, req.tool.name);
      const model = isRecord(body) && typeof body.model === "string" ? body.model : cfg.model;
      return { output, provider: "openai", model };
    },
  };
}
