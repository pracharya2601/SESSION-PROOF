import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as ex from "./examples";
import { jsonSchemaSessionFacts } from "./jsonSchema";
import {
  ApiError,
  ApprovalNotification,
  ApprovalRequest,
  QueuePayload,
  ReviewRequest,
  SessionBundle,
  SessionFacts,
} from "./schemas";

const cases: Array<[string, z.ZodTypeAny, unknown[], ex.InvalidExample[]]> = [
  ["ReviewRequest", ReviewRequest, ex.validReviewRequests, ex.invalidReviewRequests],
  ["ApprovalRequest", ApprovalRequest, ex.validApprovalRequests, ex.invalidApprovalRequests],
  ["QueuePayload", QueuePayload, ex.validQueuePayloads, ex.invalidQueuePayloads],
  ["ApprovalNotification", ApprovalNotification, ex.validApprovalNotifications, ex.invalidApprovalNotifications],
  ["ApiError", ApiError, ex.validApiErrors, ex.invalidApiErrors],
  ["SessionBundle", SessionBundle, ex.validSessionBundles, ex.invalidSessionBundles],
  ["SessionFacts", SessionFacts, ex.validSessionFacts, ex.invalidSessionFacts],
];

describe.each(cases)("%s examples", (_name, schema, valid, invalid) => {
  it.each(valid.map((v, i) => [i, v] as const))("valid #%i parses", (_i, v) => {
    const r = schema.safeParse(v);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
  it.each(invalid.map((e) => [e.name, e.value] as const))("rejects: %s", (_n, v) => {
    expect(schema.safeParse(v).success).toBe(false);
  });
});

describe("specific guarantees", () => {
  it("valid examples survive a JSON round trip", () => {
    for (const [, schema, valid] of cases) {
      for (const v of valid) expect(schema.safeParse(JSON.parse(JSON.stringify(v))).success).toBe(true);
    }
  });
  it("reviewed bundle reflects §9.3 expectations", () => {
    expect(ex.validReviewedBundle.bundleRevision).toBe(3);
    expect(ex.validReviewedBundle.billing.amountCents).toBe(11250);
    expect(ex.validDraftBundle.billing.amountCents).toBeNull();
    expect(ex.validDraftBundle.billing.confirmedMinutes).toBeNull();
  });
  it("approval request with providerId fails on unrecognized key", () => {
    const r = ApprovalRequest.safeParse(ex.invalidApprovalRequests[0]!.value);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });
});

// ---------------------------------------------------------------- JSON Schema parity
type JS = Record<string, any>;

/** Minimal validator for the JSON Schema subset used in jsonSchema.ts. */
function jsValid(s: JS, v: unknown): boolean {
  switch (s.type) {
    case "object": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (!(k in o)) return false;
      for (const [k, val] of Object.entries(o)) {
        const ps = s.properties?.[k];
        if (!ps) {
          if (s.additionalProperties === false) return false;
          continue;
        }
        if (!jsValid(ps, val)) return false;
      }
      return true;
    }
    case "array":
      if (!Array.isArray(v)) return false;
      if (s.maxItems !== undefined && v.length > s.maxItems) return false;
      return v.every((x) => jsValid(s.items, x));
    case "string":
      if (typeof v !== "string") return false;
      if (s.minLength !== undefined && v.length < s.minLength) return false;
      if (s.maxLength !== undefined && v.length > s.maxLength) return false;
      if (s.enum && !s.enum.includes(v)) return false;
      return true;
    default:
      throw new Error(`unsupported type ${s.type}`);
  }
}

/** Convert the zod schema subset to an equivalent JSON Schema for comparison. */
function zodToJs(t: z.ZodTypeAny): JS {
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, z.ZodTypeAny>;
    const properties: JS = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      if (v instanceof z.ZodOptional) properties[k] = zodToJs(v.unwrap());
      else {
        properties[k] = zodToJs(v);
        required.push(k);
      }
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (t instanceof z.ZodArray) {
    const out: JS = { type: "array", items: zodToJs(t.element) };
    if (t._def.maxLength) out.maxItems = t._def.maxLength.value;
    return out;
  }
  if (t instanceof z.ZodEnum) return { type: "string", enum: [...t.options] };
  if (t instanceof z.ZodString) {
    const out: JS = { type: "string" };
    for (const c of t._def.checks) {
      if (c.kind === "min") out.minLength = c.value;
      else if (c.kind === "max") out.maxLength = c.value;
      else throw new Error(`unmapped string check ${c.kind}`);
    }
    return out;
  }
  throw new Error(`unmapped zod type ${t.constructor.name}`);
}

const sortReq = (s: JS): JS =>
  JSON.parse(
    JSON.stringify(s, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.required) ? { ...v, required: [...v.required].sort() } : v,
    ),
  );

describe("jsonSchemaSessionFacts parity with zod SessionFacts", () => {
  it("is structurally identical to the zod schema", () => {
    expect(sortReq(jsonSchemaSessionFacts as JS)).toEqual(sortReq(zodToJs(SessionFacts)));
  });
  it.each(ex.validSessionFacts.map((v, i) => [i, v] as const))("accepts valid facts #%i", (_i, v) => {
    expect(jsValid(jsonSchemaSessionFacts, v)).toBe(true);
  });
  it.each(ex.invalidSessionFacts.map((e) => [e.name, e.value] as const))("rejects: %s", (_n, v) => {
    expect(jsValid(jsonSchemaSessionFacts, v)).toBe(false);
  });
  it("agrees with zod on bundle facts", () => {
    for (const b of ex.validSessionBundles) {
      expect(jsValid(jsonSchemaSessionFacts, b.facts)).toBe(true);
      expect(jsValid(jsonSchemaSessionFacts, b.extractedFacts)).toBe(true);
    }
  });
});
