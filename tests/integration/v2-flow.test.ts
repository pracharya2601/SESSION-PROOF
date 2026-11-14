/**
 * Q2 — v2 in-process integration over REAL modules + Miniflare D1 (all migrations).
 * Outbound HTTP (Google, Microsoft, AI vendors) goes to the recording FakeCloud.
 * Test names carry V2-xx ids mapped in docs/v2-test-report.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdFor } from "../../src/contracts";
import type { AiProviderId, EvidenceItem, FileKind, SessionFacts, StoredConnection } from "../../src/contracts";
import {
  DEMO_PROVIDER_ID,
  EXPECTED,
  OTHER_PROVIDER_IDENTITY,
  demoAppointment,
  demoEvidence,
  demoFacts,
  demoPlan,
} from "../../fixtures/scenario";
import { createV2Harness, missingV2Modules, SECRETS, type V2Harness } from "../e2e/v2-harness";
import { missingModules } from "../e2e/harness";
import { ACCESS_TOKENS, type Recorded } from "../e2e/v2-fake-fetch";

const missing = [...missingModules(), ...missingV2Modules()];
const ready = missing.length === 0;
if (!ready) console.warn(`[v2-flow.test] NOT RUN — missing modules: ${missing.join(", ")}`);

type H = V2Harness & { responses: string[] };
let h: H | null = null;
/** Every console line written by the modules under test (structured logs). */
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

const KINDS: FileKind[] = ["session_note", "invoice", "approval_record"];
const SID = () => sessionIdFor(DEMO_PROVIDER_ID, demoAppointment.occurrenceId);
const RECIPIENT = "billing.office@example.invalid";

// ------------------------------------------------------------------ helpers
async function seedAndSync(hh: H): Promise<{ cookie: string; id: string }> {
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  const cookie = await hh.login();
  const sync = await hh.req("/api/sync", { method: "POST", cookie });
  expect(sync.status, sync.text).toBe(202);
  await hh.settle();
  return { cookie, id: await SID() };
}

/** Normal demo: review 90 min + progress attestation → approve rev 2 → COMPLETED. */
async function completeDemo(hh: H): Promise<{ cookie: string; id: string }> {
  const { cookie, id } = await seedAndSync(hh);
  const patch = await hh.req(`/api/sessions/${id}/review`, {
    method: "PATCH",
    cookie,
    body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
  });
  expect(patch.status, patch.text).toBe(200);
  const appr = await hh.req(`/api/sessions/${id}/approve`, {
    method: "POST",
    cookie,
    body: { expectedRevision: 2, idempotencyKey: EXPECTED.demoApprovalKey },
  });
  expect([200, 202], appr.text).toContain(appr.status);
  await hh.settle();
  const d = await hh.req(`/api/sessions/${id}`, { cookie });
  expect(d.json.data.session.status).toBe("COMPLETED");
  return { cookie, id };
}

async function seedConnection(hh: H, provider: "google" | "microsoft", expiresInMs = 3_600_000): Promise<StoredConnection> {
  const accessToken = provider === "google" ? ACCESS_TOKENS.google : ACCESS_TOKENS.microsoft;
  const refreshToken = provider === "google" ? ACCESS_TOKENS.googleRefresh : ACCESS_TOKENS.microsoftRefresh;
  const now = hh.clock.now();
  const conn: StoredConnection = {
    providerId: DEMO_PROVIDER_ID,
    provider,
    accountEmail: `provider.${provider}@example.invalid`,
    scopes: ["openid", "email"],
    encryptedTokens: await hh.v2.security.encryptToken(
      JSON.stringify({ accessToken, refreshToken }),
      hh.env.TOKEN_ENCRYPTION_KEY as string,
    ),
    accessTokenExpiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    status: "connected",
    lastError: null,
    connectedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await hh.repo.saveConnection(conn);
  return conn;
}

async function putStorage(hh: H, cookie: string, provider: "google" | "microsoft", auto = false) {
  const r = await hh.req("/api/settings/storage", {
    method: "PUT",
    cookie,
    body: { provider, folderPath: "Vexo Field Assistant/{clientRef}/{serviceDate}", autoUploadOnComplete: auto },
  });
  expect(r.status, r.text).toBe(200);
  return r;
}

async function putEmail(hh: H, cookie: string, provider: "google" | "microsoft") {
  const r = await hh.req("/api/settings/email", {
    method: "PUT",
    cookie,
    body: {
      provider,
      defaultTo: [RECIPIENT],
      defaultCc: [],
      subjectTemplate: "Session documentation — {clientRef} — {serviceDate}",
      bodyTemplate: "Hello,\n\nAttached for {clientRef} ({serviceDate}, revision {revision}). Amount: {amount}.",
      attach: KINDS,
    },
  });
  expect(r.status, r.text).toBe(200);
  return r;
}

/** RFC 2047 decode of a header value (B and Q encodings, UTF-8). */
function decodeHeader(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_m, enc: string, data: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(data, "base64").toString("utf8")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, hx) => String.fromCharCode(parseInt(hx, 16))), "latin1").toString("utf8"),
    );
}
function mimeHeader(mime: string, name: string): string | null {
  const head = mime.split(/\r?\n\r?\n/)[0]!.replace(/\r?\n[ \t]+/g, " ");
  const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? decodeHeader(line.slice(name.length + 1).trim()) : null;
}

const SECRET_VALUES = [...Object.values(ACCESS_TOKENS), SECRETS.GOOGLE_CLIENT_SECRET, SECRETS.MS_CLIENT_SECRET, SECRETS.ANTHROPIC_API_KEY, SECRETS.OPENAI_API_KEY, SECRETS.GEMINI_API_KEY, SECRETS.MISTRAL_API_KEY];

async function assertNoSecretsInResponses(hh: H): Promise<void> {
  const conns = await hh.repo.listConnections(DEMO_PROVIDER_ID);
  const blobs = conns.map((c) => c.encryptedTokens);
  for (const text of hh.responses) {
    for (const s of [...SECRET_VALUES, ...blobs]) expect(text.includes(s), `API response leaked secret ${s.slice(0, 12)}…`).toBe(false);
  }
  for (const line of logs) {
    for (const s of [...SECRET_VALUES, ...blobs, "fake-auth-code"]) expect(line.includes(s), `log line leaked secret ${s.slice(0, 12)}…: ${line.slice(0, 200)}`).toBe(false);
  }
}

function assertNoSendCalls(hh: H): void {
  const sends = hh.cloud.sendCalls();
  expect(sends.map((r) => `${r.method} ${r.url}`), "a SEND endpoint was called").toEqual([]);
}

// ------------------------------------------------------------------ files
describe.skipIf(!ready)("v2 integration (real modules + fake cloud/AI fetch)", () => {
  it("V2-01 completed session is listed with three files; each PDF downloads with correct headers", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);

    const list = await h.req("/api/files", { cookie });
    expect(list.status, list.text).toBe(200);
    const items = list.json.data.items;
    expect(items).toHaveLength(1);
    const row = items[0];
    expect(row.sessionId).toBe(id);
    expect(row.clientRef).toBe("C-104");
    expect(row.bundleRevision).toBe(2);
    expect(row.amountCents).toBe(EXPECTED.amountCents90);
    expect(row.confirmedMinutes).toBe(90);
    expect(row.evidenceMode).toBe("fixture");
    expect(row.files.map((f: { kind: string }) => f.kind).sort()).toEqual([...KINDS].sort());
    expect(list.json.data.nextCursor).toBeNull();

    for (const f of row.files) {
      expect(f.contentType).toBe("application/pdf");
      expect(f.downloadUrl).toBe(`/api/sessions/${id}/files/${f.kind}`);
      expect(f.filename).toMatch(/^C-104_2026-11-13_.+_r2\.pdf$/);
      const dl = await h.req(f.downloadUrl, { cookie });
      expect(dl.status, dl.text.slice(0, 200)).toBe(200);
      expect(dl.headers.get("content-type")).toMatch(/^application\/pdf/);
      expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="${f.filename}"`);
      expect(dl.headers.get("cache-control")).toMatch(/no-store/);
      const bytes = (dl as unknown as { bytes: Uint8Array }).bytes;
      expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(new TextDecoder("latin1").decode(bytes.slice(-1024))).toContain("%%EOF");
      expect(Number(dl.headers.get("content-length"))).toBe(bytes.length);
      const inline = await h.req(`${f.downloadUrl}?inline=1`, { cookie });
      expect(inline.headers.get("content-disposition")).toMatch(/^inline;/);
    }
    const bad = await h.req(`/api/sessions/${id}/files/not_a_kind`, { cookie });
    expect(bad.status).toBe(400);
    await assertNoSecretsInResponses(h);
  });

  // ------------------------------------------------------------------ google
  it("V2-02 Google: OAuth start/callback (fake token endpoint) → Drive upload (folder walk + 3 multipart) → Gmail draft with 3 attachments; never sends", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);
    await putStorage(h, cookie, "google");
    await putEmail(h, cookie, "google");

    // --- OAuth
    const before = await h.req("/api/connections", { cookie });
    expect(before.status, before.text).toBe(200);
    expect(before.json.data.find((c: { provider: string }) => c.provider === "google").status).toBe("not_connected");
    const start = await h.req("/api/connections/google/start", { method: "POST", cookie, body: { returnTo: "/#/settings" } });
    expect(start.status, start.text).toBe(200);
    const auth = new URL(start.json.data.authorizeUrl);
    expect(auth.host).toBe("accounts.google.com");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/connect/google/callback");
    expect(auth.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(auth.searchParams.get("scope")).not.toMatch(/gmail\.send|mail\.google\.com\/?($|\s)/);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const state = auth.searchParams.get("state")!;
    const cb = await h.req(`/auth/connect/google/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`, { origin: null });
    expect(cb.status, cb.text).toBe(302);
    expect(cb.headers.get("location")).toMatch(/connected=google/);
    const tokenReq = h.cloud.to(/oauth2\.googleapis\.com\/token/)[0]!;
    expect(tokenReq.body).toContain("code_verifier=");
    // state is one-time
    const replay = await h.req(`/auth/connect/google/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`, { origin: null });
    expect(replay.headers.get("location")).toMatch(/error=invalid_state/);
    const after = await h.req("/api/connections", { cookie });
    const g = after.json.data.find((c: { provider: string }) => c.provider === "google");
    expect(g.status).toBe("connected");
    expect(g.accountEmail).toBe("provider.google@example.invalid");
    expect(JSON.stringify(after.json)).not.toMatch(/token/i);

    // --- Drive
    h.cloud.reset();
    const files = (await h.req("/api/files", { cookie })).json.data.items[0].files as { kind: string; filename: string }[];
    const dr = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} });
    expect(dr.status, dr.text).toBe(201);
    expect(dr.json.data).toMatchObject({ target: "drive", provider: "google", status: "done", bundleRevision: 2 });
    expect(dr.json.data.files.sort()).toEqual([...KINDS].sort());
    const folder = h.cloud.gFolders.at(-1)!;
    expect(h.cloud.gFolders.map((f) => f.name)).toEqual(["Vexo Field Assistant", "C-104", "2026-11-13"]);
    expect(h.cloud.gFolders[1]!.parent).toBe(h.cloud.gFolders[0]!.id);
    expect(dr.json.data.externalId).toBe(folder.id);
    expect(dr.json.data.webUrl).toBe(`https://drive.google.com/drive/folders/${folder.id}`);
    const uploads = h.cloud.to(/\/upload\/drive\/v3\/files/);
    expect(uploads).toHaveLength(3);
    for (const u of uploads) {
      expect(u.headers["content-type"]).toMatch(/^multipart\/related; boundary=/);
      expect(u.headers["authorization"]).toBe(`Bearer ${ACCESS_TOKENS.google}`);
      expect(new TextDecoder("latin1").decode(u.bytes)).toContain("%PDF-");
    }
    expect(h.cloud.gFiles.map((f) => f.name).sort()).toEqual(files.map((f) => f.filename).sort());
    expect(h.cloud.gFiles.every((f) => f.parent === folder.id)).toBe(true);

    // second upload reuses folders (no new creates) and updates files in place
    const dr2 = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: { files: ["invoice"] } });
    expect(dr2.status, dr2.text).toBe(201);
    expect(h.cloud.gFolders).toHaveLength(3);
    expect(dr2.json.data.files).toEqual(["invoice"]);

    // --- Gmail draft
    const em = await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: [RECIPIENT] } });
    expect(em.status, em.text).toBe(201);
    expect(em.json.data).toMatchObject({ target: "email_draft", provider: "google", status: "done", recipients: [RECIPIENT] });
    expect(em.json.data.webUrl).toMatch(/^https:\/\/mail\.google\.com\//);
    expect(h.cloud.gDrafts).toHaveLength(1);
    const mime = h.cloud.gDrafts[0]!.mime;
    expect(mimeHeader(mime, "Subject")).toBe("Session documentation — C-104 — 2026-11-13");
    expect(mimeHeader(mime, "To")).toBe(RECIPIENT);
    const atts = mime.match(/Content-Disposition: attachment;[^\r\n]*/g) ?? [];
    expect(atts).toHaveLength(3);
    for (const f of files) expect(mime).toContain(`filename="${f.filename}"`);
    // each attachment decodes to a PDF
    const b64Parts = mime.split(/--[^\r\n]+\r\n/).filter((p) => p.includes("Content-Disposition: attachment"));
    for (const p of b64Parts) {
      const body = p.split(/\r\n\r\n/)[1]!.replace(/\s+/g, "");
      expect(Buffer.from(body, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
    // body text rendered
    const textPart = mime.split(/--[^\r\n]+\r\n/).find((p) => p.includes("text/plain"))!;
    const bodyText = Buffer.from(textPart.split(/\r\n\r\n/)[1]!.replace(/\s+/g, ""), "base64").toString("utf8");
    expect(bodyText).toContain("C-104 (2026-11-13, revision 2). Amount: $112.50.");

    const dl = await h.req(`/api/sessions/${id}/deliveries`, { cookie });
    expect(dl.status).toBe(200);
    expect(dl.json.data).toHaveLength(3);
    const listed = await h.req("/api/files", { cookie });
    expect(listed.json.data.items[0].deliveries).toHaveLength(3);

    expect(h.cloud.unhandled.map((r) => `${r.method} ${r.url}`)).toEqual([]);
    assertNoSendCalls(h);
    await assertNoSecretsInResponses(h);

    // disconnect revokes and clears
    const del = await h.req("/api/connections/google", { method: "DELETE", cookie });
    expect(del.status, del.text).toBe(200);
    expect(await h.repo.getConnection(DEMO_PROVIDER_ID, "google")).toBeNull();
  });

  // ------------------------------------------------------------------ microsoft
  it("V2-03 Microsoft: seeded encrypted connection → OneDrive folder walk + 3 uploads → Outlook draft with 3 attachments; never sends", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);
    await putStorage(h, cookie, "microsoft");
    await putEmail(h, cookie, "microsoft");
    await seedConnection(h, "microsoft");
    const conns = await h.req("/api/connections", { cookie });
    expect(conns.json.data.find((c: { provider: string }) => c.provider === "microsoft").status).toBe("connected");

    h.cloud.reset();
    const files = (await h.req("/api/files", { cookie })).json.data.items[0].files as { kind: string; filename: string }[];
    const dr = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} });
    expect(dr.status, dr.text).toBe(201);
    expect(dr.json.data).toMatchObject({ target: "drive", provider: "microsoft", status: "done" });
    const folderPath = "Vexo Field Assistant/C-104/2026-11-13";
    const folder = h.cloud.msItems.get(folderPath);
    expect(folder, [...h.cloud.msItems.keys()].join(",")).toBeTruthy();
    expect(h.cloud.msItems.get("Vexo Field Assistant")?.folder).toBe(true);
    expect(dr.json.data.externalId).toBe(folder!.id);
    expect(dr.json.data.webUrl).toBe(folder!.webUrl);
    const puts = h.cloud.to(/\/content/).filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(3);
    for (const p of puts) {
      expect(p.headers["authorization"]).toBe(`Bearer ${ACCESS_TOKENS.microsoft}`);
      expect(new TextDecoder("latin1").decode(p.bytes.slice(0, 5))).toBe("%PDF-");
    }
    for (const f of files) expect(h.cloud.msItems.has(`${folderPath}/${f.filename}`), f.filename).toBe(true);

    const em = await h.req(`/api/sessions/${id}/deliveries/email-draft`, {
      method: "POST",
      cookie,
      body: { to: [RECIPIENT], cc: ["cc.person@example.invalid"] },
    });
    expect(em.status, em.text).toBe(201);
    expect(em.json.data).toMatchObject({ target: "email_draft", provider: "microsoft", status: "done" });
    expect(em.json.data.recipients).toEqual([RECIPIENT, "cc.person@example.invalid"]);
    expect(em.json.data.webUrl).toMatch(/^https:\/\/outlook\./);
    expect(h.cloud.msDrafts).toHaveLength(1);
    const msg = h.cloud.msDrafts[0]!.body;
    expect(msg.subject).toBe("Session documentation — C-104 — 2026-11-13");
    expect(msg.toRecipients).toEqual([{ emailAddress: { address: RECIPIENT } }]);
    expect(msg.attachments).toHaveLength(3);
    expect(msg.attachments.map((a: { name: string }) => a.name).sort()).toEqual(files.map((f) => f.filename).sort());
    for (const a of msg.attachments) {
      expect(a.contentType).toBe("application/pdf");
      expect(Buffer.from(a.contentBytes, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
    expect(h.cloud.unhandled.map((r) => `${r.method} ${r.url}`)).toEqual([]);
    assertNoSendCalls(h);
    await assertNoSecretsInResponses(h);
  });

  it("V2-04 expired access token is refreshed via the fake token endpoint before upload; refreshed token is used", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);
    await putStorage(h, cookie, "google");
    await seedConnection(h, "google", -60_000);
    h.cloud.reset();
    const dr = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} });
    expect(dr.status, dr.text).toBe(201);
    const tok = h.cloud.to(/oauth2\.googleapis\.com\/token/);
    expect(tok).toHaveLength(1);
    expect(tok[0]!.body).toContain("grant_type=refresh_token");
    const conn = await h.repo.getConnection(DEMO_PROVIDER_ID, "google");
    expect(Date.parse(conn!.accessTokenExpiresAt!)).toBeGreaterThan(h.clock.now().getTime());
    assertNoSendCalls(h);
    await assertNoSecretsInResponses(h);
  });

  // ------------------------------------------------------------------ auto upload
  it("V2-05 auto-upload on completion: onSessionCompleted enqueues once, processFileDelivery uploads 3 files, idempotent", async () => {
    h = (await createV2Harness()) as H;
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    const cookie0 = await h.login();
    await putStorage(h, cookie0, "google", true);
    await seedConnection(h, "google");
    const { id } = await completeDemo(h);
    const { onSessionCompleted, processFileDelivery, autoDeliveryId } = h.v2.delivery;
    const deps = h.apiDeps;

    const r1 = await onSessionCompleted(deps, id);
    expect(r1.enqueued).toBe(true);
    expect(r1.deliveryId).toBe(autoDeliveryId(id, 2));
    const r2 = await onSessionCompleted(deps, id);
    expect(r2.deliveryId).toBe(r1.deliveryId);
    expect((await h.repo.listFileDeliveries(id)).filter((d) => d.id === r1.deliveryId)).toHaveLength(1);
    const pending = await h.repo.getDelivery(`file_delivery:${id}:2`);
    expect(pending?.operation).toBe("file_delivery");
    expect(pending?.payload).toEqual({ deliveryId: r1.deliveryId });
    expect(JSON.stringify(pending?.payload)).not.toMatch(/token|%PDF/i);

    // the workflow completion hook may already have run the upload (Agent 01 wiring)
    const uploadsBefore = h.cloud.to(/\/upload\/drive\/v3\/files/).length;
    const done = await processFileDelivery(deps, r1.deliveryId);
    expect(done?.status).toBe("done");
    expect(done?.webUrl).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
    const uploadsAfter = h.cloud.to(/\/upload\/drive\/v3\/files/).length;
    expect(uploadsAfter - uploadsBefore).toBe(uploadsBefore === 0 ? 3 : 0);
    // done → skip
    await processFileDelivery(deps, r1.deliveryId);
    expect(h.cloud.to(/\/upload\/drive\/v3\/files/).length).toBe(uploadsAfter);
    expect((await h.repo.getFileDelivery(r1.deliveryId))?.status).toBe("done");
    assertNoSendCalls(h);
  });

  it("V2-05b auto-upload disabled or not connected → nothing enqueued", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);
    const { onSessionCompleted } = h.v2.delivery;
    await putStorage(h, cookie, "google", false);
    await seedConnection(h, "google");
    expect((await onSessionCompleted(h.apiDeps, id)).enqueued).toBe(false);
    await h.repo.deleteConnection(DEMO_PROVIDER_ID, "google");
    await putStorage(h, cookie, "google", true);
    expect((await onSessionCompleted(h.apiDeps, id)).enqueued).toBe(false);
    expect(await h.repo.listFileDeliveries(id)).toEqual([]);
    expect(h.cloud.requests.filter((r) => /googleapis/.test(r.url))).toEqual([]);
  });

  it("V2-05c auto-upload end-to-end via workflow completion + jobs dispatch (Agent 01 wiring)", async () => {
    h = (await createV2Harness()) as H;
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    const cookie0 = await h.login();
    await putStorage(h, cookie0, "google", true);
    await seedConnection(h, "google");
    const { id } = await completeDemo(h);
    // dispatch any due pending deliveries (includes file_delivery once wired)
    h.clock.advance(60_000);
    await h.apiDeps.dispatch();
    await h.settle();
    const ds = await h.repo.listFileDeliveries(id);
    expect(ds.map((d) => `${d.target}:${d.status}`), "no auto drive delivery created by the completion hook").toContain("drive:done");
  });

  // ------------------------------------------------------------------ guards
  it("V2-06 wrong provider → 404 on files/deliveries; other provider's /api/files is empty", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);
    await putStorage(h, cookie, "google");
    await seedConnection(h, "google");
    await h.repo.upsertProvider("provider_other_002", OTHER_PROVIDER_IDENTITY);
    const other = await h.login(OTHER_PROVIDER_IDENTITY);
    for (const k of KINDS) expect((await h.req(`/api/sessions/${id}/files/${k}`, { cookie: other })).status).toBe(404);
    expect((await h.req(`/api/sessions/${id}/deliveries`, { cookie: other })).status).toBe(404);
    const d = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie: other, body: { provider: "google" } });
    expect(d.status, d.text).toBe(404);
    const e = await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie: other, body: { provider: "google", to: [RECIPIENT] } });
    expect(e.status, e.text).toBe(404);
    const list = await h.req("/api/files", { cookie: other });
    expect(list.status).toBe(200);
    expect(list.json.data.items).toEqual([]);
    expect(list.text).not.toContain("C-104");
    expect(h.cloud.requests.filter((r) => /googleapis/.test(r.url))).toEqual([]);
    // unauthenticated
    expect((await h.req("/api/files")).status).toBe(401);
    expect((await h.req(`/api/sessions/${id}/files/invoice`)).status).toBe(401);
    // cross-origin mutation
    const xo = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {}, origin: "https://evil.example" });
    expect(xo.status).toBe(403);
  });

  it("V2-07 not completed → 409 on files/drive/email-draft; not connected → 409; no provider → 422; bad body → 400", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await seedAndSync(h);
    await putStorage(h, cookie, "google");
    await putEmail(h, cookie, "google");
    await seedConnection(h, "google");
    for (const k of KINDS) expect((await h.req(`/api/sessions/${id}/files/${k}`, { cookie })).status).toBe(409);
    expect((await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} })).status).toBe(409);
    expect((await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: [RECIPIENT] } })).status).toBe(409);
    expect((await h.req("/api/files", { cookie })).json.data.items).toEqual([]);
    expect(h.cloud.requests.filter((r) => /googleapis/.test(r.url))).toEqual([]);

    // complete it, then drop the connection
    await h.req(`/api/sessions/${id}/review`, {
      method: "PATCH",
      cookie,
      body: { expectedRevision: 1, edits: { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation } },
    });
    await h.req(`/api/sessions/${id}/approve`, { method: "POST", cookie, body: { expectedRevision: 2, idempotencyKey: EXPECTED.demoApprovalKey } });
    await h.settle();
    await h.repo.deleteConnection(DEMO_PROVIDER_ID, "google");
    const nd = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} });
    expect(nd.status, nd.text).toBe(409);
    const ne = await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: [RECIPIENT] } });
    expect(ne.status, ne.text).toBe(409);
    const nm = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: { provider: "microsoft" } });
    expect(nm.status, nm.text).toBe(409);
    expect(await h.repo.listFileDeliveries(id)).toEqual([]);

    // no provider in settings → 422
    await h.req("/api/settings/storage", { method: "PUT", cookie, body: { provider: null, folderPath: "X", autoUploadOnComplete: false } });
    expect((await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} })).status).toBe(422);

    // invalid bodies
    expect((await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: [] } })).status).toBe(400);
    expect((await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: ["not-an-email"] } })).status).toBe(400);
    expect((await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: [RECIPIENT], bcc: ["x@example.invalid"] } })).status).toBe(400);
    expect((await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: { provider: "dropbox" } })).status).toBe(400);
    expect((await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: { files: ["passport"] } })).status).toBe(400);
    assertNoSendCalls(h);
  });

  it("V2-08 provider API failure → delivery recorded as failed with a safe message (no token)", async () => {
    h = (await createV2Harness()) as H;
    const { cookie, id } = await completeDemo(h);
    await putEmail(h, cookie, "google");
    await seedConnection(h, "google");
    h.cloud.failOnce.push({ re: /gmail\.googleapis\.com/, status: 403 });
    const r = await h.req(`/api/sessions/${id}/deliveries/email-draft`, { method: "POST", cookie, body: { to: [RECIPIENT] } });
    expect(r.status, r.text).toBeGreaterThanOrEqual(400);
    const ds = await h.repo.listFileDeliveries(id);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.status).toBe("failed");
    expect(ds[0]!.error ?? "").not.toContain(ACCESS_TOKENS.google);
    assertNoSendCalls(h);
    await assertNoSecretsInResponses(h);
  });

  // ------------------------------------------------------------------ settings
  it("V2-09 settings: GET defaults, PUT validation (storage/email/ai), cross-origin + unauth rejected, no keys exposed", async () => {
    h = (await createV2Harness()) as H;
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    const cookie = await h.login();
    const g = await h.req("/api/settings", { cookie });
    expect(g.status, g.text).toBe(200);
    expect(g.json.data.storage.provider).toBeNull();
    expect(g.json.data.ai.provider).toBe("anthropic");
    expect(g.json.data.extractionMode).toBe("fixture");
    expect(g.json.data.aiProviders.map((p: { provider: string; configured: boolean }) => `${p.provider}:${p.configured}`)).toEqual([
      "anthropic:true",
      "openai:true",
      "gemini:true",
      "mistral:true",
    ]);

    const bad: [string, unknown][] = [
      ["/api/settings/storage", { provider: "google", folderPath: "a:b", autoUploadOnComplete: false }],
      ["/api/settings/storage", { provider: "google", folderPath: "", autoUploadOnComplete: false }],
      ["/api/settings/storage", { provider: "dropbox", folderPath: "x", autoUploadOnComplete: false }],
      ["/api/settings/storage", { provider: "google", folderPath: "x", autoUploadOnComplete: false, extra: 1 }],
      ["/api/settings/email", { provider: "google", defaultTo: ["nope"], defaultCc: [], subjectTemplate: "s", bodyTemplate: "b", attach: [] }],
      ["/api/settings/email", { provider: "google", defaultTo: [], defaultCc: [], subjectTemplate: "a\r\nBcc: x@evil.example", bodyTemplate: "b", attach: [] }],
      ["/api/settings/email", { provider: "google", defaultTo: [], defaultCc: [], subjectTemplate: "s", bodyTemplate: "b", attach: ["passport"] }],
      ["/api/settings/ai", { provider: "cohere", model: "x", privacy: { redactNames: true, redactContact: true, redactIdentifiers: true, redactAddresses: true, redactDates: true } }],
      ["/api/settings/ai", { provider: "openai", model: "", privacy: { redactNames: true, redactContact: true, redactIdentifiers: true, redactAddresses: true, redactDates: true } }],
      ["/api/settings/ai", { provider: "openai", model: "gpt-4.1", privacy: { redactNames: true } }],
    ];
    for (const [path, body] of bad) {
      const r = await h.req(path, { method: "PUT", cookie, body });
      expect(r.status, `${path} ${JSON.stringify(body)} → ${r.text}`).toBe(400);
    }
    const unchanged = await h.req("/api/settings", { cookie });
    expect(unchanged.json.data).toEqual(g.json.data);

    const s = await h.req("/api/settings/storage", { method: "PUT", cookie, body: { provider: "microsoft", folderPath: "Docs/{clientRef}", autoUploadOnComplete: true } });
    expect(s.status, s.text).toBe(200);
    expect(s.json.data.storage).toEqual({ provider: "microsoft", folderPath: "Docs/{clientRef}", autoUploadOnComplete: true });
    expect((await h.req("/api/settings/storage", { method: "PUT", cookie: null, body: { provider: null, folderPath: "x", autoUploadOnComplete: false } })).status).toBe(401);
    expect(
      (await h.req("/api/settings/storage", { method: "PUT", cookie, origin: "https://evil.example", body: { provider: null, folderPath: "x", autoUploadOnComplete: false } })).status,
    ).toBe(403);
    // settings are per provider
    await h.repo.upsertProvider("provider_other_002", OTHER_PROVIDER_IDENTITY);
    const other = await h.login(OTHER_PROVIDER_IDENTITY);
    expect((await h.req("/api/settings", { cookie: other })).json.data.storage.provider).toBeNull();

    // live mode: AI provider without a key → 422
    h.env.EXTRACTION_MODE = "live";
    delete h.env.MISTRAL_API_KEY;
    const nk = await h.req("/api/settings/ai", {
      method: "PUT",
      cookie,
      body: { provider: "mistral", model: "mistral-large-latest", privacy: { redactNames: true, redactContact: true, redactIdentifiers: true, redactAddresses: true, redactDates: true } },
    });
    expect(nk.status, nk.text).toBe(422);
    await assertNoSecretsInResponses(h);
  });

  // ------------------------------------------------------------------ AI + privacy
  const PLANTED = {
    name: "Jordan Whitfield",
    ssn: "123-45-6789",
    phone: "(555) 867-5309",
    email: "jordan.whitfield@example.com",
    dob: "04/12/1987",
    address: "42 Maple Street",
  };
  const PLANTED_LINE = `Participant ${PLANTED.name} (client C-104, DOB ${PLANTED.dob}, SSN ${PLANTED.ssn}) can be reached at ${PLANTED.phone} or ${PLANTED.email} and lives at ${PLANTED.address}.`;
  const plantedEvidence: EvidenceItem = {
    ...demoEvidence[2]!,
    id: "ev_006",
    observedFrom: "2026-11-13T18:30:00.000Z",
    observedTo: "2026-11-13T18:31:00.000Z",
    speaker: "Provider",
    excerpt: PLANTED_LINE,
  };
  const PRIVACY_ALL = { redactNames: true, redactContact: true, redactIdentifiers: true, redactAddresses: true, redactDates: true };

  function aiBodyText(vendor: string, r: Recorded): string {
    // Whole serialized body — anything the vendor would receive.
    void vendor;
    return r.body;
  }

  for (const [provider, model, hostRe] of [
    ["anthropic", "claude-sonnet-5-5", /^https:\/\/api\.anthropic\.com\/v1\/messages/],
    ["openai", "gpt-4.1", /^https:\/\/api\.openai\.com\/v1\/chat\/completions/],
    ["gemini", "gemini-2.5-pro", /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-pro:generateContent/],
    ["mistral", "mistral-large-latest", /^https:\/\/api\.mistral\.ai\/v1\/chat\/completions/],
  ] as [AiProviderId, string, RegExp][]) {
    it(`V2-10 live extraction via ${provider}: settings switch → scrubbed request (planted PII never raw) → restored facts contain originals`, async () => {
      h = (await createV2Harness()) as H;
      await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
      const cookie = await h.login();
      h.env.EXTRACTION_MODE = "live";
      const put = await h.req("/api/settings/ai", { method: "PUT", cookie, body: { provider, model, privacy: PRIVACY_ALL } });
      expect(put.status, put.text).toBe(200);
      expect(put.json.data.ai.provider).toBe(provider);

      let seenTokens: string[] = [];
      h.cloud.ai = (_vendor, r) => {
        // tokens from the planted evidence line only (the system prompt has example tokens)
        const seg = /ev_006[^<]*/.exec(r.body)?.[0] ?? "";
        seenTokens = [...new Set(seg.match(/\[[A-Z_]+_\d+\]/g) ?? [])];
        const facts: SessionFacts = structuredClone(demoFacts);
        facts.observations.push({
          id: "fact_obs_pii",
          text: `Contact details confirmed: ${seenTokens.join(" ")}`,
          evidenceIds: ["ev_006"],
          support: "supported",
        });
        return facts;
      };
      const extractor = h.mods.ai.createExtractor(h.env, {
        fetch: h.cloud.fetch,
        retryDelayMs: 0,
        resolveSettings: async (pid: string) => (await h!.repo.getAiSettings(pid))!,
      });
      expect(extractor.mode).toBe("live");
      const out = await extractor.extractFacts({ appointment: demoAppointment, plan: demoPlan, evidence: [...demoEvidence, plantedEvidence] });

      const calls = h.cloud.requests.filter((r) => /anthropic|openai|generativelanguage|mistral/.test(r.url));
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const c of calls) {
        expect(c.url).toMatch(hostRe);
        const body = aiBodyText(provider, c);
        expect(body.includes(PLANTED_LINE), "planted evidence line sent raw").toBe(false);
        for (const [k, v] of Object.entries({ ssn: PLANTED.ssn, phone: PLANTED.phone, email: PLANTED.email, clientRef: "C-104" })) {
          expect(body.includes(v), `${k} '${v}' sent raw to ${provider}`).toBe(false);
        }
        // the key travels only in headers, never in the body/URL
        expect(body).not.toContain(SECRETS[`${provider.toUpperCase()}_API_KEY` as keyof typeof SECRETS]);
        expect(c.url).not.toContain(SECRETS[`${provider.toUpperCase()}_API_KEY` as keyof typeof SECRETS]);
      }
      expect(seenTokens.length, "no privacy tokens found in outbound request").toBeGreaterThan(0);

      expect(out.mode).toBe("live");
      expect(out.model).toBe(model);
      // v2 provenance: provider + privacy report (counts only, never values)
      expect(out.aiProvider).toBe(provider);
      expect(out.privacy?.scrubbed).toBe(true);
      for (const t of ["SSN", "PHONE", "EMAIL", "CLIENT_REF"]) expect(out.privacy.findings[t], t).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(out.privacy)).not.toMatch(/123-45-6789|jordan|5309|C-104/i);
      const obs = out.facts.observations.find((o: { id: string }) => o.id === "fact_obs_pii");
      expect(obs, "restored facts missing the PII observation").toBeTruthy();
      expect(obs!.text).not.toMatch(/\[[A-Z_]+_\d+\]/);
      for (const v of [PLANTED.ssn, PLANTED.email]) expect(obs!.text).toContain(v);
      expect(obs!.text.replace(/\D/g, "")).toContain("5558675309");
      // validated + original facts intact
      expect(out.facts.activities.map((a: { id: string }) => a.id)).toEqual(["fact_act_1", "fact_act_2"]);
      for (const line of logs) for (const v of Object.values(PLANTED)) expect(line.includes(v), `log leaked PII ${v}`).toBe(false);
      await assertNoSecretsInResponses(h);
    });
  }

  it("V2-11 privacy: participant name, DOB and street address in evidence are not sent raw (all redaction switches on)", async () => {
    h = (await createV2Harness()) as H;
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    h.env.EXTRACTION_MODE = "live";
    h.cloud.ai = () => structuredClone(demoFacts);
    const extractor = h.mods.ai.createExtractor(h.env, {
      fetch: h.cloud.fetch,
      retryDelayMs: 0,
      resolveSettings: async () => ({ provider: "openai", model: "gpt-4.1", privacy: PRIVACY_ALL }),
    });
    await extractor.extractFacts({ appointment: demoAppointment, plan: demoPlan, evidence: [...demoEvidence, plantedEvidence] });
    const body = h.cloud.requests.find((r) => /openai/.test(r.url))!.body;
    expect(body.includes(PLANTED.name), "name sent raw").toBe(false);
    expect(body.includes(PLANTED.dob), "DOB sent raw").toBe(false);
    expect(body.includes(PLANTED.address), "address sent raw").toBe(false);
  });

  it("V2-12 live extraction with an unconfigured provider fails without any network call", async () => {
    h = (await createV2Harness()) as H;
    h.env.EXTRACTION_MODE = "live";
    delete h.env.GEMINI_API_KEY;
    h.cloud.ai = () => structuredClone(demoFacts);
    const extractor = h.mods.ai.createExtractor(h.env, {
      fetch: h.cloud.fetch,
      retryDelayMs: 0,
      resolveSettings: async () => ({ provider: "gemini", model: "gemini-2.5-pro", privacy: PRIVACY_ALL }),
    });
    await expect(extractor.extractFacts({ appointment: demoAppointment, plan: demoPlan, evidence: demoEvidence })).rejects.toThrow();
    expect(h.cloud.requests).toEqual([]);
  });

  it("V2-13 end-to-end live mode: workflow extraction uses the provider's saved AI settings (mistral), scrubs, records provenance", async () => {
    h = (await createV2Harness()) as H;
    await h.mods.seed.seedDemoData(h.repo, { variant: "normal" });
    const cookie = await h.login();
    h.env.EXTRACTION_MODE = "live";
    const put = await h.req("/api/settings/ai", { method: "PUT", cookie, body: { provider: "mistral", model: "mistral-small-latest", privacy: PRIVACY_ALL } });
    expect(put.status, put.text).toBe(200);
    h.cloud.ai = () => structuredClone(demoFacts);
    const sync = await h.req("/api/sync", { method: "POST", cookie });
    expect(sync.status, sync.text).toBe(202);
    await h.settle();
    const d = await h.req(`/api/sessions/${await SID()}`, { cookie });
    expect(d.status, d.text).toBe(200);
    expect(d.json.data.session.status).toBe("NEEDS_REVIEW");
    const prov = d.json.data.bundle.provenance;
    expect(prov).toMatchObject({ extractionMode: "live", aiProvider: "mistral", model: "mistral-small-latest" });
    // the synthetic demo transcript holds no PII → report present, nothing replaced
    expect(prov.privacy).toEqual({ scrubbed: false, findings: {} });
    const calls = h.cloud.to(/api\.mistral\.ai/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).not.toContain("C-104");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SECRETS.MISTRAL_API_KEY}`);
    expect(h.cloud.to(/anthropic|openai|generativelanguage/)).toEqual([]);
    await assertNoSecretsInResponses(h);
  });
});
