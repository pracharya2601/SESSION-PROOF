import { describe, expect, it } from "vitest";
import { EvidenceUnavailableError } from "../../contracts";
import {
  assertIssuer,
  assertSafeRedirect,
  base64UrlDecode,
  base64UrlEncode,
  createOAuthState,
  createPkcePair,
  notConfiguredTokenProvider,
  pkceChallenge,
  verifyOAuthState,
  VexoAuthError,
} from "./index";

const SECRET = "test-secret-value";
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);

function expectThrowsAuth(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(VexoAuthError);
  expect((caught as VexoAuthError).code).toBe(code);
}

async function expectAuthError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(VexoAuthError);
    expect((e as VexoAuthError).code).toBe(code);
    return;
  }
  throw new Error(`expected VexoAuthError ${code}`);
}

describe("notConfiguredTokenProvider", () => {
  it("reports not connected", async () => {
    expect(await notConfiguredTokenProvider.connectionStatus("u1")).toEqual({
      connected: false,
      detail: expect.any(String),
    });
  });
  it("throws non-retryable not_configured", async () => {
    const err = await notConfiguredTokenProvider.getAccessToken("u1").catch((e) => e);
    expect(err).toBeInstanceOf(EvidenceUnavailableError);
    expect(err.kind).toBe("not_configured");
    expect(err.retryable).toBe(false);
  });
});

describe("base64url", () => {
  it("round-trips without padding or unsafe chars", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1, 2]);
    const s = base64UrlEncode(bytes);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(base64UrlDecode(s))).toEqual(Array.from(bytes));
  });
});

describe("createPkcePair", () => {
  it("produces an S256 pair with valid verifier", async () => {
    const p = await createPkcePair();
    expect(p.codeChallengeMethod).toBe("S256");
    expect(p.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(p.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pkceChallenge(p.codeVerifier)).toBe(p.codeChallenge);
  });
  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  it("is random per call", async () => {
    const [a, b] = await Promise.all([createPkcePair(), createPkcePair()]);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("OAuth state", () => {
  it("round-trips and exposes nonce for one-time storage", async () => {
    const { state, nonce } = await createOAuthState("prov-1", SECRET, T0);
    const v = await verifyOAuthState(state, "prov-1", SECRET, T0 + 5_000);
    expect(v).toEqual({ providerId: "prov-1", nonce, issuedAt: Math.floor(T0 / 1000) });
  });
  it("accepts Date for now", async () => {
    const { state } = await createOAuthState("prov-1", SECRET, new Date(T0));
    await expect(verifyOAuthState(state, "prov-1", SECRET, new Date(T0))).resolves.toBeTruthy();
  });
  it("nonces differ between states", async () => {
    const a = await createOAuthState("p", SECRET, T0);
    const b = await createOAuthState("p", SECRET, T0);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });
  it("rejects a different user", async () => {
    const { state } = await createOAuthState("prov-1", SECRET, T0);
    await expectAuthError(verifyOAuthState(state, "prov-2", SECRET, T0), "state_binding");
  });
  it("rejects a wrong secret", async () => {
    const { state } = await createOAuthState("prov-1", SECRET, T0);
    await expectAuthError(verifyOAuthState(state, "prov-1", "other", T0), "invalid_state");
  });
  it("rejects expiry past maxAge and honours custom maxAge", async () => {
    const { state } = await createOAuthState("prov-1", SECRET, T0);
    await expect(verifyOAuthState(state, "prov-1", SECRET, T0 + 600_000)).resolves.toBeTruthy();
    await expectAuthError(verifyOAuthState(state, "prov-1", SECRET, T0 + 601_000), "state_expired");
    await expectAuthError(verifyOAuthState(state, "prov-1", SECRET, T0 + 61_000, 60), "state_expired");
  });
  it("rejects states issued in the future beyond skew", async () => {
    const { state } = await createOAuthState("prov-1", SECRET, T0 + 120_000);
    await expectAuthError(verifyOAuthState(state, "prov-1", SECRET, T0), "state_expired");
  });
  it("rejects tampered payloads", async () => {
    const { state } = await createOAuthState("prov-1", SECRET, T0);
    const [, sig] = state.split(".");
    const forged = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ v: 1, p: "prov-2", iat: T0 / 1000, n: "x" })),
    );
    await expectAuthError(verifyOAuthState(`${forged}.${sig}`, "prov-2", SECRET, T0), "invalid_state");
  });
  it("rejects malformed input", async () => {
    for (const bad of ["", "abc", "a.b.c", ".", "a.", "!!.??"]) {
      await expectAuthError(verifyOAuthState(bad, "prov-1", SECRET, T0), "invalid_state");
    }
  });
  it("requires providerId and secret", async () => {
    await expect(createOAuthState("", SECRET, T0)).rejects.toThrow();
    await expect(createOAuthState("p", "", T0)).rejects.toThrow();
  });
});

describe("assertSafeRedirect", () => {
  const app = "https://app.example.com";
  it("allows same-origin absolute and relative targets", () => {
    expect(assertSafeRedirect("https://app.example.com/#/sessions/1", app)).toBe(
      "https://app.example.com/#/sessions/1",
    );
    expect(assertSafeRedirect("/settings?x=1", app)).toBe("https://app.example.com/settings?x=1");
  });
  it("rejects other origins and tricks", () => {
    for (const bad of [
      "https://evil.example.com/",
      "//evil.example.com/x",
      "http://app.example.com/", // scheme differs
      "https://app.example.com:8443/",
      "https://app.example.com.evil.com/",
      "https://user:pw@app.example.com/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/\\evil.example.com",
      "\\\\evil.example.com",
      "",
      "   ",
    ]) {
      expectThrowsAuth(() => assertSafeRedirect(bad, app), "unsafe_redirect");
    }
  });
  it("rejects an invalid app origin", () => {
    expectThrowsAuth(() => assertSafeRedirect("/x", "not a url"), "unsafe_redirect");
  });
});

describe("assertIssuer", () => {
  it("accepts an exact match", () => {
    expect(() => assertIssuer("https://auth.vexo.example", "https://auth.vexo.example")).not.toThrow();
  });
  it("rejects mismatch, missing, and near-matches", () => {
    for (const actual of [undefined, null, "", "https://auth.vexo.example/", "https://evil.example"]) {
      expectThrowsAuth(() => assertIssuer("https://auth.vexo.example", actual), "issuer_mismatch");
    }
    expectThrowsAuth(() => assertIssuer("", ""), "issuer_mismatch");
  });
});
