import { describe, expect, it } from "vitest";
import { deriveReviewToken, hashReviewToken, isReviewToken, newReviewLinkId, reviewLinkSecret } from "./token";
import { readyEmail, safeRef } from "../notify/content";

describe("review-link tokens", () => {
  const secret = reviewLinkSecret({ SESSION_SECRET: "x".repeat(32) })!;

  it("needs a usable SESSION_SECRET", () => {
    expect(reviewLinkSecret({})).toBeNull();
    expect(reviewLinkSecret({ SESSION_SECRET: "short" })).toBeNull();
  });

  it("is vfrl_ + 43 base64url chars, deterministic per link id and secret, hashed as hex", async () => {
    const id = newReviewLinkId();
    expect(id).toMatch(/^rl_[A-Za-z0-9_-]{22}$/);
    const a = await deriveReviewToken(secret, id);
    expect(isReviewToken(a)).toBe(true);
    expect(await deriveReviewToken(secret, id)).toBe(a);
    expect(await deriveReviewToken(secret, newReviewLinkId())).not.toBe(a);
    expect(await deriveReviewToken(reviewLinkSecret({ SESSION_SECRET: "y".repeat(32) })!, id)).not.toBe(a);
    expect(await hashReviewToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(isReviewToken("vfad_" + "A".repeat(43))).toBe(false);
  });
});

describe("notification content", () => {
  it("only carries safe fields", () => {
    expect(safeRef("C-104")).toBe("C-104");
    expect(safeRef("<b>Sam</b>\r\n")).toBe("bSamb");
    expect(safeRef("")).toBe("a client");
    const m = readyEmail({
      clientRef: "C-104",
      startAt: "2026-11-13T15:00:00.000Z",
      timezone: "America/Chicago",
      minutes: { value: 90, confirmed: false },
      blockingCount: 2,
      url: "https://field.example/r/vfrl_x",
      expiresAt: "2026-11-20T15:00:00.000Z",
    });
    expect(m.subject).toBe("Visit for C-104 is ready for review");
    expect(m.text).toContain("Service date: Fri, Nov 13, 2026");
    expect(m.text).toContain("Minutes: 90 min (estimate)");
    expect(m.text).toContain("Blockers to fix: 2");
    expect(m.html).toContain('href="https://field.example/r/vfrl_x"');
  });
});
