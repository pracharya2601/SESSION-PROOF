import { describe, expect, it } from "vitest";
import { EvidenceUnavailableError, type Appointment } from "../../contracts";
import type { Env } from "../../env";
import { demoAppointment, fixtureClock } from "../../../fixtures/scenario";
import { midnightAppointment } from "../../../fixtures/variants";
import { createEvidenceSource, LiveEvidenceSource, VEXO_TOOL_CONFIG, type VexoMcpClient } from "./index";
import { localDaysForWindow } from "./time";

const env = (over: Partial<Env>): Env => ({ EVIDENCE_MODE: "fixture", ...over }) as Env;

type Handler = (args: Record<string, unknown>, call: number) => unknown;
function fakeClient(handler: Handler) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: VexoMcpClient = {
    async callTool(name, args) {
      calls.push({ name, args });
      return handler(args, calls.length);
    },
  };
  return { client, calls };
}
const noSleep = { sleeps: [] as number[] };
const live = (client: VexoMcpClient, config?: Record<string, number>) => {
  noSleep.sleeps = [];
  return new LiveEvidenceSource(client, {
    clock: fixtureClock,
    sleep: async (ms) => void noSleep.sleeps.push(ms),
    config,
  });
};
const seg = (i: number, at = `2026-11-13T18:${String(10 + (i % 40)).padStart(2, "0")}:00Z`) => ({
  id: `seg_${i}`,
  transcript_id: "tr_1",
  start_time: at,
  end_time: at,
  speaker: "Speaker 1",
  text: `line ${i}`,
});

describe("createEvidenceSource", () => {
  it("live mode without a client rejects not_configured (no fixture fallback)", async () => {
    const src = createEvidenceSource(env({ EVIDENCE_MODE: "live" }));
    expect(src.mode).toBe("live");
    const err = await src.retrieveEvidence(demoAppointment).catch((e) => e);
    expect(err).toBeInstanceOf(EvidenceUnavailableError);
    expect(err).toMatchObject({ kind: "not_configured", retryable: false });
  });

  it("fixture normal returns window items with fixture mode", async () => {
    const src = createEvidenceSource(env({ EVIDENCE_MODE: "fixture" }));
    expect(src.mode).toBe("fixture");
    const r = await src.retrieveEvidence(demoAppointment);
    expect(r.items.length).toBe(5);
    expect(r.completeness).toBe("complete");
    expect(r.items.every((i) => i.sourceMode === "fixture")).toBe(true);
  });

  it("fixture items outside the ±60 min window are excluded", async () => {
    const src = createEvidenceSource(env({ FIXTURE_VARIANT: "normal" }));
    const later: Appointment = { ...demoAppointment, startAt: "2026-11-13T22:00:00.000Z", endAt: "2026-11-13T23:00:00.000Z" };
    expect((await src.retrieveEvidence(later)).items).toEqual([]);
  });

  it("fixture upstream-error variant throws transport/retryable", async () => {
    const src = createEvidenceSource(env({ FIXTURE_VARIANT: "upstream-error" }));
    await expect(src.retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "transport", retryable: true });
  });

  it("fixture partial-evidence keeps completeness and warnings", async () => {
    const r = await createEvidenceSource(env({ FIXTURE_VARIANT: "partial-evidence" })).retrieveEvidence(demoAppointment);
    expect(r.completeness).toBe("partial");
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.unavailableSourceIds.length).toBe(1);
  });

  it("live mode with a client returns a LiveEvidenceSource", () => {
    const { client } = fakeClient(() => ({ segments: [] }));
    expect(createEvidenceSource(env({ EVIDENCE_MODE: "live" }), { mcpClient: client })).toBeInstanceOf(LiveEvidenceSource);
  });
});

describe("LiveEvidenceSource", () => {
  it("paginates and marks partial when the page cap is hit", async () => {
    const { client, calls } = fakeClient((_a, n) => ({ segments: [seg(n)], next_cursor: `c${n}` }));
    const r = await live(client, { maxPagesPerDay: 3 }).retrieveEvidence(demoAppointment);
    expect(calls.length).toBe(3);
    expect(calls[1]!.args[VEXO_TOOL_CONFIG.args.cursor]).toBe("c1");
    expect(calls[0]!.args[VEXO_TOOL_CONFIG.args.cursor]).toBeUndefined();
    expect(calls[0]!.name).toBe(VEXO_TOOL_CONFIG.toolName);
    expect(r.items.length).toBe(3);
    expect(r.completeness).toBe("partial");
    expect(r.warnings.join(" ")).toMatch(/Page limit/);
  });

  it("follows cursors to completion and reports complete", async () => {
    const { client, calls } = fakeClient((_a, n) => (n < 2 ? { segments: [seg(n)], next_cursor: "x" } : { segments: [seg(n)] }));
    const r = await live(client).retrieveEvidence(demoAppointment);
    expect(calls.length).toBe(2);
    expect(r.completeness).toBe("complete");
    expect(r.items.every((i) => i.sourceMode === "live" && i.retrievedAt === fixtureClock.now().toISOString())).toBe(true);
  });

  it("normalizes missing fields to null, never invents, drops textless items, filters to window", async () => {
    const { client } = fakeClient(() => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [
              { text: "no metadata but timed", start_time: "2026-11-13T18:20:00Z" },
              { id: "u2", text: "   " },
              { id: "u3", content: "epoch timestamp", start_time: 1763056800 },
              { id: "u4", text: "far outside window", start_time: "2026-11-13T08:00:00Z" },
              { id: "u5", text: "full", transcript_id: "t9", start_time: "2026-11-13T18:30:00.000Z", end_time: "2026-11-13T18:30:05.000Z", speaker_name: "Ana" },
            ],
          }),
        },
      ],
    }));
    const r = await live(client).retrieveEvidence(demoAppointment);
    expect(r.items.map((i) => i.excerpt)).toEqual(["no metadata but timed", "full"]);
    const [bare, full] = r.items;
    expect(bare).toMatchObject({ sourceId: null, speaker: null, observedTo: null, observedFrom: "2026-11-13T18:20:00.000Z" });
    expect(bare!.id).toMatch(/^vexo_local_/);
    expect(full).toMatchObject({ id: "u5", sourceId: "t9", speaker: "Ana", observedTo: "2026-11-13T18:30:05.000Z" });
    expect(r.warnings.join(" ")).toMatch(/without usable text/);
    expect(r.warnings.join(" ")).toMatch(/without timestamps/);
  });

  it("retries on rate limit honouring retry-after, then succeeds", async () => {
    const { client, calls } = fakeClient((_a, n) => {
      if (n === 1) throw Object.assign(new Error("Too Many Requests"), { status: 429, retryAfter: 2 });
      if (n === 2) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { segments: [seg(1)] };
    });
    const r = await live(client).retrieveEvidence(demoAppointment);
    expect(calls.length).toBe(3);
    expect(noSleep.sleeps).toEqual([2000, VEXO_TOOL_CONFIG.baseBackoffMs * 2]);
    expect(r.items.length).toBe(1);
  });

  it("gives up after 3 rate-limit retries with rate_limited", async () => {
    const { client, calls } = fakeClient(() => {
      throw Object.assign(new Error("429"), { status: 429 });
    });
    await expect(live(client).retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "rate_limited", retryable: true });
    expect(calls.length).toBe(4);
  });

  it("auth error is distinct from an empty result", async () => {
    const empty = await live(fakeClient(() => ({ segments: [] })).client).retrieveEvidence(demoAppointment);
    expect(empty).toMatchObject({ items: [], completeness: "complete" });

    const thrown = fakeClient(() => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });
    await expect(live(thrown.client).retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(thrown.calls.length).toBe(1);

    const toolAuth = fakeClient(() => ({ isError: true, content: [{ type: "text", text: "401 invalid token" }] }));
    await expect(live(toolAuth.client).retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "auth" });
  });

  it("classifies tool errors and transport errors", async () => {
    const tool = fakeClient(() => ({ isError: true, content: [{ type: "text", text: "unknown argument" }] }));
    await expect(live(tool.client).retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "tool" });
    const shape = fakeClient(() => ({ segments: "nope" }));
    await expect(live(shape.client).retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "tool" });
    const net = fakeClient(() => {
      throw new Error("ECONNRESET");
    });
    await expect(live(net.client).retrieveEvidence(demoAppointment)).rejects.toMatchObject({ kind: "transport", retryable: true });
  });

  it("unavailable upstream sources mark the result partial", async () => {
    const { client } = fakeClient(() => ({ segments: [seg(1)], unavailable_sources: ["rec_2"] }));
    const r = await live(client).retrieveEvidence(demoAppointment);
    expect(r).toMatchObject({ completeness: "partial", unavailableSourceIds: ["rec_2"] });
  });

  it("requests one local day for a normal appointment, bounded to the window", async () => {
    const { client, calls } = fakeClient(() => ({ segments: [] }));
    await live(client).retrieveEvidence(demoAppointment);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toMatchObject({
      [VEXO_TOOL_CONFIG.args.date]: "2026-11-13",
      [VEXO_TOOL_CONFIG.args.timezone]: "America/Los_Angeles",
      [VEXO_TOOL_CONFIG.args.from]: "2026-11-13T17:00:00.000Z",
      [VEXO_TOOL_CONFIG.args.to]: "2026-11-13T20:00:00.000Z",
    });
  });

  it("cross-midnight appointment queries both local days", async () => {
    const appt: Appointment = {
      ...demoAppointment,
      startAt: "2026-11-14T07:30:00.000Z", // 23:30 PST on 11-13
      endAt: "2026-11-14T08:30:00.000Z", // 00:30 PST on 11-14
    };
    const { client, calls } = fakeClient(() => ({ segments: [] }));
    await live(client).retrieveEvidence(appt);
    expect(calls.map((c) => c.args[VEXO_TOOL_CONFIG.args.date])).toEqual(["2026-11-13", "2026-11-14"]);
    expect(calls[0]!.args[VEXO_TOOL_CONFIG.args.to]).toBe("2026-11-14T08:00:00.000Z"); // local midnight
    expect(calls[1]!.args[VEXO_TOOL_CONFIG.args.from]).toBe("2026-11-14T08:00:00.000Z");
  });

  it("fixture midnight appointment spans two local days", () => {
    const from = new Date(midnightAppointment.startAt).getTime();
    const to = new Date(midnightAppointment.endAt).getTime();
    expect(localDaysForWindow(from, to, midnightAppointment.timezone).length).toBe(2);
  });

  it("handles DST day boundaries", () => {
    // 2026-11-01 is the US fall-back day (25h long in LA).
    const days = localDaysForWindow(Date.parse("2026-11-01T06:00:00Z"), Date.parse("2026-11-02T09:00:00Z"), "America/Los_Angeles");
    expect(days.map((d) => d.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(new Date(days[1]!.fromMs).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(new Date(days[1]!.toMs).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });
});
