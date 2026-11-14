/**
 * Google Gemini generateContent with JSON mode + responseSchema. Gemini accepts
 * only an OpenAPI 3.0 subset, so the tool's JSON Schema is converted first.
 */
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

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/**
 * Convert a JSON Schema (draft 2020-12 subset) to Gemini's Schema object.
 * Kept: type (upper-cased), format, description, nullable, enum, items,
 * properties (+ propertyOrdering), required, minItems, maxItems, minimum,
 * maximum, anyOf. Dropped: $schema, $id, additionalProperties, minLength,
 * maxLength, pattern, title, default, examples and anything else.
 * `type: [T, "null"]` becomes `type: T, nullable: true`; `const` becomes a one-value enum.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const out: Record<string, unknown> = {};

  let type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length !== type.length) out.nullable = true;
    type = nonNull[0];
  }
  if (typeof type === "string" && GEMINI_TYPES.has(type)) out.type = type.toUpperCase();
  if (schema.nullable === true) out.nullable = true;

  if (typeof schema.description === "string") out.description = schema.description;
  if (typeof schema.format === "string" && (type !== "string" || schema.format === "enum" || schema.format === "date-time")) {
    out.format = schema.format;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum.map(String);
    if (!out.type) out.type = "STRING";
  } else if ("const" in schema && schema.const !== undefined) {
    out.enum = [String(schema.const)];
    if (!out.type) out.type = "STRING";
  }
  for (const k of ["minItems", "maxItems", "minimum", "maximum"] as const) {
    if (typeof schema[k] === "number") out[k] = schema[k];
  }
  if (schema.items !== undefined) out.items = toGeminiSchema(schema.items);
  if (isRecord(schema.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) props[k] = toGeminiSchema(v);
    out.properties = props;
    out.propertyOrdering = Object.keys(props);
    if (!out.type) out.type = "OBJECT";
  }
  if (Array.isArray(schema.required)) out.required = schema.required.filter((r): r is string => typeof r === "string");
  const any = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (any) out.anyOf = any.map(toGeminiSchema);
  return out;
}

export function buildGeminiBody(req: InferenceRequest) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(req.tool.inputSchema),
      maxOutputTokens: req.maxTokens,
    },
  };
}

export function createGeminiProvider(
  cfg: { apiKey: string | undefined; baseUrl?: string; model: string },
  opts: ProviderOptions = {},
): InferenceProvider {
  const fetchFn = opts.fetch ?? defaultFetch();
  const base = trimSlash(cfg.baseUrl ?? GEMINI_DEFAULT_BASE_URL);
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  return {
    id: "gemini",
    model: cfg.model,
    async generateStructured(req): Promise<InferenceResult> {
      if (!cfg.apiKey) throw notConfigured("gemini", "GEMINI_API_KEY");
      const body = await postJson("gemini", fetchFn, url, { "x-goog-api-key": cfg.apiKey }, buildGeminiBody(req), {
        signal: req.signal,
        timeoutMs: opts.timeoutMs,
      });
      const candidates = isRecord(body) ? body.candidates : undefined;
      const content = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0].content : undefined;
      const parts = isRecord(content) ? content.parts : undefined;
      if (!Array.isArray(parts) || parts.length === 0) throw invalidOutput("gemini", "response has no content");
      const text = parts
        .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
        .join("");
      const output = parseModelJson("gemini", text);
      const model = isRecord(body) && typeof body.modelVersion === "string" ? body.modelVersion : cfg.model;
      return { output, provider: "gemini", model };
    },
  };
}
