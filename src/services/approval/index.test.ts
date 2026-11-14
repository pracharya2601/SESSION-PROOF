import { describe, expect, it, vi } from "vitest";
import { approveSession, saveReview, ServiceError } from "./index";
import { makeDeps, PROVIDER, SESSION } from "./testkit";

const actor = { providerId: PROVIDER, identity: "p@example.test" };

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return `${e.status}:${e.code}`;
    throw e;
  }
  return "ok";
}

describe("saveReview", () => {
  it("creates revision 2 with attestations from the authenticated actor", async () => {
    const { deps } = makeDeps();
    const b = await saveReview(deps, actor, SESSION, {
      expectedRevision: 1,
      edits: { confirmedMinutes: 90, progressConfirmation: "Completed planning task" },
    });
    expect(b.bundleRevision).toBe(2);
    expect(b.billing.amountCents).toBe(11250);
    expect(b.attestations.map((a) => a.id).sort()).toEqual([`att-${SESSION}-r2-duration`, `att-${SESSION}-r2-progress`]);
    expect(b.attestations.every((a) => a.actorProviderId === PROVIDER && a.bundleRevision === 2)).toBe(true);
  });

  it("supersedes same-field attestations and keeps others", async () => {
    const { deps } = makeDeps();
    await saveReview(deps, actor, SESSION, { expectedRevision: 1, edits: { confirmedMinutes: 60, progressConfirmation: "x" } });
    const b = await saveReview(deps, actor, SESSION, { expectedRevision: 2, edits: { confirmedMinutes: 90 } });
    expect(b.attestations.map((a) => a.id).sort()).toEqual([`att-${SESSION}-r2-progress`, `att-${SESSION}-r3-duration`]);
    expect(b.billing.confirmedMinutes).toBe(90);
  });

  it("rejects stale revision, foreign session, and post-approval edits", async () => {
    const { deps, repo } = makeDeps();
    expect(await code(saveReview(deps, actor, SESSION, { expectedRevision: 5, edits: { confirmedMinutes: 60 } }))).toBe("409:STALE_REVISION");
    expect(await code(saveReview(deps, { providerId: "other", identity: "o" }, SESSION, { expectedRevision: 1, edits: { confirmedMinutes: 60 } }))).toBe("404:NOT_FOUND");
    repo.sessions.get(SESSION)!.status = "APPROVED";
    expect(await code(saveReview(deps, actor, SESSION, { expectedRevision: 1, edits: { confirmedMinutes: 60 } }))).toBe("409:INVALID_STATE");
  });
});

describe("approveSession", () => {
  const key = "approval-key-0001";

  it("422 with blocking details when checks block", async () => {
    const { deps } = makeDeps();
    const err = await approveSession(deps, actor, SESSION, { expectedRevision: 1, idempotencyKey: key }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("DOCUMENTATION_BLOCKERS");
    expect(err.details).toEqual([expect.objectContaining({ code: "MISSING_DURATION", blocking: true })]);
  });

  it("approves, replays the same key without a second persist, and rejects key reuse for another revision", async () => {
    const { deps, repo, notified } = makeDeps();
    await saveReview(deps, actor, SESSION, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    const first = await approveSession(deps, actor, SESSION, { expectedRevision: 2, idempotencyKey: key });
    expect(first.finalization).toBe("pending");
    expect(first.approval.id).toBe(`approval-${SESSION}-r2`);
    expect(first.approval.approverProviderId).toBe(PROVIDER);
    expect(repo.deliveries).toEqual([{ approvalId: first.approval.id, sessionId: SESSION, bundleRevision: 2 }]);
    const again = await approveSession(deps, actor, SESSION, { expectedRevision: 2, idempotencyKey: key });
    expect(again.approval).toEqual(first.approval);
    expect(repo.persistCalls).toBe(1);
    expect(repo.approvals).toHaveLength(1);
    expect(notified.length).toBeGreaterThanOrEqual(1);
    expect(await code(approveSession(deps, actor, SESSION, { expectedRevision: 1, idempotencyKey: key }))).toBe("409:IDEMPOTENCY_CONFLICT");
  });

  it("rejects stale revision and a second approval with a new key", async () => {
    const { deps } = makeDeps();
    await saveReview(deps, actor, SESSION, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    expect(await code(approveSession(deps, actor, SESSION, { expectedRevision: 1, idempotencyKey: key }))).toBe("409:STALE_REVISION");
    await approveSession(deps, actor, SESSION, { expectedRevision: 2, idempotencyKey: key });
    expect(await code(approveSession(deps, actor, SESSION, { expectedRevision: 2, idempotencyKey: "another-key-1" }))).toBe("409:INVALID_STATE");
  });

  it("returns the durable approval when notification fails", async () => {
    const notify = vi.fn(async () => {
      throw new Error("queue down");
    });
    const { deps, repo } = makeDeps(undefined, notify);
    await saveReview(deps, actor, SESSION, { expectedRevision: 1, edits: { confirmedMinutes: 90 } });
    const res = await approveSession(deps, actor, SESSION, { expectedRevision: 2, idempotencyKey: key });
    expect(res.finalization).toBe("pending");
    expect(repo.approvals).toHaveLength(1);
    expect(repo.deliveries).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("422 DURATION_NOT_CONFIRMED when canApprove but no confirmed minutes", async () => {
    const { deps, repo } = makeDeps();
    const b = repo.bundles.get(`${SESSION}:1`)!;
    b.checks = { ruleVersion: "r1", issues: [], canApprove: true };
    expect(await code(approveSession(deps, actor, SESSION, { expectedRevision: 1, idempotencyKey: key }))).toBe("422:DURATION_NOT_CONFIRMED");
  });
});
