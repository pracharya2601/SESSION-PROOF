import { describe, expect, it } from "vitest";
import { claimReload, isChunkLoadError, RELOAD_GUARD_MS } from "./chunkReload";

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://x/assets/Review-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/Review-abc.css",
    "'text/html' is not a valid JavaScript MIME type.",
  ])("recognises %s", (msg) => expect(isChunkLoadError(new Error(msg))).toBe(true));

  it("ignores ordinary errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("claimReload", () => {
  it("allows one reload per guard window", () => {
    const s = memStore();
    expect(claimReload(s, 1_000_000)).toBe(true);
    expect(claimReload(s, 1_000_000 + 1_000)).toBe(false);
    expect(claimReload(s, 1_000_000 + RELOAD_GUARD_MS + 1)).toBe(true);
  });
  it("never reloads without storage (no loop guard)", () => {
    expect(claimReload(null)).toBe(false);
  });
});
