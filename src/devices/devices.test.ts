import { describe, expect, it } from "vitest";
import { bearerDeviceKey, generateDeviceKey, hashDeviceKey, isDeviceKey } from "./key";
import { devicePublicOrigin, pairingLink } from "./link";
import { hasDeviceBearer } from "./auth";

describe("device key", () => {
  it("is vfad_ + 43 base64url chars, random, and hashes to sha-256 hex", async () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    expect(a).toMatch(/^vfad_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isDeviceKey(a)).toBe(true);
    expect(isDeviceKey("vfad_short")).toBe(false);
    const h = await hashDeviceKey(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashDeviceKey(a)).toBe(h);
    expect(await hashDeviceKey(b)).not.toBe(h);
    // known vector: sha256("abc")
    expect(await hashDeviceKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("reads only Bearer vfad_ headers", () => {
    const k = generateDeviceKey();
    expect(bearerDeviceKey(`Bearer ${k}`)).toBe(k);
    expect(bearerDeviceKey(`bearer ${k}`)).toBe(k);
    expect(bearerDeviceKey(`Basic ${k}`)).toBeNull();
    expect(bearerDeviceKey("Bearer abc")).toBeNull();
    expect(bearerDeviceKey(undefined)).toBeNull();
    expect(hasDeviceBearer(`Bearer ${k}`)).toBe(true);
    expect(hasDeviceBearer("Bearer something")).toBe(false);
  });
});

describe("pairing link", () => {
  const base = { APP_ORIGIN: "http://localhost:8787" };
  it("server = PUBLIC_APP_ORIGIN, else PUBLIC_STREAM_ORIGIN (ws→http), else APP_ORIGIN", () => {
    expect(devicePublicOrigin({ ...base, PUBLIC_APP_ORIGIN: "http://192.168.1.20:8787/x" })).toBe("http://192.168.1.20:8787");
    expect(devicePublicOrigin({ ...base, PUBLIC_APP_ORIGIN: "ftp://nope", PUBLIC_STREAM_ORIGIN: "wss://field.example.com" })).toBe("https://field.example.com");
    expect(devicePublicOrigin({ ...base, PUBLIC_STREAM_ORIGIN: "ws://192.168.1.20:8787" })).toBe("http://192.168.1.20:8787");
    expect(devicePublicOrigin({ ...base, PUBLIC_STREAM_ORIGIN: "garbage" })).toBe("http://localhost:8787");
    expect(devicePublicOrigin(base)).toBe("http://localhost:8787");
  });

  it("encodes the name", () => {
    const link = pairingLink({ server: "https://field.example.com", key: "vfad_abc", name: "Sam's iPhone & co" });
    expect(link).toBe("glasscam://pair?server=https://field.example.com&key=vfad_abc&name=Sam's%20iPhone%20%26%20co");
    const u = new URL(link);
    expect(u.searchParams.get("server")).toBe("https://field.example.com");
    expect(u.searchParams.get("key")).toBe("vfad_abc");
    expect(u.searchParams.get("name")).toBe("Sam's iPhone & co");
  });
});
