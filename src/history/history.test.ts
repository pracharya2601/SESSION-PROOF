import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../contracts";
import { buildRunEvent, createRunRecorder, noopRecorder, runEventId } from "./index";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const clock = { now: () => NOW };

class FakeStore {
  rows = new Map<string, RunEvent>();
  fail = false;
  async appendRunEvent(e: RunEvent) {
    if (this.fail) throw new Error("D1 down: token=secret-abc");
    if (!this.rows.has(e.id)) this.rows.set(e.id, e); // INSERT OR IGNORE
  }
}

const base = {
  runId: "wf-sess_1-r1",
  runKind: "processing" as const,
  sessionId: "sess_1",
  providerId: "prov-1",
  stage: "evidence" as const,
  status: "succeeded" as const,
  label: "Retrieved 3 evidence item(s)",
  detail: null,
  meta: { items: 3 },
};

describe("createRunRecorder", () => {
  it("builds deterministic ids and stamps the clock", async () => {
    const store = new FakeStore();
    const rec = createRunRecorder(store, clock);
    await rec.record(base);
    await rec.record({ ...base, stage: "approval_wait", status: "waiting", idSuffix: "0" });
    expect([...store.rows.keys()]).toEqual(["wf-sess_1-r1:evidence:succeeded", "wf-sess_1-r1:approval_wait:waiting:0"]);
    expect(store.rows.get("wf-sess_1-r1:evidence:succeeded")!.at).toBe(NOW.toISOString());
    expect(runEventId("r", "load", "succeeded")).toBe("r:load:succeeded");
  });

  it("dedupes retried steps (same id)", async () => {
    const store = new FakeStore();
    const rec = createRunRecorder(store, clock);
    await rec.record(base);
    await rec.record({ ...base, meta: { items: 4 } });
    expect(store.rows.size).toBe(1);
    expect(store.rows.get("wf-sess_1-r1:evidence:succeeded")!.meta.items).toBe(3);
  });

  it("truncates label/detail/meta strings and keeps explicit at", () => {
    const e = buildRunEvent(
      { ...base, label: "x".repeat(500), detail: "d".repeat(900), meta: { s: "m".repeat(300), n: Number.NaN }, at: "2026-11-13T11:00:00.000Z" },
      NOW,
    );
    expect(e.label).toHaveLength(200);
    expect(e.detail).toHaveLength(500);
    expect(e.meta.s).toHaveLength(200);
    expect("n" in e.meta).toBe(false);
    expect(e.at).toBe("2026-11-13T11:00:00.000Z");
  });

  it("never throws: repo failure and invalid input are swallowed and logged without secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new FakeStore();
    store.fail = true;
    const rec = createRunRecorder(store, clock);
    await expect(rec.record(base)).resolves.toBeUndefined();
    store.fail = false;
    // invalid stage
    await expect(rec.record({ ...base, stage: "bogus" as never })).resolves.toBeUndefined();
    expect(store.rows.size).toBe(0);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("history.record_failed");
    expect(logged).not.toContain("secret-abc");
    warn.mockRestore();
  });

  it("noopRecorder resolves", async () => {
    await expect(noopRecorder.record(base)).resolves.toBeUndefined();
  });
});
