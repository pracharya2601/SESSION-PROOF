/**
 * AI evaluation case format (evals/cases/*.json). SYNTHETIC data only: every name,
 * phone number, email, id and address is fictional (555 numbers, example.invalid).
 */
import { z } from "zod";

const Id = z.string().min(1).max(128);

export const CaseLine = z.object({
  /** Seconds from the start of the recording. */
  t: z.number().nonnegative(),
  d: z.number().positive().default(4),
  /** Deepgram style "Speaker 0"/"Speaker 1", a role, or null. */
  speaker: z.string().max(64).nullable().default(null),
  text: z.string().max(4000),
});
export type CaseLine = z.infer<typeof CaseLine>;

export const ForbiddenKind = z.enum([
  "generalisation",
  "invented_progress",
  "previous_note_only",
  "injection",
  "speaker_misattribution",
  "discussed_not_achieved",
  "invented_activity",
]);

export const ForbiddenClaim = z.object({
  id: Id,
  /** Case-insensitive regex matched against every claim text in the restored facts. */
  pattern: z.string().min(1),
  kind: ForbiddenKind,
  note: z.string().optional(),
});
export type ForbiddenClaim = z.infer<typeof ForbiddenClaim>;

export const RequiredCitation = z.object({
  /** A plan goal id, or a section name ("progress", "activities", ...). */
  target: z.string().min(1),
  /** At least one claim in the target must cite at least one of these evidence ids. */
  anyOf: z.array(Id).min(1),
  note: z.string().optional(),
});

export const PlantedPii = z.object({
  value: z.string().min(1),
  type: z.enum(["NAME", "EMAIL", "PHONE", "SSN", "ID", "ADDRESS", "DATE", "CLIENT_REF"]),
  /** Documented scrubber limitation: reported, but does not fail the CI wrapper. */
  knownGap: z.boolean().default(false),
  note: z.string().optional(),
});
export type PlantedPii = z.infer<typeof PlantedPii>;

export const CaseExpect = z.object({
  /** draft = the pipeline should produce a reviewable draft; no_evidence = stops before the model. */
  outcome: z.enum(["draft", "no_evidence"]).default("draft"),
  mustAddress: z.array(Id).default([]),
  mustStayUnknown: z.array(Id).default([]),
  forbiddenClaims: z.array(ForbiddenClaim).default([]),
  requiredCitations: z.array(RequiredCitation).default([]),
  pii: z.array(PlantedPii).default([]),
  /** Transcript contains instructions aimed at the model (billing/rate/approval). */
  injection: z.boolean().default(false),
  /** Expected canApprove after the provider confirms ONLY the duration (null = don't assert). */
  approvableAfterDuration: z.boolean().nullable().default(null),
});

export const FakeBadClaim = z.object({
  /** activities | observations | progress | followUps | goal:<goalId> */
  section: z.string().regex(/^(activities|observations|progress|followUps|goal:[A-Za-z0-9_-]+)$/),
  text: z.string().min(1).max(2000),
  cite: z.array(Id).default([]),
  support: z.enum(["supported", "uncertain"]).default("supported"),
  /** Goal status the fake sets when the section is goal:<id>. */
  status: z.enum(["addressed", "partially_addressed"]).default("addressed"),
  label: z.string().optional(),
});

export const DriveDoc = z.object({
  id: Id,
  kind: z.enum(["service_plan", "authorization", "previous_note", "assessment", "other"]),
  name: z.string().max(200),
  modifiedAt: z.string().default("2026-11-06T18:00:00.000Z"),
  text: z.string().max(20_000),
});

export const EvalCase = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  title: z.string(),
  purpose: z.string(),
  tags: z.array(z.string()).default([]),
  /** Reuse a synthetic band scenario (fixtures/band/scenarios.ts): script, plan, rules, rate, client. */
  fromScenario: z.string().optional(),
  sdpCode: z.string().optional(),
  client: z.object({ clientRef: Id, displayName: z.string(), preferredName: z.string().nullable().default(null) }).optional(),
  plan: z
    .object({
      serviceCode: Id,
      serviceDescription: z.string().max(2000),
      goals: z.array(z.object({ goalId: Id, objective: z.string().max(2000) })).min(1).max(20),
    })
    .optional(),
  hourlyRateCents: z.number().int().nonnegative().default(4000),
  scheduledMinutes: z.number().int().positive().default(60),
  evidenceCompleteness: z.enum(["complete", "partial", "unknown"]).optional(),
  transcript: z.array(CaseLine).optional(),
  /** Drive-like client context (src/contracts/schedule.ts DriveClientContext.documents). CONTEXT, never evidence. */
  context: z.object({ documents: z.array(DriveDoc).max(50) }).optional(),
  /** How the fake model behaves on this case (fake mode only). */
  fake: z
    .object({
      keywords: z.record(z.string(), z.array(z.string())).default({}),
      bad: z.array(FakeBadClaim).default([]),
    })
    .default({}),
  expect: CaseExpect,
});
export type EvalCase = z.infer<typeof EvalCase>;
export type EvalCaseInput = z.input<typeof EvalCase>;
