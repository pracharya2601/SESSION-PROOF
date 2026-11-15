/**
 * Review assistant: a short tool-use loop (max ASSISTANT_MAX_STEPS) over the
 * provider-agnostic generateStructured port. Each step the model returns
 * { tool_calls, reply }; read tools run locally over the scrubbed corpus,
 * propose_edit is validated and collected as a PROPOSAL (never applied).
 */
import type { InferenceProvider, SessionBundle } from "../contracts";
import type { SessionCorpus } from "./corpus";
import {
  BILLING_REFUSAL,
  TOOL_NAMES,
  citedIds,
  getClaim,
  getSummary,
  isBillingChangeRequest,
  searchTranscript,
  validateProposal,
} from "./tools";
import { ASSISTANT_MAX_STEPS, type AssistantProposal, type AssistantReply } from "./types";

export const ASSISTANT_PROMPT_VERSION = "review-assistant-v1";

export const SYSTEM_PROMPT = [
  "You are the review assistant in a field-visit documentation tool. A provider (support worker) is reviewing an AI-drafted session note, progress record and draft invoice before approving it. Help them understand the draft, answer questions about the visit, and correct it.",
  "",
  "Rules:",
  "1. You only PROPOSE edits, with propose_edit. Nothing is saved until the provider presses Apply. Never say a change was or will be saved, updated or applied by you; say 'I've prepared a change — press Apply if it's right.'",
  "2. Every statement about what happened in the visit cites transcript segment ids in square brackets, e.g. [ev_003] — in the reply AND in propose_edit citations. Use only ids from the context or tool results. If the transcript does not support something, say so plainly. When the provider's statement matches a segment, say so with its id (e.g. 'the transcript agrees [ev_002]').",
  "3. Never invent facts, names, times, quotes or outcomes. If you do not know, say so or ask one short question.",
  "4. When the provider tells you a fact (actual minutes, what the client did, which goals were worked on), you may propose it. It is recorded as provider-confirmed (not evidence): say so briefly. Do not cite a segment for it unless the segment really supports it.",
  "5. Billing: never propose or agree to change hourly rates, amounts, totals, units or service codes. Rates come from the authorization on file; the server recalculates the amount from confirmed minutes. If asked, decline in one sentence.",
  "6. Misleading claims: if a draft claim is not supported by its cited segments, or overstates them (e.g. 'independently', 'always', 'mastered', outcomes the visit did not show), say so and propose rejectedClaims with the claim id and a short reason.",
  "6b. A blocker with code CLAIM_EXCEEDS_EVIDENCE means the rules refused a claim (its id is in the message). Explain it in one sentence and propose rejectedClaims for that claim id; if the provider gives their own wording, also propose it as activitySummary or progressConfirmation.",
  "7. goalsAddressed is the FULL list of plan goal ids the provider confirms; keep goals already confirmed unless the provider says otherwise. Use goal ids, not objectives. Only add a goal the provider named, or one a cited segment clearly shows (cite it, and say it is a suggestion).",
  "8. activitySummary is a short factual summary of what was done (2-4 sentences, no judgement words). progressConfirmation is the provider's own progress statement.",
  "9. Tokens like [NAME_1] or [CLIENT_REF_1] are privacy placeholders. Copy them exactly; never guess who they are.",
  "10. Be brief: at most 4 short sentences, or a short list. Plain language. No headings, no markdown tables.",
  "",
  "How to work: every step you return JSON { tool_calls, reply }. To look something up, put calls in tool_calls and leave reply empty; you will get the results in the next step. When you are done, write reply, and put any propose_edit calls in that same step. You have at most 4 steps.",
  "Tools: get_summary {} · search_transcript {query} · get_claim {claimId} · propose_edit {edit, rationale, citations}.",
].join("\n");

const EDIT_SCHEMA = {
  type: "object",
  description: "Only the fields to change.",
  properties: {
    confirmedMinutes: { type: "integer", description: "Actual minutes the provider confirms." },
    progressConfirmation: { type: "string" },
    goalsAddressed: { type: "array", items: { type: "string" }, description: "FULL list of confirmed goal ids." },
    activitySummary: { type: "string" },
    participantDirected: { type: "boolean" },
    participantChoices: { type: "string" },
    rejectedClaims: {
      type: "array",
      items: {
        type: "object",
        properties: { claimId: { type: "string" }, reason: { type: "string" } },
        required: ["claimId", "reason"],
      },
    },
  },
};

export const STEP_TOOL = {
  name: "assistant_step",
  description: "One step of the review assistant: tool calls to run, and/or the final reply.",
  inputSchema: {
    type: "object",
    properties: {
      tool_calls: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: [...TOOL_NAMES] },
            query: { type: "string", description: "search_transcript: words to look for." },
            claimId: { type: "string", description: "get_claim: claim id." },
            edit: EDIT_SCHEMA,
            rationale: { type: "string", description: "propose_edit: one sentence why." },
            citations: { type: "array", items: { type: "string" }, description: "propose_edit: supporting segment ids." },
          },
          required: ["name"],
        },
      },
      reply: { type: "string", description: "Final answer to the provider. Empty while you are still calling read tools." },
    },
    required: ["tool_calls", "reply"],
  },
} as const;

interface ToolCall {
  name?: unknown;
  query?: unknown;
  claimId?: unknown;
  edit?: unknown;
  rationale?: unknown;
  citations?: unknown;
}

export interface AssistantRunStats {
  steps: number;
  toolCalls: number;
  invalidProposals: number;
}

const MAX_RESULT_CHARS = 6000;

function contextBlock(bundle: SessionBundle, corpus: SessionCorpus): string {
  const summary = getSummary(bundle, corpus);
  const convo = corpus.messages.map((m) => `${m.role === "user" ? "Provider" : "Assistant"}: ${m.content}`).join("\n");
  return [
    "Session summary (from get_summary):",
    JSON.stringify(summary),
    "",
    `Transcript has ${corpus.segments.length} segments. First segments:`,
    JSON.stringify(corpus.segments.slice(0, 6).map((s) => ({ id: s.id, speaker: s.speaker, text: s.text.slice(0, 300) }))),
    "",
    "Conversation so far:",
    convo,
  ].join("\n");
}

function runReadTool(call: ToolCall, bundle: SessionBundle, corpus: SessionCorpus): unknown {
  switch (call.name) {
    case "get_summary":
      return getSummary(bundle, corpus);
    case "search_transcript":
      return searchTranscript(corpus, typeof call.query === "string" ? call.query : "");
    case "get_claim":
      return getClaim(corpus, typeof call.claimId === "string" ? call.claimId : "");
    default:
      return { error: `Unknown tool ${String(call.name).slice(0, 40)}.` };
  }
}

function clip(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}…(truncated)` : s;
}

const NEGATION_RE = /\b(can['’]?t|cannot|can not|won['’]?t|unable|not able|not allowed|don['’]?t change|do not change)\b/i;
const CLAIMS_APPLIED_RE =
  /\b((i(['’]ve| have)?|it['’]?s|has been|have been|was|were)\s+(now\s+)?(saved|applied|updated|changed|set|recorded|raised|lowered)|i(['’]ll| will)\s+(now\s+)?(save|apply|update|change|set|record))\b/i;

/**
 * Deterministic guard on the model's reply: a billing refusal must read as a refusal,
 * and the assistant never claims to have saved anything (only the provider applies).
 */
export function guardReply(reply: string, refusals: string[], proposalCount: number): string {
  let out = reply;
  if (refusals.length > 0 && !NEGATION_RE.test(out)) {
    out = proposalCount > 0 ? `${refusals[0]} I did prepare ${proposalCount} other suggestion${proposalCount === 1 ? "" : "s"} below.` : refusals[0]!;
  }
  if (CLAIMS_APPLIED_RE.test(out) && !/press(ing)? apply|until you apply/i.test(out)) {
    out = `${out} (Nothing is saved until you press Apply.)`;
  }
  return out;
}

export async function runAssistant(input: {
  bundle: SessionBundle;
  corpus: SessionCorpus;
  provider: InferenceProvider;
  signal?: AbortSignal;
}): Promise<{ reply: AssistantReply; stats: AssistantRunStats }> {
  const { bundle, corpus, provider } = input;
  const proposals: AssistantProposal[] = [];
  const refusals: string[] = [];
  const trace: string[] = [];
  const stats: AssistantRunStats = { steps: 0, toolCalls: 0, invalidProposals: 0 };
  let reply = "";
  let model = provider.model;

  const lastUser = [...corpus.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const billingAsk = isBillingChangeRequest(lastUser);
  if (billingAsk) refusals.push(BILLING_REFUSAL);

  const base = contextBlock(bundle, corpus);
  for (let step = 1; step <= ASSISTANT_MAX_STEPS; step++) {
    const last = step === ASSISTANT_MAX_STEPS;
    const user = [
      base,
      trace.length ? `\nTool results so far (this turn):\n${trace.join("\n")}` : "",
      billingAsk ? "\nNote: the provider asked to change billing. Decline (rule 5) and offer what you can do instead." : "",
      `\nStep ${step} of ${ASSISTANT_MAX_STEPS}.${last ? " This is the LAST step: write the reply now; only propose_edit calls are still accepted." : ""}`,
    ].join("\n");
    const res = await provider.generateStructured({
      system: SYSTEM_PROMPT,
      user,
      tool: STEP_TOOL as unknown as { name: string; description: string; inputSchema: Record<string, unknown> },
      maxTokens: 1500,
      signal: input.signal,
    });
    stats.steps = step;
    model = res.model || model;
    const out = (res.output && typeof res.output === "object" ? res.output : {}) as { tool_calls?: unknown; reply?: unknown };
    const calls: ToolCall[] = Array.isArray(out.tool_calls) ? (out.tool_calls.slice(0, 4) as ToolCall[]) : [];
    const stepReply = typeof out.reply === "string" ? out.reply.trim() : "";

    let readCalls = 0;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      stats.toolCalls++;
      if (call.name === "propose_edit") {
        const check = validateProposal(call, bundle, corpus, `p${proposals.length + 1}`);
        if (check.ok) {
          proposals.push(check.proposal);
          trace.push(`propose_edit → recorded as proposal ${check.proposal.id} (NOT applied; the provider decides).`);
        } else {
          stats.invalidProposals++;
          if (check.refusal && !refusals.includes(check.refusal)) refusals.push(check.refusal);
          trace.push(`propose_edit → rejected: ${check.errors.join(" ")}`);
        }
        continue;
      }
      if (last) continue;
      readCalls++;
      trace.push(`${String(call.name)}(${clip({ query: call.query, claimId: call.claimId })}) → ${clip(runReadTool(call, bundle, corpus))}`);
    }
    if (stepReply && (readCalls === 0 || last)) {
      reply = stepReply;
      break;
    }
    if (!stepReply && calls.length === 0) break; // nothing to do
  }

  if (!reply) {
    reply =
      proposals.length > 0
        ? `I prepared ${proposals.length} suggested change${proposals.length === 1 ? "" : "s"} below. Review and apply what is right.`
        : refusals.length > 0
          ? refusals[0]!
          : "Sorry, I couldn't finish that. Try asking in a different way, or use Edit manually.";
  }
  reply = guardReply(reply, billingAsk ? refusals : [], proposals.length);
  const restored = corpus.restore(reply).slice(0, 4000);
  const evidenceIds = bundle.evidence.map((e) => e.id);
  return {
    reply: {
      reply: restored,
      citations: citedIds(restored, evidenceIds),
      proposals,
      refusals,
      revision: bundle.bundleRevision,
      steps: stats.steps,
      provider: provider.id,
      model,
    },
    stats,
  };
}
