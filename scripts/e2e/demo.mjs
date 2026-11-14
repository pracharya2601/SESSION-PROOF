#!/usr/bin/env node
// Agent 20 — black-box end-to-end demo check against a running `npm run dev`.
// Usage: node scripts/e2e/demo.mjs            (BASE_URL defaults to http://localhost:8787)
//        BASE_URL=http://127.0.0.1:8787 POLL_SECONDS=90 node scripts/e2e/demo.mjs
// Prints PASS/FAIL per step, the three modes and the honest outcome label.
// Exit code: 0 only when every step passed.
//
// Needs a FRESH local D1 (rm -rf .wrangler/state && npm run db:migrate:local)
// because the demo session can only be approved once.

const BASE = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const POLL_MS = Number(process.env.POLL_SECONDS ?? 60) * 1000;
const IDENTITY = "demo.provider@example.invalid";
const PROGRESS = "The participant completed the planning task with verbal prompts.";
const APPROVAL_KEY = "demo-session-approval-request-001";

const results = [];
let cookie = "";
let failed = false;

function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

async function call(method, path, body, { auth = true } = {}) {
  const headers = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findDemoSession() {
  const r = await call("GET", "/api/sessions");
  return (r.json?.data?.sessions ?? []).find((s) => s.clientRef === "C-104" && s.serviceCode === "DEMO-ILS") ?? null;
}

async function pollStatus(wanted, terminal) {
  const deadline = Date.now() + POLL_MS;
  let last = null;
  let nudged = false;
  while (Date.now() < deadline) {
    last = await findDemoSession();
    if (last && wanted.includes(last.status)) return last;
    if (last && terminal.includes(last.status)) return last;
    // One extra manual sync halfway, in case the first discovery raced the seed.
    if (!nudged && Date.now() > deadline - POLL_MS / 2) {
      nudged = true;
      await call("POST", "/api/sync");
    }
    await sleep(1000);
  }
  return last;
}

function finish(modes) {
  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`Modes: evidence=${modes.evidence ?? "?"}  extraction=${modes.extraction ?? "?"}  runtime=${modes.runtime ?? "?"}`);
  let label = "PARTIAL PROTOTYPE";
  if (!failed) {
    const live = modes.evidence === "live" && modes.extraction === "live";
    if (modes.runtime === "deployed") label = live ? "LIVE DEPLOYED DEMO" : "MIXED DEPLOYED DEMO";
    else if (modes.evidence === "fixture" || modes.extraction === "fixture") label = "LOCAL FIXTURE DEMO";
    else label = "LOCAL DEMO (live adapters, local runtime)";
  }
  console.log(`Outcome: ${label}`);
  console.log(`Steps: ${passed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

const modes = {};
try {
  // 1. health
  const health = await call("GET", "/api/health", undefined, { auth: false });
  const h = health.json?.data ?? health.json;
  if (h) Object.assign(modes, { evidence: h.evidenceMode, extraction: h.extractionMode, runtime: h.runtimeMode });
  record("health", health.status === 200 && h?.ok === true, `status ${health.status}; db=${h?.bindings?.db} queue=${h?.bindings?.queue} workflow=${h?.bindings?.workflow}`);

  // 2. unauthenticated protected read rejected
  const anon = await call("GET", "/api/sessions", undefined, { auth: false });
  record("unauthenticated /api/sessions rejected", anon.status === 401, `status ${anon.status}`);

  // 3. dev login
  const login = await call("POST", "/auth/dev-login", { identity: IDENTITY }, { auth: false });
  cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""])
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!record("dev-login", login.status === 200 && !!cookie, `status ${login.status} ${login.status !== 200 ? login.text.slice(0, 160) : ""}`)) {
    finish(modes);
  }

  // 4. seed
  const seed = await call("POST", "/api/dev/seed", {});
  record("seed demo data", seed.status === 200, `status ${seed.status}`);

  // 5. sync
  const sync = await call("POST", "/api/sync");
  record("sync accepted (202)", sync.status === 202, `status ${sync.status} ${JSON.stringify(sync.json?.data ?? {})}`);

  // 6. poll NEEDS_REVIEW
  const before = await findDemoSession();
  if (before && ["APPROVED", "COMPLETED"].includes(before.status)) {
    record("fresh demo session", false, `session already ${before.status}; reset local D1 (rm -rf .wrangler/state) and rerun`);
    finish(modes);
  }
  const sReview = await pollStatus(["NEEDS_REVIEW"], ["NO_EVIDENCE", "AMBIGUOUS_MATCH", "INCOMPLETE", "FAILED"]);
  if (!record("session reaches NEEDS_REVIEW", sReview?.status === "NEEDS_REVIEW", sReview ? `status ${sReview.status} ${sReview.statusReason ?? ""}` : "no demo session listed (is the host clock within 7 days after 2026-11-13T19:00Z?)")) {
    finish(modes);
  }
  const id = sReview.id;

  // 7. revision 1 checks
  const d1 = await call("GET", `/api/sessions/${id}`);
  const b1 = d1.json?.data?.bundle;
  record(
    "rev 1: estimate 7500, amount null, approval blocked",
    b1?.bundleRevision === 1 && b1?.billing?.estimateAmountCents === 7500 && b1?.billing?.amountCents === null && b1?.checks?.canApprove === false,
    `rev=${b1?.bundleRevision} estimate=${b1?.billing?.estimateAmountCents} amount=${b1?.billing?.amountCents} canApprove=${b1?.checks?.canApprove}`,
  );
  record(
    "rev 1: goal_community stays unknown",
    b1?.facts?.goals?.find((g) => g.goalId === "goal_community")?.status === "unknown",
  );
  const early = await call("POST", `/api/sessions/${id}/approve`, { expectedRevision: 1, idempotencyKey: "early-approval-attempt-001" });
  record("approve while blocked → 422", early.status === 422, `status ${early.status}`);

  // 8. review edits
  const patch = await call("PATCH", `/api/sessions/${id}/review`, {
    expectedRevision: 1,
    edits: { confirmedMinutes: 90, progressConfirmation: PROGRESS },
  });
  const b2 = patch.json?.data;
  record(
    "review edits → rev 2, 11250 cents, approvable",
    patch.status === 200 && b2?.bundleRevision === 2 && b2?.billing?.amountCents === 11250 && b2?.checks?.canApprove === true,
    `status ${patch.status} rev=${b2?.bundleRevision} amount=${b2?.billing?.amountCents} canApprove=${b2?.checks?.canApprove}`,
  );

  // 9. stale edit
  const stale = await call("PATCH", `/api/sessions/${id}/review`, { expectedRevision: 1, edits: { confirmedMinutes: 60 } });
  record("stale edit (expectedRevision 1) → 409", stale.status === 409, `status ${stale.status}`);

  // 10. approve
  const appr = await call("POST", `/api/sessions/${id}/approve`, { expectedRevision: 2, idempotencyKey: APPROVAL_KEY });
  record(
    "approve rev 2 → 202/200",
    [200, 202].includes(appr.status) && appr.json?.data?.approval?.bundleRevision === 2,
    `status ${appr.status} finalization=${appr.json?.data?.finalization}`,
  );

  // 11. completion
  const done = await pollStatus(["COMPLETED"], ["FAILED"]);
  record("session reaches COMPLETED", done?.status === "COMPLETED", `status ${done?.status}`);

  // 12. export json
  const ej = await call("GET", `/api/sessions/${id}/export?format=json`);
  const doc = ej.json?.data ?? ej.json;
  const fin = doc?.finalized ?? doc;
  record(
    "export json = approved rev 2, 11250, modes",
    ej.status === 200 && fin?.bundleRevision === 2 && fin?.bundle?.billing?.amountCents === 11250 && fin?.bundle?.billing?.confirmedMinutes === 90,
    `status ${ej.status} rev=${fin?.bundleRevision} amount=${fin?.bundle?.billing?.amountCents} modes=${JSON.stringify(doc?.modes ? { e: doc.modes.evidenceMode, x: doc.modes.extractionMode, r: doc.modes.runtimeMode } : null)}`,
  );
  if (fin?.bundle?.provenance) {
    const p = fin.bundle.provenance;
    record(
      "export modes match health",
      p.evidenceMode === modes.evidence && p.extractionMode === modes.extraction && p.runtimeMode === modes.runtime,
    );
  }

  // 13. export html
  const eh = await call("GET", `/api/sessions/${id}/export?format=html`);
  record(
    "export html: text/html, $112.50, fixture disclosed, no <script>",
    eh.status === 200 && /text\/html/.test(eh.headers.get("content-type") ?? "") && /112\.50/.test(eh.text) && /fixture/i.test(eh.text) && !/<script/i.test(eh.text),
    `status ${eh.status}`,
  );
  console.log(`\nDemo session: ${id}  approved revision: 2  confirmed minutes: 90  amount: USD 112.50`);
  console.log(`Export: ${BASE}/api/sessions/${id}/export?format=html`);
} catch (err) {
  record("unexpected error", false, err instanceof Error ? err.message : String(err));
}
finish(modes);
