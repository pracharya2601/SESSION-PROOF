import { describe, expect, it } from "vitest";
import { handleQueueBatch, type JobDeps } from "../jobs";
import { SessionQueueMessage } from "../contracts";
import { capPieces } from "./job";

function batch(bodies: unknown[], attempts = 1) {
  const acks: string[] = [];
  const retries: { id: string; delaySeconds?: number }[] = [];
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: () => acks.push(`m${i}`),
    retry: (o?: { delaySeconds?: number }) => retries.push({ id: `m${i}`, delaySeconds: o?.delaySeconds }),
  }));
  return { b: { queue: "q", messages } as unknown as MessageBatch<unknown>, acks, retries };
}

const job = { kind: "transcribe_offline", schemaVersion: "1", visitId: "visit_1", providerId: "p1" } as const;

describe("SESSION_QUEUE transcribe_offline", () => {
  it("is part of the queue message union, ids only", () => {
    expect(SessionQueueMessage.safeParse(job).success).toBe(true);
    expect(SessionQueueMessage.safeParse({ schemaVersion: "1", sessionId: "s", processingRevision: 1 }).success).toBe(true);
    expect(SessionQueueMessage.safeParse({ ...job, audio: "x" }).success).toBe(false);
  });

  it("routes to transcribeOffline with the attempt count; retry / ack follow its outcome", async () => {
    const seen: [string, number][] = [];
    const deps = {
      transcribeOffline: async (j: typeof job, attempt: number) => {
        seen.push([j.visitId, attempt]);
        return attempt < 3 ? { retry: true as const, delaySeconds: 60 } : { retry: false as const };
      },
    } as unknown as JobDeps;
    const r1 = batch([job], 2);
    await handleQueueBatch(r1.b, deps);
    expect(seen).toEqual([["visit_1", 2]]);
    expect(r1.retries).toEqual([{ id: "m0", delaySeconds: 60 }]);
    const r2 = batch([job], 3);
    await handleQueueBatch(r2.b, deps);
    expect(r2.acks).toEqual(["m0"]);

    // Not wired → acked (never loops); a throw → plain retry.
    const r3 = batch([job]);
    await handleQueueBatch(r3.b, {} as JobDeps);
    expect(r3.acks).toEqual(["m0"]);
    const r4 = batch([job]);
    await handleQueueBatch(r4.b, { transcribeOffline: async () => Promise.reject(new Error("x")) } as unknown as JobDeps);
    expect(r4.retries).toHaveLength(1);
  });
});

describe("capPieces", () => {
  it("leaves small lists alone and merges same-speaker neighbours when over the cap", () => {
    const p = (s: number, speaker: string) => ({ startSec: s, endSec: s + 1, text: `t${s}`, speaker });
    const few = [p(0, "Speaker 0"), p(1.5, "Speaker 0")];
    expect(capPieces(few, 10)).toEqual(few);
    const many = [p(0, "Speaker 0"), p(1.5, "Speaker 0"), p(3, "Speaker 1"), p(10, "Speaker 1"), p(11.5, "Speaker 1")];
    expect(capPieces(many, 3).map((x) => [x.startSec, x.endSec, x.text, x.speaker])).toEqual([
      [0, 2.5, "t0 t1.5", "Speaker 0"],
      [3, 4, "t3", "Speaker 1"],
      [10, 12.5, "t10 t11.5", "Speaker 1"],
    ]);
  });
});
