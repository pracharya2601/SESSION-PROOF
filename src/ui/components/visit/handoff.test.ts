import { describe, expect, it } from "vitest";
import { glasscamLink, handoffFinished, streamHostIsLoopback } from "./handoff";

const STREAM = "ws://192.168.1.20:8787/api/visits/visit_ab12/stream";
const TOKEN = "a.b+c/=";

describe("glasscamLink", () => {
  it("encodes the stream URL and token separately and carries band number and client ref", () => {
    const link = glasscamLink({ streamUrl: STREAM, streamToken: TOKEN, bandNumber: 42, clientRef: "C-104" });
    expect(link).toBe(`glasscam://band-visit?stream=${encodeURIComponent(STREAM)}&token=${encodeURIComponent(TOKEN)}&band=42&client=C-104`);
    const u = new URL(link);
    expect(u.protocol).toBe("glasscam:");
    expect(u.searchParams.get("stream")).toBe(STREAM);
    expect(new URL(u.searchParams.get("stream")!.replace(/^ws/, "http")).searchParams.has("token")).toBe(false);
    expect(u.searchParams.get("token")).toBe(TOKEN);
    expect(u.searchParams.get("band")).toBe("42");
    expect(u.searchParams.get("client")).toBe("C-104");
  });

  it("omits band when no number was given and encodes the client ref", () => {
    const link = glasscamLink({ streamUrl: STREAM, streamToken: TOKEN, bandNumber: null, clientRef: "C 1&2" });
    const u = new URL(link);
    expect(u.searchParams.has("band")).toBe(false);
    expect(u.searchParams.get("client")).toBe("C 1&2");
  });
});

describe("streamHostIsLoopback", () => {
  it("flags hosts a phone can't reach", () => {
    expect(streamHostIsLoopback("ws://localhost:8787/api/visits/v/stream?token=t")).toBe(true);
    expect(streamHostIsLoopback("ws://127.0.0.1:8787/x")).toBe(true);
    expect(streamHostIsLoopback("ws://[::1]:8787/x")).toBe(true);
    expect(streamHostIsLoopback(STREAM)).toBe(false);
    expect(streamHostIsLoopback("wss://field.example.com/x")).toBe(false);
    expect(streamHostIsLoopback("not a url")).toBe(false);
  });
});

describe("handoffFinished", () => {
  it("returns the session id only once the visit is stopped with a session", () => {
    expect(handoffFinished({ status: "recording", sessionId: null })).toBeNull();
    expect(handoffFinished({ status: "stopped", sessionId: null })).toBeNull();
    expect(handoffFinished({ status: "stopped", sessionId: "sess_1" })).toBe("sess_1");
  });
});
