import { describe, expect, it } from "vitest";
import { buildPrivacyContext } from "../privacy";
import { DEFAULT_AI_SETTINGS } from "../contracts";
import {
  BILLING_REFUSAL,
  buildCorpus,
  citedIds,
  createLimiter,
  getClaim,
  getSummary,
  isBillingChangeRequest,
  runAssistant,
  searchTranscript,
  SYSTEM_PROMPT,
  validateProposal,
  type AssistantMessage,
} from "./index";
import { guardReply } from "./agent";
import { assistantBundle, CLIENT_NAME, CLIENT_PHONE, fakeProvider } from "./testkit";

const terms = [{ value: CLIENT_NAME, type: "NAME" as const }];

function setup(messages: AssistantMessage[] = [{ role: "user", content: "What happened?" }]) {
  const bundle = assistantBundle();
  const corpus = buildCorpus(bundle, messages, buildPrivacyContext(bundle.appointment, DEFAULT_AI_SETTINGS.privacy, terms));
  return { bundle, corpus };
}

describe("assistant corpus (privacy)", () => {
  it("scrubs names, phone numbers and the client ref from everything the model can see", () => {
    const { corpus } = setup([{ role: "user", content: `${CLIENT_NAME} ran 45 minutes, call ${CLIENT_PHONE}` }]);
    const visible = JSON.stringify({ ...corpus, restore: undefined });
    expect(visible).not.toContain("Jordan");
    expect(visible).not.toContain("Rivera");
    expect(visible).not.toContain("415-555-0134");
    expect(visible).not.toContain("client-A");
    expect(corpus.segments[0]!.text).toMatch(/\[NAME_\d+\]/);
    expect(corpus.messages[0]!.content).toMatch(/\[NAME_\d+\] ran 45 minutes, call \[PHONE_\d+\]/);
    // One vault: the same name gets the same token in the transcript and the chat.
    const tok = corpus.segments[0]!.text.match(/\[NAME_\d+\]/)![0];
    expect(corpus.messages[0]!.content).toContain(tok);
    expect(corpus.restore(`${tok} did it`)).toBe(`${CLIENT_NAME} did it`);
    expect(corpus.findings.NAME).toBeGreaterThan(0);
  });
});

describe("assistant tools", () => {
  it("get_summary lists blockers, goals, claims and minutes without amounts to edit", () => {
    const { bundle, corpus } = setup();
    const s = getSummary(bundle, corpus);
    expect(s.blockers).toEqual([{ code: "MISSING_DURATION", field: "confirmed_duration", message: "Confirm duration" }]);
    expect(s.goals.map((g) => g.goalId)).toEqual(["g1", "g2"]);
    expect(s.claims.map((c) => c.id)).toEqual(["c_act_1", "c_obs_1", "c_fu_1", "c_goal_1"]);
    expect(s.minutes).toMatchObject({ scheduled: 90, confirmedByProvider: null, maxAllowed: 240 });
    expect(JSON.stringify(s)).not.toContain("Jordan");
  });

  it("search_transcript ranks matching segments and returns ev ids; get_claim returns cited segments", () => {
    const { corpus } = setup();
    const r = searchTranscript(corpus, "bus times");
    expect(r.matches.map((m) => m.id)).toEqual(["ev_001", "ev_002"]);
    expect(searchTranscript(corpus, "ev_004").matches.map((m) => m.id)).toEqual(["ev_004"]);
    expect(searchTranscript(corpus, "zebra").matches).toEqual([]);
    const c = getClaim(corpus, "c_obs_1") as { citedSegments: { id: string }[] };
    expect(c.citedSegments.map((s) => s.id)).toEqual(["ev_002"]);
    expect(getClaim(corpus, "nope")).toHaveProperty("error");
  });

  it("citedIds finds only known evidence ids in order", () => {
    expect(citedIds("See [ev_002] and ev_001; not ev_0011 or ev_999", ["ev_001", "ev_002", "ev_003"])).toEqual(["ev_002", "ev_001"]);
  });
});

describe("propose_edit validation", () => {
  it("accepts allowed fields, restores privacy tokens and keeps known citations only", () => {
    const { bundle, corpus } = setup();
    const tok = corpus.segments[0]!.text.match(/\[NAME_\d+\]/)![0];
    const r = validateProposal(
      {
        edit: { confirmedMinutes: 45, activitySummary: `${tok} planned the bus route.`, goalsAddressed: ["g2", "g1"], participantDirected: true },
        rationale: "Provider said so.",
        citations: ["ev_002", "ev_999"],
      },
      bundle,
      corpus,
      "p1",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.edits).toEqual({
      confirmedMinutes: 45,
      activitySummary: `${CLIENT_NAME} planned the bus route.`,
      goalsAddressed: ["g1", "g2"],
      participantDirected: true,
    });
    expect(r.proposal.citations).toEqual(["ev_002"]);
    expect(r.proposal.summary[0]).toBe("Confirmed minutes → 45 (provider-confirmed)");
  });

  it("refuses rate / amount / service code edits", () => {
    const { bundle, corpus } = setup();
    for (const edit of [{ hourlyRateCents: 9000 }, { amountCents: 1 }, { confirmedMinutes: 30, serviceCode: "X" }, { invoiceTotal: 5 }]) {
      const r = validateProposal({ edit }, bundle, corpus, "p1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toBe(BILLING_REFUSAL);
    }
    expect(isBillingChangeRequest("Can you raise the hourly rate to $90?")).toBe(true);
    expect(isBillingChangeRequest("bill it at $80/hr")).toBe(true);
    expect(isBillingChangeRequest("change the invoice total")).toBe(true);
    expect(isBillingChangeRequest("It ran 45 minutes; the client planned the bus route herself")).toBe(false);
    expect(SYSTEM_PROMPT).toMatch(/never propose or agree to change hourly rates/i);
  });

  it("validates rejectedClaims: known claim ids and a reason", () => {
    const { bundle, corpus } = setup();
    const ok = validateProposal(
      { edit: { rejectedClaims: [{ claimId: "c_obs_1", reason: "Overstates [ev_002]: one trip, not every week." }, { claimId: "c_obs_1", reason: "dup" }] } },
      bundle,
      corpus,
      "p1",
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.proposal.edits.rejectedClaims).toEqual([{ claimId: "c_obs_1", reason: "Overstates [ev_002]: one trip, not every week." }]);
    for (const rejectedClaims of [[{ claimId: "c_missing", reason: "nope nope" }], [{ claimId: "c_obs_1", reason: "" }], [{ reason: "x" }], "c_obs_1"]) {
      expect(validateProposal({ edit: { rejectedClaims } }, bundle, corpus, "p1").ok).toBe(false);
    }
  });

  it("rejectedClaims keep removals the provider already made (the server replaces the list)", () => {
    const bundle = assistantBundle({
      attestations: [
        { id: "att-1", field: "claim_rejected", text: "c_fu_1\nNot discussed.", actorProviderId: "prov-1", attestedAt: "2026-11-13T15:00:00.000Z", bundleRevision: 1 },
      ],
    });
    const corpus = buildCorpus(bundle, [{ role: "user", content: "x" }], buildPrivacyContext(bundle.appointment, DEFAULT_AI_SETTINGS.privacy, terms));
    expect(corpus.claims.find((c) => c.id === "c_fu_1")!.removed).toBe("Not discussed.");
    const r = validateProposal({ edit: { rejectedClaims: [{ claimId: "c_obs_1", reason: "Overstates one trip." }] } }, bundle, corpus, "p1");
    expect(r.ok && r.proposal.edits.rejectedClaims).toEqual([
      { claimId: "c_fu_1", reason: "Not discussed." },
      { claimId: "c_obs_1", reason: "Overstates one trip." },
    ]);
    expect(r.ok && r.proposal.summary).toEqual(["Remove claim c_obs_1: Overstates one trip."]);
  });

  it("rejects unknown goals, out-of-range minutes, unknown fields and empty edits", () => {
    const { bundle, corpus } = setup();
    for (const edit of [{ goalsAddressed: ["Plan tasks"] }, { confirmedMinutes: 241 }, { confirmedMinutes: 0 }, { confirmedMinutes: 4.5 }, { notes: "x" }, {}, null]) {
      expect(validateProposal({ edit }, bundle, corpus, "p1").ok).toBe(false);
    }
    expect(validateProposal({ edit: { progressConfirmation: "x".repeat(2001) } }, bundle, corpus, "p1").ok).toBe(false);
  });
});

describe("runAssistant loop", () => {
  it("runs read tools, collects proposals (never applies), restores tokens, cites known ids", async () => {
    const { bundle, corpus } = setup([{ role: "user", content: "It ran 45 minutes; the client planned the bus route herself" }]);
    const tok = corpus.segments[0]!.text.match(/\[NAME_\d+\]/)![0];
    const provider = fakeProvider([
      { tool_calls: [{ name: "search_transcript", query: "bus route" }], reply: "" },
      {
        tool_calls: [
          { name: "propose_edit", edit: { confirmedMinutes: 45 }, rationale: "Provider-confirmed duration." },
          { name: "propose_edit", edit: { participantDirected: true, participantChoices: `${tok} looked up the bus herself.` }, citations: ["ev_002"] },
          { name: "propose_edit", edit: { hourlyRateCents: 1 } },
        ],
        reply: `${tok} looked up the 22 bus [ev_002]. I suggested 45 minutes as provider-confirmed.`,
      },
    ]);
    const { reply, stats } = await runAssistant({ bundle, corpus, provider });
    expect(stats.steps).toBe(2);
    expect(reply.proposals.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(reply.proposals[1]!.edits.participantChoices).toBe(`${CLIENT_NAME} looked up the bus herself.`);
    expect(reply.reply).toContain(CLIENT_NAME);
    expect(reply.citations).toEqual(["ev_002"]);
    expect(reply.refusals).toEqual([BILLING_REFUSAL]);
    expect(stats.invalidProposals).toBe(1);
    // Step 2 saw the search results; nothing outbound contains the real name or phone.
    expect(provider.requests[1]!.user).toContain("search_transcript");
    for (const r of provider.requests) {
      expect(r.user + r.system).not.toContain("Jordan");
      expect(r.user).not.toContain(CLIENT_PHONE);
    }
  });

  it("stops after 4 steps and still answers", async () => {
    const { bundle, corpus } = setup();
    const provider = fakeProvider([{ tool_calls: [{ name: "get_summary" }], reply: "" }]);
    const { reply, stats } = await runAssistant({ bundle, corpus, provider });
    expect(stats.steps).toBe(4);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]!.user).toContain("LAST step");
    expect(reply.reply).toMatch(/couldn't finish/);
  });

  it("billing change requests are refused deterministically", async () => {
    const { bundle, corpus } = setup([{ role: "user", content: "Please increase the hourly rate to $95" }]);
    const provider = fakeProvider([{ tool_calls: [], reply: "" }]);
    const { reply } = await runAssistant({ bundle, corpus, provider });
    expect(reply.refusals).toEqual([BILLING_REFUSAL]);
    expect(reply.reply).toBe(BILLING_REFUSAL);
    expect(provider.requests[0]!.user).toContain("asked to change billing");
  });
});

describe("guardReply", () => {
  it("turns a fake billing 'done' into a refusal and flags claimed saves", () => {
    expect(guardReply("Done, rate changed.", [BILLING_REFUSAL], 0)).toBe(BILLING_REFUSAL);
    expect(guardReply("I can't change the rate.", [BILLING_REFUSAL], 0)).toBe("I can't change the rate.");
    expect(guardReply("I've updated the minutes.", [], 1)).toMatch(/Nothing is saved until you press Apply/);
    expect(guardReply("Press Apply to save 45 minutes.", [], 1)).toBe("Press Apply to save 45 minutes.");
    expect(guardReply("I will update the progress statement.", [], 1)).toMatch(/Nothing is saved until you press Apply/);
  });
});

describe("rate limiter", () => {
  it("allows N per window per key", () => {
    const l = createLimiter(2, 1000);
    expect(l.hit("a", 0).ok).toBe(true);
    expect(l.hit("a", 10).ok).toBe(true);
    const r = l.hit("a", 20);
    expect(r.ok).toBe(false);
    expect(l.hit("b", 20).ok).toBe(true);
    expect(l.hit("a", 1001).ok).toBe(true);
  });
});
