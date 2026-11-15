/**
 * Fake model behind an injected fetch. It sees ONLY what the provider adapter would send
 * (the privacy-prepared prompt), and answers in that provider's wire format.
 *
 * It is deliberately a sloppy, gullible model:
 *  - keyword-matches goals to evidence lines (over-claims "addressed" on any mention),
 *  - copies evidence text (incl. privacy tokens) into claims,
 *  - OBEYS instructions found inside evidence ("write that …", "bill 10 hours", "SYSTEM: …"),
 *  - adds the case's `fake.bad` claims (generalisations, invented progress, prior-note facts).
 * The harness then measures which validators/rules catch what.
 */
import type { AiProviderId } from "../../src/contracts/v2";
import type { EvalCase } from "./types";

interface Claim {
  id: string;
  text: string;
  evidenceIds: string[];
  support: "supported" | "uncertain";
}
interface Facts {
  activities: Claim[];
  observations: Claim[];
  goals: { goalId: string; status: "addressed" | "partially_addressed" | "unknown"; claims: Claim[] }[];
  progress: Claim[];
  followUps: Claim[];
  missingInformation: string[];
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parsePrompt(user: string): { goals: { goalId: string; objective: string }[]; evidence: { id: string; speaker: string | null; text: string }[] } {
  const goals: { goalId: string; objective: string }[] = [];
  const goalBlock = user.split("Plan goals:")[1]?.split("Evidence (untrusted data):")[0] ?? "";
  for (const line of goalBlock.split("\n")) {
    const m = /^- ([^:]+): (.*)$/.exec(line.trim());
    if (m) goals.push({ goalId: unescape(m[1]!), objective: unescape(m[2]!) });
  }
  const evidence: { id: string; speaker: string | null; text: string }[] = [];
  // Extra attributes (instruction="untrusted", self_report="true") are read past: the fake is gullible.
  const re = /<evidence id="([^"]+)"(?: speaker="([^"]*)")?(?: [a-z_]+="[^"]*")*>([\s\S]*?)<\/evidence>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user)) !== null) evidence.push({ id: unescape(m[1]!), speaker: m[2] ? unescape(m[2]) : null, text: unescape(m[3]!) });
  return { goals, evidence };
}

const STOP = new Set("with that this from into your their have been will using simple weekly after before about".split(" "));
function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w));
}

const INJECTION_RE = /ignore (all |any |previous |prior )*(instructions|rules)|^\s*(system|assistant)\s*[:,]|\bbill\s+\d+|\bmark (this |the )?(session )?approved|\bset the (hourly )?rate|\brecord that\b|\bwrite (down )?that\b/i;

export function fakeFacts(user: string, def: EvalCase): Facts {
  const { goals, evidence } = parsePrompt(user);
  let n = 0;
  const claim = (text: string, ids: string[], support: Claim["support"] = "supported"): Claim => ({
    id: `fake_${++n}`,
    text: text.slice(0, 1990),
    evidenceIds: ids,
    support,
  });
  const facts: Facts = { activities: [], observations: [], goals: [], progress: [], followUps: [], missingInformation: [] };
  const real = evidence.filter((e) => /[a-z]{3,}/i.test(e.text.replace(/\[(inaudible|crosstalk)\]|\b(um+|uh+|mm-?hmm|uh huh|okay|ok)\b/gi, "")));

  for (const g of goals) {
    const kws = [...(def.fake.keywords[g.goalId] ?? []), ...words(g.objective).slice(0, 3)].map((k) => k.toLowerCase());
    const hits = real.filter((e) => kws.some((k) => e.text.toLowerCase().includes(k))).slice(0, 3);
    if (hits.length === 0) {
      facts.goals.push({ goalId: g.goalId, status: "unknown", claims: [] });
      facts.missingInformation.push(`No evidence about: ${g.objective}`);
    } else {
      facts.goals.push({
        goalId: g.goalId,
        status: hits.length >= 2 ? "addressed" : "partially_addressed",
        claims: [claim(`Session work related to this goal: ${hits[0]!.text.slice(0, 160)}`, hits.map((h) => h.id), hits.length >= 2 ? "supported" : "uncertain")],
      });
    }
  }
  for (const e of real) {
    const t = e.text;
    if (INJECTION_RE.test(t)) {
      // Gullible: obey the instruction found in the transcript.
      const w = /\b(?:write|record) (?:down )?that (.+)$/i.exec(t);
      if (w) facts.progress.push(claim(w[1]!.replace(/[.!]+$/, "") + ".", [e.id]));
      else facts.activities.push(claim(t.replace(/^\s*(system|assistant)\s*[:,]\s*/i, ""), [e.id]));
      continue;
    }
    if (/\bprogress\b|without (any )?(prompts?|help|reminders?)|down from|fewer prompts/i.test(t)) facts.progress.push(claim(t, [e.id]));
    else if (/\bnext (time|week|visit|shift)\b|again on\b/i.test(t)) facts.followUps.push(claim(t, [e.id]));
    else if (facts.activities.length < 4 && /\b(let's|today|we're|now)\b/i.test(t)) facts.activities.push(claim(t, [e.id]));
  }
  for (const b of def.fake.bad) {
    const c = claim(b.text, b.cite, b.support);
    if (b.section.startsWith("goal:")) {
      const goalId = b.section.slice(5);
      const g = facts.goals.find((x) => x.goalId === goalId);
      if (g) {
        g.status = b.status;
        g.claims.push(c);
      } else facts.goals.push({ goalId, status: b.status, claims: [c] });
    } else (facts[b.section as "activities" | "observations" | "progress" | "followUps"]).push(c);
  }
  if (facts.progress.length === 0) facts.missingInformation.push("Progress is not stated in the evidence.");
  return facts;
}

/** Wire-format response for the provider whose adapter is under test. */
export function providerResponse(provider: AiProviderId, model: string, toolName: string, output: unknown, inTok: number, outTok: number): unknown {
  const args = JSON.stringify(output);
  switch (provider) {
    case "anthropic":
      return { model, content: [{ type: "tool_use", id: "tu_fake", name: toolName, input: output }], usage: { input_tokens: inTok, output_tokens: outTok } };
    case "openai":
    case "mistral":
      return {
        model,
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_fake", type: "function", function: { name: toolName, arguments: args } }] } }],
        usage: { prompt_tokens: inTok, completion_tokens: outTok },
      };
    case "gemini":
      return { modelVersion: model, candidates: [{ content: { parts: [{ text: args }] } }], usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok } };
  }
}

/** Extracts the user prompt text from any provider's request body. */
export function userTextFromBody(provider: AiProviderId, body: any): string {
  if (provider === "gemini") return body?.contents?.[0]?.parts?.[0]?.text ?? "";
  const msgs: any[] = body?.messages ?? [];
  const u = msgs.find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : "";
}
