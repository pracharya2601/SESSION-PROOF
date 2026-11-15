import { describe, expect, it } from "vitest";
import { assistantBundle } from "../../../assistant/testkit";
import type { SessionBundle } from "../../../contracts";
import {
  attentionItems,
  goalChips,
  historyKey,
  initialOpen,
  invoiceTotal,
  loadHistory,
  openingMessage,
  quickReplies,
  removeClaimEdits,
  saveHistory,
  sectionBlockers,
  splitCitations,
  toApiMessages,
  toReviewEdits,
  whatHappened,
  type ChatMessage,
} from "./helpers";

const refused = (b: SessionBundle): SessionBundle => ({
  ...b,
  checks: {
    ...b.checks,
    issues: [
      ...b.checks.issues,
      { code: "CLAIM_EXCEEDS_EVIDENCE", field: "claim:c_obs_1", message: "Refused — ...", blocking: true },
      { code: "UNKNOWN_GOAL_COVERAGE", field: "goal:g2", message: "info", blocking: false },
    ],
  },
});

describe("summary helpers", () => {
  it("attention items: blockers only, refused claims named in plain words", () => {
    const items = attentionItems(refused(assistantBundle()));
    expect(items.map((i) => i.field)).toEqual(["confirmed_duration", "claim"]);
    expect(items[0]!.text).toMatch(/confirmed minutes/);
    expect(items[1]!.text).toContain("Client now travels independently every week.");
  });

  it("what happened prefers the provider's summary, then activities", () => {
    const b = assistantBundle();
    expect(whatHappened(b)).toEqual({ lines: [expect.stringContaining("planned the bus route")], source: "evidence" });
    const own = {
      ...b,
      attestations: [{ id: "a", field: "activity_summary" as const, text: "Planned a trip. Read a timetable.", actorProviderId: "p", attestedAt: "2026-11-13T15:00:00.000Z", bundleRevision: 2 }],
    };
    expect(whatHappened(own)).toEqual({ lines: ["Planned a trip.", "Read a timetable."], source: "provider" });
  });

  it("goal chips, invoice total (estimate) and section blockers / first open accordion", () => {
    const b = refused(assistantBundle());
    expect(goalChips(b).map((g) => [g.goalId, g.providerConfirmed])).toEqual([
      ["g1", false],
      ["g2", false],
    ]);
    expect(invoiceTotal(b)).toEqual({ cents: 11250, estimate: true });
    expect(sectionBlockers(b)).toMatchObject({ note: 1, checklist: 2, invoice: 1 });
    expect(initialOpen(b)).toEqual({ note: true });
    expect(initialOpen({ ...b, checks: { ...b.checks, issues: [] } })).toEqual({});
  });
});

describe("chat helpers", () => {
  it("opening message lists what needs attention (local, never sent)", () => {
    const m = openingMessage(assistantBundle());
    expect(m.local).toBe(true);
    expect(m.content).toMatch(/1 thing needs your input/);
    expect(toApiMessages([m, { id: "u", role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("quick replies cover minutes, goals, summary, refused claims", () => {
    const ids = quickReplies(refused(assistantBundle())).map((q) => q.id);
    expect(ids).toEqual(["minutes", "goal:g1", "goal:g2", "summary", "refused", "misleading"]);
    const minutes = quickReplies(assistantBundle())[0]!;
    expect(minutes.mode).toBe("fill");
    expect(minutes.text.slice(0, minutes.cursor)).toBe("It ran ");
  });

  it("splitCitations turns known ev ids into chips and leaves unknown ones as text", () => {
    expect(splitCitations("Bus [ev_002] and ev_001, not ev_009.", ["ev_001", "ev_002"])).toEqual([
      { kind: "text", text: "Bus " },
      { kind: "cite", id: "ev_002" },
      { kind: "text", text: " and " },
      { kind: "cite", id: "ev_001" },
      { kind: "text", text: ", not ev_009." },
    ]);
    expect(splitCitations("", ["ev_001"])).toEqual([]);
  });

  it("toReviewEdits keeps allowed, non-empty values (including rejectedClaims)", () => {
    expect(
      toReviewEdits({ confirmedMinutes: 45, activitySummary: "  ", goalsAddressed: ["g1", "g1"], rejectedClaims: [{ claimId: "c1", reason: " x y z " }, { claimId: "c2", reason: "" }] }),
    ).toEqual({ confirmedMinutes: 45, goalsAddressed: ["g1"], rejectedClaims: [{ claimId: "c1", reason: "x y z" }] });
    expect(toReviewEdits({ confirmedMinutes: 0 })).toBeNull();
  });

  it("removeClaimEdits keeps earlier removals and requires a reason", () => {
    const b = {
      ...assistantBundle(),
      attestations: [{ id: "a", field: "claim_rejected" as never, text: "c_fu_1\nNot discussed", actorProviderId: "p", attestedAt: "2026-11-13T15:00:00.000Z", bundleRevision: 2 }],
    };
    expect(removeClaimEdits(b, "c_obs_1", "Overstated")).toEqual({
      rejectedClaims: [
        { claimId: "c_fu_1", reason: "Not discussed" },
        { claimId: "c_obs_1", reason: "Overstated" },
      ],
    });
    expect(removeClaimEdits(b, "c_obs_1", "no")).toBeNull();
  });

  it("history storage is per session+revision and survives broken storage", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const key = historyKey("sess_1", 3);
    expect(key).toBe("rv-chat:sess_1:r3");
    const h: ChatMessage[] = [{ id: "1", role: "user", content: "hi" }];
    saveHistory(store, key, h);
    expect(loadHistory(store, key)).toEqual(h);
    expect(loadHistory(store, historyKey("sess_1", 4))).toBeNull();
    mem.set(key, "{bad json");
    expect(loadHistory(store, key)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadHistory(throwing, key)).toBeNull();
    expect(() => saveHistory(throwing, key, h)).not.toThrow();
    expect(loadHistory(null, key)).toBeNull();
  });
});
