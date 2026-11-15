/** Test helpers for the review assistant (fake provider + a bundle with PII to scrub). */
import type { InferenceProvider, InferenceRequest, SessionBundle } from "../contracts";
import { makeBundle } from "../services/approval/testkit";

export const CLIENT_NAME = "Jordan Rivera";
export const CLIENT_PHONE = "415-555-0134";

export function assistantBundle(over: Partial<SessionBundle> = {}): SessionBundle {
  const base = makeBundle();
  const ev = (id: string, minute: number, speaker: string, excerpt: string) => ({
    id,
    sourceId: "src-1",
    sourceMode: "fixture" as const,
    observedFrom: `2026-11-13T13:${String(minute).padStart(2, "0")}:00.000Z`,
    observedTo: `2026-11-13T13:${String(minute + 1).padStart(2, "0")}:00.000Z`,
    speaker,
    excerpt,
    retrievedAt: "2026-11-13T14:40:00.000Z",
  });
  const facts: SessionBundle["facts"] = {
      activities: [
        { id: "c_act_1", text: `${CLIENT_NAME} planned the bus route to the library.`, evidenceIds: ["ev_001", "ev_002"], support: "supported" },
      ],
      observations: [{ id: "c_obs_1", text: "Client now travels independently every week.", evidenceIds: ["ev_002"], support: "supported" }],
      goals: [{ goalId: "g1", status: "addressed", claims: [{ id: "c_goal_1", text: "Practised route planning.", evidenceIds: ["ev_002"], support: "supported" }] }],
      progress: [],
      followUps: [{ id: "c_fu_1", text: "Try paying with own card next week.", evidenceIds: ["ev_004"], support: "supported" }],
      missingInformation: [],
  };
  return makeBundle({
    facts,
    extractedFacts: facts,
    evidence: [
      ev("ev_001", 2, "Speaker 0", `Hi ${CLIENT_NAME}, ready to plan the bus trip to the library?`),
      ev("ev_002", 5, "Speaker 1", "I looked up the 22 bus myself and wrote the times down."),
      ev("ev_003", 9, "Speaker 0", `If anything changes call me at ${CLIENT_PHONE}.`),
      ev("ev_004", 14, "Speaker 1", "Next week I want to try paying with my own card."),
    ],
    config: {
      ...base.config,
      plan: {
        ...base.config.plan,
        goals: [
          { goalId: "g1", objective: "Plan tasks" },
          { goalId: "g2", objective: "Use public transport" },
        ],
      },
    },
    ...over,
  });
}

export type StepOutput = { tool_calls: Record<string, unknown>[]; reply: string };

/** Scripted provider: returns outputs in order (repeats the last), records every request. */
export function fakeProvider(outputs: StepOutput[]): InferenceProvider & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  let i = 0;
  return {
    id: "openai",
    model: "fake-model",
    requests,
    async generateStructured(req) {
      requests.push(req);
      const out = outputs[Math.min(i, outputs.length - 1)];
      i++;
      return { output: out, provider: "openai", model: "fake-model" };
    },
  };
}

/** Fake OpenAI /chat/completions fetch that replays step outputs and captures raw bodies. */
export function fakeOpenAiFetch(outputs: StepOutput[]): { fetch: typeof fetch; bodies: string[]; urls: string[] } {
  const bodies: string[] = [];
  const urls: string[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const out = outputs[Math.min(i, outputs.length - 1)];
    i++;
    return new Response(
      JSON.stringify({
        model: "gpt-4.1",
        choices: [{ message: { tool_calls: [{ type: "function", function: { name: "assistant_step", arguments: JSON.stringify(out) } }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: f, bodies, urls };
}
