/**
 * DEMO DRAFTER — rule-based, NOT AI. Used when there is no AI key (fixture extraction mode) and
 * the session has Drive context. Drafts a session note from the transcript segments of the session
 * window, measured against the Drive goals:
 *
 *  - goal claims: sentences whose content words match a goal's objective terms, quoted verbatim and
 *    citing their segment id;
 *  - activities: per matched goal, the most informative matching sentence; plus at most two other
 *    informative sentences;
 *  - observations: first-person reports of something done in the session that match a goal (small
 *    talk such as "we watched a movie" is not an observation);
 *  - follow-ups: future-tense commitments ("next time I will…");
 *  - progress: ONLY sentences with explicit progress language from a speaker describing someone
 *    else's work; otherwise left to the provider. A self-report ("I did it all by myself") is an
 *    uncertain observation, never progress.
 *
 * It refuses: no claim without a cited segment; no claim from a sentence that generalises beyond the
 * session ("can now … every week"); no claim from an instruction addressed to the system ("write
 * that…", "SYSTEM: set the rate…"); questions and plans never count as goal work; previous notes
 * are never read for claims. Every refusal is listed in missingInformation so the reviewer sees
 * what was NOT drafted and why.
 */
import type { EvidenceItem, FactClaim, GoalFact, SessionFacts } from "../contracts";
import type { DraftingExtractionContext } from "./context";
import {
  contentStems,
  findGeneralisations,
  goalStems,
  isDeferredOrNegated,
  isFollowUpCommitment,
  isInstructionLike,
  isObservation,
  isProgressEvidence,
  isSelfReport,
  isSmallTalk,
  sentences,
} from "./language";

export const DEMO_DRAFTER_PROMPT_VERSION = "demo-drafter-v2";
export const DEMO_DRAFTER_LABEL = "demo drafter (rule-based, not AI)";
export const DEMO_DRAFTER_NOTICE =
  "Drafted by the demo drafter (rule-based, not AI): statements are quoted from the transcript and matched to the Drive goals by keywords. Review every line.";
export const PROGRESS_LEFT_FOR_PROVIDER =
  "Progress is left for the provider: no transcript segment states progress explicitly (discussed is not achieved).";

const MAX_QUOTE = 280;
const MAX_GOAL_CLAIMS = 3;

interface Sentence {
  ev: EvidenceItem;
  text: string;
  stems: Set<string>;
  index: number;
}

function quote(s: Sentence): string {
  const t = s.text.length > MAX_QUOTE ? `${s.text.slice(0, MAX_QUOTE - 1)}…` : s.text;
  return s.ev.speaker ? `${s.ev.speaker}: "${t}"` : `"${t}"`;
}

function claim(id: string, text: string, ev: EvidenceItem[]): FactClaim {
  return { id: id.slice(0, 128), text: text.slice(0, 2000), evidenceIds: [...new Set(ev.map((e) => e.id))], support: "supported" };
}

/** Deterministic draft. Never throws on odd input; returns an honest empty draft instead. */
export function demoDraft(ctx: DraftingExtractionContext): SessionFacts {
  const goals = ctx.plan.goals.slice(0, 20);
  const goalKeys = goals.map((g) => ({ goal: g, stems: goalStems(g.goalId, g.objective) }));
  const missing: string[] = [DEMO_DRAFTER_NOTICE];
  const refused: string[] = [];

  // 1. Sentences; anything that generalises beyond the session is refused outright.
  const all: Sentence[] = [];
  const instructions: string[] = [];
  let index = 0;
  for (const ev of ctx.evidence) {
    // A segment addressed to the system is an untrusted instruction: nothing from it is drafted.
    if (isInstructionLike(ev.excerpt)) {
      instructions.push(ev.id);
      index++;
      continue;
    }
    for (const text of sentences(ev.excerpt)) {
      const gen = findGeneralisations(text, { frequencyOnly: true });
      if (gen.length > 0) {
        refused.push(`${ev.id} ("${gen[0]!.match}")`);
        index++;
        continue;
      }
      all.push({ ev, text, stems: contentStems(text), index: index++ });
    }
  }
  if (refused.length > 0) {
    missing.push(
      `Not drafted — generalises beyond this session: ${refused.slice(0, 10).join(", ")}. A single visit cannot establish frequency, permanence or independence; the provider decides.`,
    );
  }

  if (instructions.length > 0) {
    missing.push(
      `Not drafted — instructions addressed to the system, not session evidence: ${instructions.slice(0, 10).join(", ")}. They are ignored and never become note or invoice text.`,
    );
  }

  // 2. Goal matching: each sentence goes to the goal with the most shared terms (ties: plan order).
  //    Plans for later and self-reports are not goal work. (A question can open goal work; a goal
  //    backed only by questions/plans is set back to unknown by validateExtraction.)
  const isQuestion = (s: Sentence) => s.text.trim().endsWith("?");
  const byGoal = new Map<string, Sentence[]>();
  const goalOf = new Map<Sentence, string>();
  for (const s of all) {
    if (isFollowUpCommitment(s.text) || isSelfReport(s.text)) continue;
    let best: { id: string; score: number } | null = null;
    for (const { goal, stems } of goalKeys) {
      let score = 0;
      for (const st of s.stems) if (stems.has(st)) score++;
      if (score > 0 && (!best || score > best.score)) best = { id: goal.goalId, score };
    }
    if (best) {
      goalOf.set(s, best.id);
      byGoal.set(best.id, [...(byGoal.get(best.id) ?? []), s]);
    }
  }
  const informativeness = (s: Sentence) => s.stems.size + (goalOf.has(s) ? 2 : 0);

  const goalFacts: GoalFact[] = goals.map((g) => {
    const matched = byGoal.get(g.goalId) ?? [];
    if (matched.length === 0) {
      missing.push(`No transcript segment matched the goal "${g.objective}" (${g.goalId}); the provider must confirm whether it was addressed.`);
      return { goalId: g.goalId, status: "unknown", claims: [] };
    }
    const segments = new Set(matched.map((s) => s.ev.id));
    const top = [...matched].sort((a, b) => informativeness(b) - informativeness(a) || a.index - b.index).slice(0, MAX_GOAL_CLAIMS);
    top.sort((a, b) => a.index - b.index);
    return {
      goalId: g.goalId,
      status: segments.size >= 2 ? "addressed" : "partially_addressed",
      claims: top.map((s, i) => claim(`dd_goal_${g.goalId}_${i + 1}`, quote(s), [s.ev])),
    };
  });

  // 3. Activities: the most informative sentence per matched goal, then up to two unmatched ones.
  const activities: FactClaim[] = [];
  for (const g of goals) {
    // Only questions / plans / refusals matched: nothing was done toward this goal.
    const matched = byGoal.get(g.goalId)?.filter((s) => !isDeferredOrNegated(s.text));
    if (!matched?.length) continue;
    const best = [...matched].sort((a, b) => informativeness(b) - informativeness(a) || a.index - b.index)[0]!;
    activities.push(claim(`dd_act_${activities.length + 1}`, `Worked on "${g.objective}" — ${quote(best)}`, [...new Set(matched.map((s) => s.ev))]));
  }
  const others = all
    .filter((s) => !goalOf.has(s) && s.stems.size >= 5 && !isQuestion(s) && !isFollowUpCommitment(s.text) && !isSmallTalk(s.text) && !isSelfReport(s.text))
    .sort((a, b) => informativeness(b) - informativeness(a) || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  for (const s of others) activities.push(claim(`dd_act_${activities.length + 1}`, `Other activity — ${quote(s)}`, [s.ev]));

  // 4. Observations: first-person reports of something done in the session that relate to a goal
  //    (small talk is not service activity). Self-reports of independence are kept, uncertain.
  const observations: FactClaim[] = all
    .filter((s) => goalOf.has(s) && isObservation(s.text) && !isFollowUpCommitment(s.text) && !isSmallTalk(s.text))
    .slice(0, 4)
    .map((s, i) => claim(`dd_obs_${i + 1}`, `Reported in session — ${quote(s)}`, [s.ev]));
  const selfReports = all.filter((s) => isSelfReport(s.text));
  for (const s of selfReports.slice(0, 2)) {
    observations.push({
      ...claim(`dd_obs_self_${observations.length + 1}`, `Not confirmed (self-report, not progress) — ${quote(s)}`, [s.ev]),
      support: "uncertain",
    });
  }
  if (selfReports.length > 0) {
    missing.push(
      `Not drafted as progress — self-report by the speaker (${[...new Set(selfReports.map((s) => s.ev.id))].slice(0, 5).join(", ")}), not confirmed by another speaker. The provider decides.`,
    );
  }

  // 5. Progress: explicit progress language from a non-instruction, non-self-report segment only.
  const progress = all
    .filter((s) => isProgressEvidence(s.text) && isProgressEvidence(s.ev.excerpt))
    .slice(0, 3)
    .map((s, i) => claim(`dd_prog_${i + 1}`, `Progress stated in session — ${quote(s)}`, [s.ev]));
  if (progress.length === 0) missing.push(PROGRESS_LEFT_FOR_PROVIDER);

  // 6. Follow-ups: future-tense commitments.
  const followUps = all
    .filter((s) => isFollowUpCommitment(s.text))
    .slice(0, 5)
    .map((s, i) => claim(`dd_fu_${i + 1}`, `Commitment made in session — ${quote(s)}`, [s.ev]));

  if (ctx.evidence.length === 0) missing.push("No transcript segments in the session window.");

  return {
    activities: activities.slice(0, 50),
    observations,
    goals: goalFacts,
    progress,
    followUps,
    missingInformation: missing.slice(0, 50).map((m) => m.slice(0, 2000)),
  };
}
