import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../contracts";
import { nextPollDelay, POLL_ERROR_MAX_MS, POLL_FAST_MS, POLL_SLOW_MS } from "./todayPolling";

const s = (status: SessionSummary["status"]) => ({ status }) as SessionSummary;

describe("nextPollDelay", () => {
  it("polls fast only while the pipeline is working", () => {
    expect(nextPollDelay([s("PROCESSING"), s("NEEDS_REVIEW")], 0)).toBe(POLL_FAST_MS);
    expect(nextPollDelay([s("APPROVED")], 0)).toBe(POLL_FAST_MS);
    expect(nextPollDelay([s("WAITING_FOR_EVIDENCE")], 0)).toBe(POLL_SLOW_MS);
  });
  it("backs off on consecutive errors, capped", () => {
    expect(nextPollDelay(null, 1)).toBe(POLL_FAST_MS * 2);
    expect(nextPollDelay(null, 2)).toBe(POLL_FAST_MS * 4);
    expect(nextPollDelay(null, 10)).toBe(POLL_ERROR_MAX_MS);
  });
});
