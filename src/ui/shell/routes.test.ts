import { describe, expect, it } from "vitest";
import { navKeyOf, parseHash, routeKey } from "./routes";
import { backoffDelay, HEALTH_BACKOFF_MS } from "./ServerBanner";

describe("parseHash edge cases", () => {
  it.each([
    ["", "today"],
    ["#", "today"],
    ["#/", "today"],
    ["#main", "today"], // skip-link target must not 404 into a blank page
    ["#/nope", "today"],
    ["#/runs/", "runs"],
    ["#/connections?connected=google", "connections"],
    ["#/sessions/%E0%A4%A", "today"], // malformed escape
    ["#/recordings", "recordings"],
    ["#/recordings/rec_1", "recording"],
  ])("%s -> %s", (hash, name) => expect(parseHash(hash).name).toBe(name));

  it("decodes detail ids", () => {
    expect(routeKey(parseHash("#/sessions/s%201"))).toBe("session:s 1");
    expect(routeKey(parseHash("#/recordings/rec_a%3Ab"))).toBe("recording:rec_a:b");
    expect(navKeyOf(parseHash("#/recordings/rec_a"))).toBe("recordings");
  });
});

describe("health backoff", () => {
  it("grows then holds at the last step", () => {
    expect(backoffDelay(0)).toBe(HEALTH_BACKOFF_MS[0]);
    expect(backoffDelay(99)).toBe(HEALTH_BACKOFF_MS[HEALTH_BACKOFF_MS.length - 1]);
  });
});
