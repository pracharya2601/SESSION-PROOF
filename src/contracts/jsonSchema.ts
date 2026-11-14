/**
 * Hand-written JSON Schema (draft 2020-12 subset) mirroring the zod
 * `SessionFacts` schema in ./schemas.ts. Intended for use as a model tool
 * `input_schema` (Agent 10). Kept structurally identical to zod: same keys,
 * same required set, same enums and bounds. contracts.test.ts checks this.
 *
 * Differences by design: `additionalProperties: false` (zod strips unknown
 * keys instead of rejecting). The zod schema remains the authority — always
 * run `SessionFacts.parse` (plus evidence-reference validation) on model output.
 *
 * Note: `support` includes "provider_confirmed" to match zod; extraction
 * validation must still reject it from model output (provider additions are
 * attestations, handoff §8.3 rule 8).
 */

const idSchema = { type: "string", minLength: 1, maxLength: 128 } as const;
const shortTextSchema = { type: "string", maxLength: 2000 } as const;

export const jsonSchemaFactClaim = {
  type: "object",
  properties: {
    id: idSchema,
    text: shortTextSchema,
    evidenceIds: { type: "array", items: idSchema, maxItems: 50 },
    support: { type: "string", enum: ["supported", "uncertain", "provider_confirmed"] },
    providerAttestationId: idSchema,
  },
  required: ["id", "text", "evidenceIds", "support"],
  additionalProperties: false,
} as const;

export const jsonSchemaGoalFact = {
  type: "object",
  properties: {
    goalId: idSchema,
    status: { type: "string", enum: ["addressed", "partially_addressed", "unknown"] },
    claims: { type: "array", items: jsonSchemaFactClaim, maxItems: 50 },
  },
  required: ["goalId", "status", "claims"],
  additionalProperties: false,
} as const;

export const jsonSchemaSessionFacts = {
  type: "object",
  properties: {
    activities: { type: "array", items: jsonSchemaFactClaim, maxItems: 50 },
    observations: { type: "array", items: jsonSchemaFactClaim, maxItems: 50 },
    goals: { type: "array", items: jsonSchemaGoalFact, maxItems: 20 },
    progress: { type: "array", items: jsonSchemaFactClaim, maxItems: 50 },
    followUps: { type: "array", items: jsonSchemaFactClaim, maxItems: 50 },
    missingInformation: { type: "array", items: shortTextSchema, maxItems: 50 },
  },
  required: ["activities", "observations", "goals", "progress", "followUps", "missingInformation"],
  additionalProperties: false,
} as const;

export type JsonSchemaSessionFacts = typeof jsonSchemaSessionFacts;
