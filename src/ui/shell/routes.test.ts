import { describe, expect, it } from "vitest";
import { parseHash, routeKey } from "./routes";
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
  ])("%s -> %s", (hash, name) => expect(parseHash(hash).name).toBe(name));

  it("decodes detail ids", () => {
    expect(routeKey(parseHash("#/sessions/s%201"))).toBe("session:s 1");
  });
});

describe("health backoff", () => {
  it("grows then holds at the last step", () => {
    expect(backoffDelay(0)).toBe(HEALTH_BACKOFF_MS[0]);
    expect(backoffDelay(99)).toBe(HEALTH_BACKOFF_MS[HEALTH_BACKOFF_MS.length - 1]);
  });
});
