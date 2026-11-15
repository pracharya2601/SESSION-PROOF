/**
 * Review assistant contracts (POST /api/sessions/:id/assistant).
 * The assistant only PROPOSES edits; the provider applies one with the normal
 * PATCH /api/sessions/:id/review (expectedRevision-guarded, server-validated).
 */
import { z } from "zod";

export const ASSISTANT_MAX_MESSAGES = 30;
export const ASSISTANT_MAX_MESSAGE_CHARS = 4000;
export const ASSISTANT_MAX_STEPS = 4;

export const AssistantMessage = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE_CHARS),
  })
  .strict();
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const AssistantRequest = z
  .object({
    messages: z.array(AssistantMessage).min(1).max(ASSISTANT_MAX_MESSAGES),
    expectedRevision: z.number().int().positive(),
  })
  .strict()
  .refine((r) => r.messages[r.messages.length - 1]?.role === "user", {
    message: "The last message must be from the user",
  });
export type AssistantRequest = z.infer<typeof AssistantRequest>;

export interface RejectedClaim {
  claimId: string;
  reason: string;
}

/** Same allowlist as ReviewEdits (+ rejectedClaims). Never rates, amounts or codes. */
export interface ProposedEdits {
  confirmedMinutes?: number;
  progressConfirmation?: string;
  goalsAddressed?: string[];
  activitySummary?: string;
  participantDirected?: boolean;
  participantChoices?: string;
  rejectedClaims?: RejectedClaim[];
}

export const PROPOSABLE_FIELDS = [
  "confirmedMinutes",
  "progressConfirmation",
  "goalsAddressed",
  "activitySummary",
  "participantDirected",
  "participantChoices",
  "rejectedClaims",
] as const;

export interface AssistantProposal {
  id: string;
  edits: ProposedEdits;
  /** Human-readable lines, one per edit ("Confirmed minutes → 45 (provider-confirmed)"). */
  summary: string[];
  rationale: string;
  /** Known evidence ids that support the proposal (may be empty for provider-confirmed facts). */
  citations: string[];
}

export interface AssistantReply {
  reply: string;
  /** Evidence ids mentioned in the reply that exist in this session. */
  citations: string[];
  proposals: AssistantProposal[];
  /** Requests the assistant declined (billing/rate changes, invalid fields). */
  refusals: string[];
  revision: number;
  steps: number;
  provider: string;
  model: string;
}

export interface AssistantStatus {
  available: boolean;
  provider: string | null;
  model: string | null;
  reason: string | null;
}
