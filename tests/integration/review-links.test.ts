/**
 * Approval hand-off: review links + notifications over REAL modules + Miniflare D1 (all migrations).
 *
 * The workflow deps mirror src/index.ts: `onNeedsReview` → notifier.sessionNeedsReview, and the
 * completion hook closes review links + posts the "approved" notification before delivery.
 * Email goes through the real Resend sender with a fake fetch (and a fake send_email binding).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdFor, workflowInstanceId } from "../../src/contracts";
import { DEMO_PROVIDER_ID, EXPECTED, OTHER_PROVIDER_IDENTITY, demoAppointment } from "../../fixtures/scenario";
import { createV3Harness, type V3Harness } from "../e2e/v3-harness";
import { createNotifier, safeNotify, RESEND_ENDPOINT, createEmailSender, cloudflareSender } from "../../src/notify";
import { finalizeDirect } from "../../src/services/approval/amend";
import { CLOSED_GRACE_MS, REVIEW_LINK_TTL_MS, ensureReviewLink } from "../../src/review-links";

const SID = () => sessionIdFor(DEMO_PROVIDER_ID, demoAppointment.occurrenceId);
const NOTIFY_ADDRESS = "provider.notify@example.invalid";
const PII = ["Sam Rivera", "(synthetic)", "demo.provider@example.invalid"];
const LINK_RE = /http:\/\/localhost:8787\/r\/(vfrl_[A-Za-z0-9_-]{43})/;

let h: V3Harness | null = null;
let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.dispose();
  h = null;
});

interface Sent {
  url: string;
  auth: string | null;
  body: { from: string; to: string[]; subject: string; text: string; html: string };
}

async function setup(opts: { email?: boolean } = {}) {
  const hh = await createV3Harness();
  h = hh;
  const anyH = hh as any;
  const { repo, clock, env } = hh;
  const sent: Sent[] = [];
  let resendStatus = 200;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === RESEND_ENDPOINT) {
      const headers = new Headers(init?.headers);
      sent.push({ url, auth: headers.get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(resendStatus === 200 ? { id: `re_${sent.length}` } : { message: "nope" }), { status: resendStatus });
    }
    return anyH.cloud.fetch(input, init);
  }) as typeof fetch;
  if (opts.email !== false) Object.assign(env, { RESEND_API_KEY: "re_test_key_not_real", NOTIFY_FROM: "Vexo <notify@example.invalid>" });
  anyH.apiDeps.fetch = fakeFetch;

  const recorder = hh.recorder as any;
  const notifier = () => createNotifier({ repo, env: env as any, clock, fetch: fakeFetch, recorder });
  const resolveClient = async (appt: { providerId: string; clientRef: string }) => repo.getClient(appt.providerId, appt.clientRef);
  const deliveryDeps = { repo, env, clock, fetch: anyH.cloud.fetch, recorder };
  // Mirrors src/index.ts onCompleted(env, sessionId).
  const onCompleted = async (sid: string) => {
    await safeNotify("completed", sid, () => notifier().sessionCompleted(sid));
    return anyH.v2.delivery.onSessionCompleted(deliveryDeps, sid);
  };
  const workflowDeps = {
    repo,
    evidence: hh.mods.vexo.createEvidenceSource(env),
    extractor: hh.mods.ai.createExtractor(env, { fetch: anyH.cloud.fetch, retryDelayMs: 0 }),
    match: hh.mods.domain.matchEvidence,
    assemble: hh.mods.domain.assembleBundle,
    clock,
    runtimeMode: "local",
    recorder,
    resolveClient,
    onCompleted,
    onNeedsReview: (sid: string) => notifier().sessionNeedsReview(sid),
  };
  hh.workflow.run = (params: any, step: any) => hh.mods.workflow.runSessionWorkflow(workflowDeps, params, step);
  hh.jobs.finalizeDirect = (approval: any) => finalizeDirect({ repo, clock, recorder, resolveClient: resolveClient as any, onCompleted }, approval);

  await hh.mods.seed.seedDemoData(repo, { variant: "normal" });
  const cookie = await hh.login();
  return { hh, sent, notifier, cookie, setResendStatus: (s: number) => (resendStatus = s) };
}

async function optIn(hh: V3Harness, cookie: string, over: Record<string, unknown> = {}) {
  const r = await hh.req("/api/settings/notifications", {
    method: "PUT",
    cookie,
    body: { email: NOTIFY_ADDRESS, emailOnReady: true, emailOnApproved: true, ...over },
  });
  expect(r.status, r.text).toBe(200);
  return r.json.data;
}

async function syncToReview(hh: V3Harness, cookie: string): Promise<string> {
  const s = await hh.req("/api/sync", { method: "POST", cookie });
  expect(s.status, s.text).toBe(202);
  await hh.settle();
  const sid = await SID();
  const d = await hh.req(`/api/sessions/${sid}`, { cookie });
  expect(d.status, d.text).toBe(200);
  expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
  return sid;
}

const linkReq = (hh: V3Harness, token: string, path = "", o: { method?: string; body?: unknown; origin?: string | null } = {}) =>
  hh.req(`/api/review-link/${token}${path}`, { cookie: null, ...o });

function noPii(s: string) {
  for (const p of PII) expect(s).not.toContain(p);
}

describe("review links + notifications", () => {
  it("NEEDS_REVIEW → one review link, one inbox notification and one PII-free email; re-runs are idempotent", async () => {
    const { hh, sent, notifier, cookie } = await setup();
    const view = await optIn(hh, cookie);
    expect(view.email).toEqual({ configured: true, sender: "resend" });
    const sid = await syncToReview(hh, cookie);

    const links = await hh.req(`/api/sessions/${sid}/review-links`, { cookie });
    expect(links.status, links.text).toBe(200);
    expect(links.json.data).toHaveLength(1);
    expect(links.json.data[0]).toMatchObject({ providerId: DEMO_PROVIDER_ID, sessionId: sid, state: "active", revokedAt: null });
    expect(JSON.stringify(links.json.data)).not.toMatch(/vfrl_|token|hash/i);
    expect(Date.parse(links.json.data[0].expiresAt) - hh.clock.now().getTime()).toBe(REVIEW_LINK_TTL_MS);

    const inbox = await hh.req("/api/notifications", { cookie });
    expect(inbox.json.data.unreadCount).toBe(1);
    expect(inbox.json.data.notifications).toEqual([
      expect.objectContaining({ kind: "ready_for_review", sessionId: sid, clientRef: "C-104", title: "Visit for C-104 is ready for review", readAt: null }),
    ]);

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.auth).toBe("Bearer re_test_key_not_real");
    expect(mail.body.to).toEqual([NOTIFY_ADDRESS]);
    expect(mail.body.from).toBe("Vexo <notify@example.invalid>");
    expect(mail.body.subject).toBe("Visit for C-104 is ready for review");
    const detail = (await hh.req(`/api/sessions/${sid}`, { cookie })).json.data;
    const blocking = detail.bundle.checks.issues.filter((i: any) => i.blocking).length;
    expect(blocking).toBeGreaterThan(0);
    expect(mail.body.text).toContain("Client: C-104");
    expect(mail.body.text).toContain(`Blockers to fix: ${blocking}`);
    expect(mail.body.text).toMatch(/Minutes: \d+ min \(estimate\)/);
    expect(mail.body.text).toMatch(/Service date: \w{3}, \w{3} \d{1,2}, \d{4}/);
    expect(mail.body.text).toMatch(LINK_RE);
    expect(mail.body.html).toMatch(LINK_RE);
    const whole = JSON.stringify(mail.body);
    noPii(whole);
    for (const ev of detail.bundle.evidence) expect(whole).not.toContain(ev.excerpt.slice(0, 30));
    expect(whole).not.toContain("$"); // no amounts

    // Idempotent: the hook running again (workflow retry) adds nothing.
    expect(await notifier().sessionNeedsReview(sid)).toEqual({ notified: false, email: null });
    expect((await hh.req(`/api/sessions/${sid}/review-links`, { cookie })).json.data).toHaveLength(1);
    expect((await hh.req("/api/notifications", { cookie })).json.data.notifications).toHaveLength(1);
    expect(sent).toHaveLength(1);

    // Run history: one info event; logs carry no token, address or names.
    const run = await hh.req(`/api/runs/${encodeURIComponent(workflowInstanceId(sid, 1))}`, { cookie });
    const ev = run.json.data.events.filter((e: any) => e.label.startsWith("Review link"));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ stage: "approval_wait", status: "info", label: "Review link sent (in-app and email)" });
    expect(ev[0].meta).toMatchObject({ email: "sent", reviewLinkCreated: true });
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain("vfrl_");
    expect(allLogs).not.toContain(NOTIFY_ADDRESS);
    expect(allLogs).not.toContain("Sam Rivera");
  });

  it("link works without a cookie: review + approve via link → COMPLETED, recorded as approved via review link", async () => {
    const { hh, sent, cookie } = await setup();
    await optIn(hh, cookie);
    const sid = await syncToReview(hh, cookie);
    const token = LINK_RE.exec(sent[0]!.body.text)![1]!;

    // Same shape as the cookie route.
    const viaLink = await linkReq(hh, token);
    expect(viaLink.status, viaLink.text).toBe(200);
    const viaCookie = await hh.req(`/api/sessions/${sid}`, { cookie });
    expect(viaLink.json.data).toEqual(viaCookie.json.data);
    expect(viaLink.headers.get("cache-control")).toBe("no-store");
    const doc = await linkReq(hh, token, "/documents/session_note");
    expect(doc.status, doc.text).toBe(200);
    expect(Array.isArray(doc.json.data.blocks)).toBe(true);
    expect((await linkReq(hh, token, "/documents/nope")).status).toBe(400);

    // Human review stays mandatory: blockers stop approval.
    const early = await linkReq(hh, token, "/approve", { method: "POST", body: { expectedRevision: 1, idempotencyKey: "rl-early-0001" } });
    expect(early.status, early.text).toBe(422);

    const rev = await linkReq(hh, token, "/review", {
      method: "PATCH",
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
    });
    expect(rev.status, rev.text).toBe(200);
    expect(rev.json.data.checks.canApprove).toBe(true);
    // Stale revision → 409, like the cookie route.
    expect((await linkReq(hh, token, "/review", { method: "PATCH", body: { expectedRevision: 1, edits: { confirmedMinutes: 80 } } })).status).toBe(409);

    // originGuard still applies to link mutations.
    const noOrigin = await linkReq(hh, token, "/approve", { method: "POST", origin: null, body: { expectedRevision: 2, idempotencyKey: "rl-approve-0001" } });
    expect(noOrigin.status).toBe(403);
    const ok = await linkReq(hh, token, "/approve", { method: "POST", body: { expectedRevision: 2, idempotencyKey: "rl-approve-0001" } });
    expect([200, 202], ok.text).toContain(ok.status);
    expect(ok.json.data.approval).toMatchObject({ approverProviderId: DEMO_PROVIDER_ID, bundleRevision: 2 });
    await hh.settle();
    const fin = await hh.req(`/api/sessions/${sid}`, { cookie });
    expect(fin.json.data.session.status).toBe("COMPLETED");

    const run = await hh.req(`/api/runs/${encodeURIComponent(workflowInstanceId(sid, 1))}`, { cookie });
    const labels = run.json.data.events.map((e: any) => e.label);
    expect(labels).toContain("Approved via review link");
    expect(labels).toContain("Review saved via review link (revision 2)");
    expect(labels).toContain("Session completed");

    // Approved notification (+ email); the ready one is read now.
    const inbox = (await hh.req("/api/notifications", { cookie })).json.data;
    expect(inbox.notifications.map((n: any) => [n.kind, n.readAt === null])).toEqual(
      expect.arrayContaining([
        ["approved", true],
        ["ready_for_review", false],
      ]),
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.subject).toBe("Visit for C-104 was approved and finalized");
    noPii(JSON.stringify(sent[1]!.body));

    // Within the grace window the link still shows the completed visit, read-only.
    const after = await linkReq(hh, token);
    expect(after.status).toBe(200);
    expect(after.json.data.session.status).toBe("COMPLETED");
    const ro = await linkReq(hh, token, "/review", { method: "PATCH", body: { expectedRevision: 2, edits: { confirmedMinutes: 60 } } });
    expect(ro.status).toBe(409);
    expect(ro.json.error.code).toBe("REVIEW_LINK_READ_ONLY");
    hh.clock.advance(CLOSED_GRACE_MS + 1000);
    const used = await linkReq(hh, token);
    expect(used.status).toBe(410);
    expect(used.json.error.code).toBe("REVIEW_LINK_USED");
    const list = (await hh.req(`/api/sessions/${sid}/review-links`, { cookie })).json.data;
    expect(list[0]).toMatchObject({ state: "used" });
    expect(list[0].usedAt).not.toBeNull();
    expect(logs.join("\n")).not.toContain(token);
  });

  it("wrong, expired and revoked tokens → 401 / 410", async () => {
    const { hh, sent, cookie } = await setup();
    await optIn(hh, cookie);
    const sid = await syncToReview(hh, cookie);
    const token = LINK_RE.exec(sent[0]!.body.text)![1]!;

    for (const bad of ["abc", "vfrl_short", `vfrl_${"A".repeat(43)}`, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")]) {
      const r = await linkReq(hh, bad);
      expect(r.status, bad).toBe(401);
      expect(r.json.error.code).toBe("INVALID_REVIEW_LINK");
    }
    const badPost = await linkReq(hh, `vfrl_${"A".repeat(43)}`, "/approve", { method: "POST", body: { expectedRevision: 1, idempotencyKey: "rl-bad-00001" } });
    expect(badPost.status).toBe(401);

    hh.clock.advance(REVIEW_LINK_TTL_MS + 1000);
    const expired = await linkReq(hh, token);
    expect(expired.status).toBe(410);
    expect(expired.json.error.code).toBe("REVIEW_LINK_EXPIRED");

    // A fresh link replaces the expired one; revoking it turns it off at once.
    const fresh = await ensureReviewLink({ repo: hh.repo, env: hh.env as any, clock: hh.clock }, DEMO_PROVIDER_ID, sid);
    expect(fresh?.created).toBe(true);
    expect((await linkReq(hh, fresh!.token)).status).toBe(200);
    const other = await hh.login(OTHER_PROVIDER_IDENTITY);
    expect((await hh.req(`/api/review-links/${fresh!.link.id}`, { method: "DELETE", cookie: other })).status).toBe(404);
    const again = await hh.login(); // the 8 h cookie expired with the 7-day jump
    const del = await hh.req(`/api/review-links/${fresh!.link.id}`, { method: "DELETE", cookie: again });
    expect(del.status, del.text).toBe(200);
    expect(del.json.data.state).toBe("revoked");
    const revoked = await linkReq(hh, fresh!.token);
    expect(revoked.status).toBe(410);
    expect(revoked.json.error.code).toBe("REVIEW_LINK_REVOKED");
    const revokedApprove = await linkReq(hh, fresh!.token, "/approve", { method: "POST", body: { expectedRevision: 1, idempotencyKey: "rl-rev-00001" } });
    expect(revokedApprove.status).toBe(410);
  });

  it("other providers see nothing: notifications, links, device inbox", async () => {
    const { hh, cookie } = await setup();
    await optIn(hh, cookie);
    const sid = await syncToReview(hh, cookie);
    const other = await hh.login(OTHER_PROVIDER_IDENTITY);
    const n = await hh.req("/api/notifications", { cookie: other });
    expect(n.json.data).toEqual({ notifications: [], unreadCount: 0 });
    expect((await hh.req(`/api/sessions/${sid}/review-links`, { cookie: other })).status).toBe(404);
    const mine = (await hh.req("/api/notifications", { cookie })).json.data.notifications[0];
    expect((await hh.req(`/api/notifications/${mine.id}/read`, { method: "POST", cookie: other })).status).toBe(404);
    expect((await hh.req("/api/settings/notifications", { cookie: other })).json.data.settings).toEqual({
      email: null,
      emailOnReady: false,
      emailOnApproved: false,
    });
    const pair = await hh.req("/api/devices", { method: "POST", cookie: other, body: { name: "Other phone" } });
    expect(pair.status, pair.text).toBe(201);
    const res = await hh.app.request(
      "http://localhost:8787/api/device/inbox",
      { headers: { authorization: `Bearer ${pair.json.data.key}` } },
      hh.env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.items).toEqual([]);
    // Mark read works for the owner.
    expect((await hh.req(`/api/notifications/${mine.id}/read`, { method: "POST", cookie })).status).toBe(200);
    expect((await hh.req("/api/notifications?unread=1", { cookie })).json.data.unreadCount).toBe(0);
  });

  it("device inbox lists pending reviews with a stable review-link URL; amend gets a fresh link", async () => {
    const { hh, sent, cookie } = await setup();
    await optIn(hh, cookie);
    const sid = await syncToReview(hh, cookie);
    const emailed = LINK_RE.exec(sent[0]!.body.text)![0];

    const pair = await hh.req("/api/devices", { method: "POST", cookie, body: { name: "Sam’s iPhone" } });
    const key: string = pair.json.data.key;
    const inbox = async () => {
      const r = await hh.app.request("http://localhost:8787/api/device/inbox", { headers: { authorization: `Bearer ${key}` } }, hh.env);
      expect(r.status).toBe(200);
      return ((await r.json()) as any).data;
    };
    const unauth = await hh.app.request("http://localhost:8787/api/device/inbox", {}, hh.env);
    expect(unauth.status).toBe(401);

    const first = await inbox();
    expect(first.items).toHaveLength(1);
    const item = first.items[0];
    expect(item).toMatchObject({
      sessionId: sid,
      clientRef: "C-104",
      bundleRevision: 1,
      title: "Visit for C-104 is ready — tap to review",
      reviewUrl: emailed,
    });
    expect(item.blockingCount).toBeGreaterThan(0);
    noPii(JSON.stringify(first));
    expect((await inbox()).items[0].reviewUrl).toBe(emailed); // stable across polls

    // Approve via the phone's link, then amend in the app: the old link stays closed,
    // the amended revision gets a fresh one.
    const token = /\/r\/(vfrl_[^/]+)$/.exec(item.reviewUrl)![1]!;
    await linkReq(hh, token, "/review", {
      method: "PATCH",
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
    });
    const ap = await linkReq(hh, token, "/approve", { method: "POST", body: { expectedRevision: 2, idempotencyKey: "rl-dev-approve-1" } });
    expect([200, 202]).toContain(ap.status);
    await hh.settle();
    expect((await inbox()).items).toEqual([]);

    const amend = await hh.req(`/api/sessions/${sid}/amend`, { method: "POST", cookie, body: { expectedRevision: 2, reason: "Correct the minutes" } });
    expect(amend.status, amend.text).toBe(200);
    hh.clock.advance(CLOSED_GRACE_MS + 1000);
    expect((await linkReq(hh, token)).json.error.code).toBe("REVIEW_LINK_USED");
    const reopened = await inbox();
    expect(reopened.items).toHaveLength(1);
    expect(reopened.items[0].bundleRevision).toBe(3);
    expect(reopened.items[0].reviewUrl).not.toBe(emailed);
    const token2 = /\/r\/(vfrl_[^/]+)$/.exec(reopened.items[0].reviewUrl)![1]!;
    const d2 = await linkReq(hh, token2);
    expect(d2.status).toBe(200);
    expect(d2.json.data.session.status).toBe("NEEDS_REVIEW");
    const ap2 = await linkReq(hh, token2, "/approve", { method: "POST", body: { expectedRevision: 3, idempotencyKey: "rl-dev-approve-3" } });
    expect([200, 202], ap2.text).toContain(ap2.status);
    await hh.settle();
    expect((await hh.req(`/api/sessions/${sid}`, { cookie })).json.data.session.status).toBe("COMPLETED");
    const kinds = (await hh.req("/api/notifications", { cookie })).json.data.notifications.map((n: any) => n.kind);
    expect(kinds.filter((k: string) => k === "approved")).toHaveLength(2); // r2 and r3
  });

  it("email is opt-in, validated, and the test button reports what happened", async () => {
    const { hh, sent, cookie, setResendStatus } = await setup();
    // Default: no address → in-app only, no email even though the server can send.
    let t = await hh.req("/api/settings/notifications/test", { method: "POST", cookie });
    expect(t.status, t.text).toBe(200);
    expect(t.json.data).toEqual({ inApp: true, email: { status: "no_address", sender: "resend", code: null } });
    for (const bad of ["not-an-email", "A <a@b.example>", "a@b", "a@@b.example", "a@b.example\r\nBcc: x@y.example", "a@b..example"]) {
      const r = await hh.req("/api/settings/notifications", { method: "PUT", cookie, body: { email: bad, emailOnReady: true, emailOnApproved: false } });
      expect(r.status, bad).toBe(400);
    }
    expect((await hh.req("/api/settings/notifications", { method: "PUT", cookie, body: { email: NOTIFY_ADDRESS, emailOnReady: true, emailOnApproved: false, extra: 1 } })).status).toBe(400);
    const cleared = await hh.req("/api/settings/notifications", { method: "PUT", cookie, body: { email: "", emailOnReady: false, emailOnApproved: false } });
    expect(cleared.json.data.settings.email).toBeNull();

    await optIn(hh, cookie);
    t = await hh.req("/api/settings/notifications/test", { method: "POST", cookie });
    expect(t.json.data.email).toEqual({ status: "sent", sender: "resend", code: null });
    expect(sent.at(-1)!.body.to).toEqual([NOTIFY_ADDRESS]);
    setResendStatus(500);
    t = await hh.req("/api/settings/notifications/test", { method: "POST", cookie });
    expect(t.json.data.email).toEqual({ status: "failed", sender: "resend", code: "resend_http_500" });
    expect(logs.join("\n")).not.toContain(NOTIFY_ADDRESS);

    // Toggles off → a ready visit is in-app only.
    await optIn(hh, cookie, { emailOnReady: false });
    const before = sent.length;
    await syncToReview(hh, cookie);
    expect(sent.length).toBe(before);
    expect((await hh.req("/api/notifications", { cookie })).json.data.notifications.some((n: any) => n.kind === "ready_for_review")).toBe(true);
  });

  it("no sender configured → 'email not configured'; send_email binding works as the other sender", async () => {
    const { hh, cookie } = await setup({ email: false });
    await optIn(hh, cookie);
    const v = await hh.req("/api/settings/notifications", { cookie });
    expect(v.json.data.email).toEqual({ configured: false, sender: null });
    const t = await hh.req("/api/settings/notifications/test", { method: "POST", cookie });
    expect(t.json.data.email).toEqual({ status: "not_configured", sender: null, code: null });

    // Cloudflare send_email binding (structured form), selected when it is the configured one.
    const calls: any[] = [];
    const binding = { send: async (m: any) => (calls.push(m), { messageId: "cf-1" }) };
    const sender = createEmailSender({ NOTIFY_EMAIL: binding as any, NOTIFY_FROM: "notify@example.invalid" });
    expect(sender?.kind).toBe("cloudflare");
    expect(createEmailSender({ NOTIFY_EMAIL: binding as any })).toBeNull(); // NOTIFY_FROM required
    expect(createEmailSender({ NOTIFY_EMAIL: binding as any, RESEND_API_KEY: "k", NOTIFY_FROM: "a@b.example" })?.kind).toBe("resend");
    expect(
      createEmailSender({ NOTIFY_EMAIL: binding as any, RESEND_API_KEY: "k", NOTIFY_FROM: "a@b.example", NOTIFY_EMAIL_PROVIDER: "cloudflare" })?.kind,
    ).toBe("cloudflare");

    const notifier = createNotifier({ repo: hh.repo, env: hh.env as any, clock: hh.clock, sender: cloudflareSender(binding, "notify@example.invalid") });
    const sid = await syncToReview(hh, cookie); // workflow notifier has no sender → in-app only
    expect(calls).toHaveLength(0);
    // Same session, next revision (a saved review re-notifies only when the hook runs again).
    const rev = await hh.req(`/api/sessions/${sid}/review`, { method: "PATCH", cookie, body: { expectedRevision: 1, edits: { confirmedMinutes: 45 } } });
    expect(rev.status).toBe(200);
    const res = await notifier.sessionNeedsReview(sid);
    expect(res).toEqual({ notified: true, email: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ from: "notify@example.invalid", to: NOTIFY_ADDRESS, subject: "Visit for C-104 is ready for review" });
    expect(calls[0].text).toContain("Minutes: 45 min (confirmed)");
    expect(calls[0].text).toMatch(LINK_RE);
    noPii(JSON.stringify(calls[0]));
  });
});
