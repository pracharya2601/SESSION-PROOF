/**
 * W9 — v3 in-process integration over REAL modules + Miniflare D1 (all migrations).
 * Clients + per-client rate, client snapshot, documents (DocModel), templates,
 * participant direction, run history, provider isolation.
 * Outbound HTTP goes to the recording FakeCloud. Test names carry V3-xx ids
 * mapped in docs/v3-test-report.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { sessionIdFor, workflowInstanceId } from "../../src/contracts";
import type { FileKind, SessionFacts, StoredConnection } from "../../src/contracts";
import {
  DEMO_PROVIDER_ID,
  DEMO_PROVIDER_IDENTITY,
  EXPECTED,
  OTHER_PROVIDER_IDENTITY,
  demoAppointment,
  demoEvidence,
  demoFacts,
} from "../../fixtures/scenario";
import { missingModules } from "../e2e/harness";
import { missingV2Modules, SECRETS } from "../e2e/v2-harness";
import { ACCESS_TOKENS } from "../e2e/v2-fake-fetch";
import { createV3Harness, missingV3Modules, type V3Harness } from "../e2e/v3-harness";

const missing = [...missingModules(), ...missingV2Modules(), ...missingV3Modules()];
const ready = missing.length === 0;
if (!ready) console.warn(`[v3-flow.test] NOT RUN — missing modules: ${missing.join(", ")}`);

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

const KINDS: FileKind[] = ["session_note", "invoice", "approval_record"];
const SID = () => sessionIdFor(DEMO_PROVIDER_ID, demoAppointment.occurrenceId);
const CHOICES = "Chose the bus route and picked the grocery store for budgeting practice.";
/** Planted sensitive client names: may appear on documents, never in run events or AI requests. */
const PLANTED_NAME = "Jordan Plantedname";
const PLANTED_PREFERRED = "Jojo Plantedpref";

/** Make the clock advance 1 ms per read (frozen clocks make event ordering ambiguous). */
function tickingClock(hh: V3Harness): void {
  const c = hh.clock as unknown as { now(): Date; advance(ms: number): void };
  const orig = c.now.bind(c);
  c.now = () => {
    c.advance(1);
    return orig();
  };
}

async function newHarness(variant = "normal"): Promise<V3Harness> {
  const hh = await createV3Harness({ variant });
  if (!process.env.QA_FROZEN_CLOCK) tickingClock(hh);
  return hh;
}

const docText = (m: unknown) => JSON.stringify(m);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function getClient(hh: V3Harness, cookie: string, ref = "C-104") {
  const r = await hh.req(`/api/clients/${ref}`, { cookie });
  expect(r.status, r.text).toBe(200);
  return r.json.data as { client: any; stats: any };
}

/** PUT the client with overrides on top of its current record. */
async function putClient(hh: V3Harness, cookie: string, patch: Record<string, unknown>, ref = "C-104") {
  const cur = await hh.req(`/api/clients/${ref}`, { cookie });
  const base =
    cur.status === 200
      ? cur.json.data.client
      : {
          clientRef: ref,
          displayName: null,
          preferredName: null,
          hourlyRateCents: null,
          fundingSource: null,
          authorizationNumber: null,
          fiscalIntermediary: null,
          authorizedHours: null,
          caseManager: null,
          customFields: [],
          templates: { session_note: null, invoice: null, approval_record: null },
          notes: null,
          active: true,
        };
  const input: Record<string, unknown> = {};
  for (const k of [
    "clientRef",
    "displayName",
    "preferredName",
    "hourlyRateCents",
    "fundingSource",
    "authorizationNumber",
    "fiscalIntermediary",
    "authorizedHours",
    "caseManager",
    "customFields",
    "templates",
    "notes",
    "active",
  ])
    input[k] = base[k];
  Object.assign(input, patch);
  const r = await hh.req(`/api/clients/${ref}`, { method: "PUT", cookie, body: input });
  expect(r.status, r.text).toBe(200);
  return r.json.data as any;
}

async function seedLogin(hh: V3Harness): Promise<string> {
  await hh.mods.seed.seedDemoData(hh.repo, { variant: "normal" });
  return hh.login();
}

async function sync(hh: V3Harness, cookie: string): Promise<string> {
  const s = await hh.req("/api/sync", { method: "POST", cookie });
  expect(s.status, s.text).toBe(202);
  await hh.settle();
  return SID();
}

async function review(hh: V3Harness, cookie: string, id: string, edits: Record<string, unknown>, expectedRevision = 1) {
  const r = await hh.req(`/api/sessions/${id}/review`, { method: "PATCH", cookie, body: { expectedRevision, edits } });
  expect(r.status, r.text).toBe(200);
  return r;
}

async function approve(hh: V3Harness, cookie: string, id: string, expectedRevision = 2) {
  const a = await hh.req(`/api/sessions/${id}/approve`, {
    method: "POST",
    cookie,
    body: { expectedRevision, idempotencyKey: EXPECTED.demoApprovalKey },
  });
  expect([200, 202], a.text).toContain(a.status);
  await hh.settle();
  const d = await hh.req(`/api/sessions/${id}`, { cookie });
  expect(d.json.data.session.status).toBe("COMPLETED");
  return d.json.data;
}

async function bundleOf(hh: V3Harness, cookie: string, id: string) {
  const d = await hh.req(`/api/sessions/${id}`, { cookie });
  expect(d.status, d.text).toBe(200);
  return d.json.data.bundle;
}

async function getDoc(hh: V3Harness, cookie: string, id: string, kind: FileKind, templateId?: string) {
  const q = templateId ? `?templateId=${encodeURIComponent(templateId)}` : "";
  const r = await hh.req(`/api/sessions/${id}/documents/${kind}${q}`, { cookie });
  expect(r.status, r.text).toBe(200);
  return r.json.data;
}

function template(kind: FileKind, over: { theme?: Record<string, unknown>; text?: Record<string, unknown>; name?: string } = {}) {
  return {
    kind,
    name: over.name ?? `QA ${kind}`,
    theme: {
      accentColor: "#1f6feb",
      fontFamily: "sans",
      paper: "letter",
      density: "comfortable",
      logoText: "QA Agency",
      headerNote: "",
      footerNote: "",
      ...(over.theme ?? {}),
    },
    sections: [],
    text: {
      title: "",
      invoicePrefix: "QA",
      paymentTerms: "",
      invoiceNotes: "",
      attestationStatement: "",
      participantSignatureLabel: "Participant",
      providerSignatureLabel: "Provider",
      representativeSignatureLabel: "",
      ...(over.text ?? {}),
    },
  };
}

async function createTemplate(hh: V3Harness, cookie: string, body: unknown) {
  const r = await hh.req("/api/templates", { method: "POST", cookie, body });
  expect([200, 201], r.text).toContain(r.status);
  expect(r.json.data.id).toMatch(/^tpl_/);
  return r.json.data as any;
}

async function pdfPageSize(bytes: Uint8Array): Promise<{ w: number; h: number; pages: number }> {
  expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
  expect(new TextDecoder("latin1").decode(bytes.slice(-1024))).toContain("%%EOF");
  const doc = await PDFDocument.load(bytes);
  const p = doc.getPage(0).getSize();
  return { w: Math.round(p.width), h: Math.round(p.height), pages: doc.getPageCount() };
}

async function seedGoogle(hh: V3Harness, cookie: string): Promise<void> {
  const now = hh.clock.now();
  const conn: StoredConnection = {
    providerId: DEMO_PROVIDER_ID,
    provider: "google",
    accountEmail: "provider.google@example.invalid",
    scopes: ["openid", "email"],
    encryptedTokens: await hh.v2.security.encryptToken(
      JSON.stringify({ accessToken: ACCESS_TOKENS.google, refreshToken: ACCESS_TOKENS.googleRefresh }),
      hh.env.TOKEN_ENCRYPTION_KEY as string,
    ),
    accessTokenExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    status: "connected",
    lastError: null,
    connectedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await hh.repo.saveConnection(conn);
  const r = await hh.req("/api/settings/storage", {
    method: "PUT",
    cookie,
    body: { provider: "google", folderPath: "Vexo Field Assistant/{clientRef}/{serviceDate}", autoUploadOnComplete: false },
  });
  expect(r.status, r.text).toBe(200);
}

async function allRunEvents(hh: V3Harness, cookie: string): Promise<{ runs: any[]; events: any[] }> {
  const list = await hh.req("/api/runs", { cookie });
  expect(list.status, list.text).toBe(200);
  const runs = list.json.data.runs as any[];
  const events: any[] = [];
  for (const r of runs) {
    const d = await hh.req(`/api/runs/${encodeURIComponent(r.runId)}`, { cookie });
    expect(d.status, d.text).toBe(200);
    events.push(...d.json.data.events);
  }
  return { runs, events };
}

/** Values that must never appear in any run event (names, excerpts, identity, tokens, secrets). */
function forbiddenInEvents(extra: string[] = []): string[] {
  const excerpts = demoEvidence.map((e) => e.excerpt.trim()).filter((x) => x.length >= 12);
  return [
    PLANTED_NAME,
    PLANTED_PREFERRED,
    DEMO_PROVIDER_IDENTITY,
    EXPECTED.demoProgressConfirmation,
    CHOICES,
    ...excerpts,
    ...Object.values(ACCESS_TOKENS),
    ...Object.values(SECRETS).filter((s) => s.length > 10),
    ...extra,
  ];
}

function assertEventsClean(events: unknown[], extra: string[] = []): void {
  const blob = JSON.stringify(events);
  for (const v of forbiddenInEvents(extra)) expect(blob.includes(v), `run events leaked '${v.slice(0, 40)}'`).toBe(false);
}

/** stages must appear in `got` in this relative order (subsequence). */
function expectOrdered(got: string[], want: string[]): void {
  let i = 0;
  for (const s of got) if (s === want[i]) i++;
  expect(i, `stage order: wanted subsequence ${want.join(" → ")} in ${got.join(" → ")}`).toBe(want.length);
}

// ====================================================================== tests
describe.skipIf(!ready)("v3 integration (real modules + Miniflare D1 + fake cloud/AI)", () => {
  // -------------------------------------------------------------- clients + rate
  it("V3-01 seed → client C-104 exists with funding fields; list/get/validation", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const list = await h.req("/api/clients", { cookie });
    expect(list.status, list.text).toBe(200);
    const refs = (list.json.data as any[]).map((s) => s.client.clientRef);
    expect(refs).toContain("C-104");
    const { client, stats } = await getClient(h, cookie);
    expect(client.providerId).toBe(DEMO_PROVIDER_ID);
    expect(client.rateVersion).toBeGreaterThanOrEqual(1);
    const funding = [client.fundingSource, client.authorizationNumber, client.fiscalIntermediary, client.caseManager];
    expect(funding.some((v) => typeof v === "string" && v.length > 0), `no funding fields seeded: ${JSON.stringify(client)}`).toBe(true);
    expect(stats).toMatchObject({ sessions: expect.any(Number), billedCents: expect.any(Number) });
    // search
    const s = await h.req("/api/clients?search=C-104", { cookie });
    expect((s.json.data as any[]).map((x) => x.client.clientRef)).toContain("C-104");
    // mismatched ref / bad body
    const bad = await h.req("/api/clients/C-104", { method: "PUT", cookie, body: { ...client, clientRef: "C-999" } });
    expect(bad.status).toBe(400);
    const bad2 = await h.req("/api/clients/C-104", { method: "PUT", cookie, body: { clientRef: "C-104" } });
    expect(bad2.status).toBe(400);
    expect((await h.req("/api/clients/NOPE-1", { cookie })).status).toBe(404);
    // same-origin required for mutations
    const xo = await h.req("/api/clients/C-104", { method: "PUT", cookie, body: client, origin: "https://evil.example" });
    expect(xo.status).toBe(403);
  });

  it("V3-02 client rate 9000 → sync → draft at $90/hr, 90 min → 13500 cents, rateVersion client:C-104:vN", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const before = (await getClient(h, cookie)).client;
    const rec = await putClient(h, cookie, { hourlyRateCents: 9000 });
    expect(rec.hourlyRateCents).toBe(9000);
    if (before.hourlyRateCents !== 9000) expect(rec.rateVersion).toBe(before.rateVersion + 1);
    // unchanged rate → no bump
    const rec2 = await putClient(h, cookie, { notes: "rate unchanged edit" });
    expect(rec2.rateVersion).toBe(rec.rateVersion);

    const id = await sync(h, cookie);
    const b1 = await bundleOf(h, cookie, id);
    expect(b1.config.rate.hourlyRateCents).toBe(9000);
    expect(b1.billing.hourlyRateCents).toBe(9000);
    const rv = `client:C-104:v${rec.rateVersion}`;
    expect(b1.config.rate.rateVersion).toBe(rv);
    expect(b1.billing.rateVersion).toBe(rv);

    await review(h, cookie, id, { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation });
    const b2 = await bundleOf(h, cookie, id);
    expect(b2.billing.amountCents).toBe(13500);
    expect(b2.billing.rateVersion).toBe(rv);
  });

  it("V3-03 rate/funding change after approval → finalized invoice + documents unchanged (client snapshot)", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const rec = await putClient(h, cookie, { hourlyRateCents: 9000, fundingSource: "QA Funding Alpha", displayName: PLANTED_NAME });
    const id = await sync(h, cookie);
    await review(h, cookie, id, { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation });
    await approve(h, cookie, id);

    const snap = await h.repo.getClientSnapshot(id, 2);
    expect(snap, "no client snapshot saved at finalization").toBeTruthy();
    expect(snap!.effectiveHourlyRateCents).toBe(9000);
    expect(snap!.fundingSource).toBe("QA Funding Alpha");
    expect(snap!.rateVersion).toBe(rec.rateVersion);

    const invBefore = await getDoc(h, cookie, id, "invoice");
    const pdfBefore = await h.req(`/api/sessions/${id}/files/invoice`, { cookie });
    expect(pdfBefore.status).toBe(200);

    const after = await putClient(h, cookie, { hourlyRateCents: 12000, fundingSource: "QA Funding Beta", displayName: "Changed Laterperson" });
    expect(after.rateVersion).toBe(rec.rateVersion + 1);

    const b = await bundleOf(h, cookie, id);
    expect(b.billing.amountCents).toBe(13500);
    expect(b.billing.hourlyRateCents).toBe(9000);
    const inv = await getDoc(h, cookie, id, "invoice");
    const t = docText(inv);
    expect(t).toContain(dollars(13500));
    expect(t).not.toContain(dollars(18000));
    expect(t).not.toContain(dollars(12000));
    expect(t).toContain("QA Funding Alpha");
    expect(t).not.toContain("QA Funding Beta");
    expect(t).not.toContain("Changed Laterperson");
    expect(docText(inv.blocks)).toBe(docText(invBefore.blocks));
    const pdfAfter = await h.req(`/api/sessions/${id}/files/invoice`, { cookie });
    expect(pdfAfter.status).toBe(200);
    expect(pdfAfter.bytes.length).toBe(pdfBefore.bytes.length);
    // the files list (v2) still reports the frozen amount
    const files = await h.req("/api/files", { cookie });
    expect(files.json.data.items[0].amountCents).toBe(13500);
    // client stats bill the frozen amount
    expect((await getClient(h, cookie)).stats.billedCents).toBe(13500);
  });

  // -------------------------------------------------------------- documents
  it("V3-04 documents route: DocModel with DRAFT banner before approval; no DRAFT after (fixture banner only)", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const id = await sync(h, cookie);
    for (const kind of KINDS) {
      const m = await getDoc(h, cookie, id, kind);
      expect(m.kind).toBe(kind);
      expect(m.banner, `${kind} draft banner`).toMatch(/DRAFT/i);
      expect(Array.isArray(m.blocks) && m.blocks.length > 0).toBe(true);
      expect(m.templateId).toBe(`builtin:${kind}`);
      expect(m.theme).toMatchObject({ paper: expect.any(String), fontFamily: expect.any(String) });
      expect(typeof m.filename).toBe("string");
    }
    expect((await h.req(`/api/sessions/${id}/documents/not_a_kind`, { cookie })).status).toBe(400);
    expect((await h.req(`/api/sessions/sess_missing_000/documents/invoice`, { cookie })).status).toBe(404);

    await review(h, cookie, id, { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation });
    await approve(h, cookie, id);
    for (const kind of KINDS) {
      const m = await getDoc(h, cookie, id, kind);
      if (m.banner !== null) {
        expect(m.banner).not.toMatch(/DRAFT/i);
        expect(m.banner, "only the fixture banner is allowed after approval").toMatch(/FIXTURE|SYNTHETIC/i);
      }
      expect(m.footer.revisionLabel).toMatch(/2/);
    }
  });

  it("V3-05 participant direction edits → attestations → invoice + session-note DocModel", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const id = await sync(h, cookie);
    await review(h, cookie, id, {
      confirmedMinutes: 90,
      progressConfirmation: EXPECTED.demoProgressConfirmation,
      participantDirected: true,
      participantChoices: CHOICES,
    });
    const b = await bundleOf(h, cookie, id);
    const fields = (b.attestations as any[]).map((a) => a.field);
    expect(fields).toContain("participant_direction");
    expect(fields).toContain("participant_choices");
    const choice = (b.attestations as any[]).find((a) => a.field === "participant_choices");
    expect(choice.text).toBe(CHOICES);
    expect((b.attestations as any[]).find((a) => a.field === "participant_direction").text).toMatch(/^yes/i);

    for (const kind of ["invoice", "session_note"] as FileKind[]) {
      const draft = await getDoc(h, cookie, id, kind);
      expect(docText(draft), `${kind} draft lacks participant choices`).toContain(CHOICES);
      expect(draft.blocks.some((x: any) => x.type === "heading" && x.section === "participant_direction"), `${kind} has no participant_direction heading`).toBe(true);
    }
    // invalid edits rejected
    const bad = await h.req(`/api/sessions/${id}/review`, { method: "PATCH", cookie, body: { expectedRevision: 2, edits: { participantDirected: "yes" } } });
    expect(bad.status).toBe(400);

    await approve(h, cookie, id);
    for (const kind of ["invoice", "session_note"] as FileKind[]) {
      const m = await getDoc(h, cookie, id, kind);
      expect(docText(m), `${kind} final lacks participant choices`).toContain(CHOICES);
    }
  });

  // -------------------------------------------------------------- templates
  it("V3-06 template CRUD, builtins read-only, default per kind, validation, cross-origin", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const l0 = await h.req("/api/templates", { cookie });
    expect(l0.status, l0.text).toBe(200);
    const ids0 = (l0.json.data as any[]).map((t) => t.id);
    for (const k of KINDS) expect(ids0).toContain(`builtin:${k}`);
    for (const t of l0.json.data as any[]) if (t.builtin) expect(t.isDefault, `${t.id} should be default initially`).toBe(true);

    const tpl = await createTemplate(h, cookie, template("invoice", { text: { title: "QA Custom Invoice" } }));
    expect(tpl.builtin).toBe(false);
    // missing keys appended (disabled) → normalized full set
    expect(tpl.sections.map((s: any) => s.key).sort()).toEqual(
      ["bill_to", "funding_authorization", "service_lines", "totals", "participant_direction", "custom_fields", "notes", "signatures", "approval_reference"].sort(),
    );
    const byKind = await h.req("/api/templates?kind=invoice", { cookie });
    const ik = (byKind.json.data as any[]);
    expect(ik.every((t) => t.kind === "invoice")).toBe(true);
    expect(ik.map((t) => t.id)).toEqual(expect.arrayContaining(["builtin:invoice", tpl.id]));

    const upd = await h.req(`/api/templates/${tpl.id}`, { method: "PUT", cookie, body: template("invoice", { name: "QA renamed", text: { title: "QA Custom Invoice 2" } }) });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.json.data.name).toBe("QA renamed");

    // builtins read-only
    expect((await h.req(`/api/templates/${encodeURIComponent("builtin:invoice")}`, { method: "PUT", cookie, body: template("invoice") })).status).toBe(409);
    expect((await h.req(`/api/templates/${encodeURIComponent("builtin:invoice")}`, { method: "DELETE", cookie })).status).toBe(409);
    // validation
    expect((await h.req("/api/templates", { method: "POST", cookie, body: template("invoice", { theme: { accentColor: "red" } }) })).status).toBe(400);
    expect((await h.req("/api/templates", { method: "POST", cookie, body: template("invoice"), origin: "https://evil.example" })).status).toBe(403);

    // default per kind
    const d = await h.req("/api/templates/default/invoice", { method: "PUT", cookie, body: { templateId: tpl.id } });
    expect(d.status, d.text).toBe(200);
    expect(d.json.data).toEqual({ kind: "invoice", templateId: tpl.id });
    const l1 = (await h.req("/api/templates?kind=invoice", { cookie })).json.data as any[];
    expect(l1.find((t) => t.id === tpl.id).isDefault).toBe(true);
    expect(l1.find((t) => t.id === "builtin:invoice").isDefault).toBe(false);
    // other kinds still builtin default
    const sn = (await h.req("/api/templates?kind=session_note", { cookie })).json.data as any[];
    expect(sn.find((t) => t.id === "builtin:session_note").isDefault).toBe(true);
    // wrong-kind default rejected
    const wk = await h.req("/api/templates/default/session_note", { method: "PUT", cookie, body: { templateId: tpl.id } });
    expect([400, 404, 409]).toContain(wk.status);

    // the default is used by the documents route
    const id = await sync(h, cookie);
    const m = await getDoc(h, cookie, id, "invoice");
    expect(m.templateId).toBe(tpl.id);
    expect(m.title).toBe("QA Custom Invoice 2");
    // explicit templateId override
    expect((await getDoc(h, cookie, id, "invoice", "builtin:invoice")).templateId).toBe("builtin:invoice");

    // reset default → builtin
    const r = await h.req("/api/templates/default/invoice", { method: "PUT", cookie, body: { templateId: null } });
    expect(r.status).toBe(200);
    expect((await getDoc(h, cookie, id, "invoice")).templateId).toBe("builtin:invoice");

    const del = await h.req(`/api/templates/${tpl.id}`, { method: "DELETE", cookie });
    expect(del.status, del.text).toBe(200);
    expect(del.json.data).toEqual({ deleted: true });
    expect(((await h.req("/api/templates", { cookie })).json.data as any[]).map((t) => t.id)).not.toContain(tpl.id);
    expect((await h.req(`/api/templates/${tpl.id}`, { method: "DELETE", cookie })).status).toBe(404);
  });

  it("V3-06b template with a section key not in SECTION_KEYS[kind] is rejected (contract: every key must be in SECTION_KEYS)", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const badKey = template("invoice") as any;
    badKey.sections = [{ key: "overview", enabled: true }];
    const r = await h.req("/api/templates", { method: "POST", cookie, body: badKey });
    expect(r.status, `accepted unknown section key: ${r.text.slice(0, 300)}`).toBe(400);
  });

  it("V3-07 client-specific invoice template (a4) is used by the documents + PDF routes", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const tpl = await createTemplate(h, cookie, template("invoice", { theme: { paper: "a4" }, text: { title: "QA Client Invoice" } }));
    await putClient(h, cookie, { templates: { session_note: null, invoice: tpl.id, approval_record: null } });
    const id = await sync(h, cookie);
    await review(h, cookie, id, { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation });
    await approve(h, cookie, id);

    const m = await getDoc(h, cookie, id, "invoice");
    expect(m.templateId).toBe(tpl.id);
    expect(m.title).toBe("QA Client Invoice");
    expect(m.theme.paper).toBe("a4");

    const inv = await h.req(`/api/sessions/${id}/files/invoice`, { cookie });
    expect(inv.status, inv.text.slice(0, 200)).toBe(200);
    expect(inv.headers.get("content-type")).toMatch(/^application\/pdf/);
    const a4 = await pdfPageSize(inv.bytes);
    expect([a4.w, a4.h]).toEqual([595, 842]);
    // session note has no client template → builtin letter
    const sn = await h.req(`/api/sessions/${id}/files/session_note`, { cookie });
    expect(sn.status).toBe(200);
    const letter = await pdfPageSize(sn.bytes);
    expect([letter.w, letter.h]).toEqual([612, 792]);
    // client template wins over provider default
    const other = await createTemplate(h, cookie, template("invoice", { text: { title: "QA Provider Default" } }));
    await h.req("/api/templates/default/invoice", { method: "PUT", cookie, body: { templateId: other.id } });
    expect((await getDoc(h, cookie, id, "invoice")).templateId).toBe(tpl.id);
  });

  it("V3-08 preview: synthetic sample and real session; invalid template rejected", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const t = template("invoice", { text: { title: "QA Preview Title" }, theme: { fontFamily: "serif" } });
    const p1 = await h.req("/api/templates/preview", { method: "POST", cookie, body: { template: t } });
    expect(p1.status, p1.text).toBe(200);
    expect(p1.json.data.kind).toBe("invoice");
    expect(p1.json.data.title).toBe("QA Preview Title");
    expect(p1.json.data.theme.fontFamily).toBe("serif");
    expect(p1.json.data.blocks.length).toBeGreaterThan(0);
    // the built-in synthetic sample is fixture data → fixture banner
    expect(p1.json.data.banner).toMatch(/FIXTURE|SYNTHETIC/i);

    await putClient(h, cookie, { hourlyRateCents: 9000 });
    const id = await sync(h, cookie);
    const p2 = await h.req("/api/templates/preview", { method: "POST", cookie, body: { template: t, sessionId: id } });
    expect(p2.status, p2.text).toBe(200);
    expect(p2.json.data.title).toBe("QA Preview Title");
    expect(docText(p2.json.data)).toContain("C-104");
    expect(p2.json.data.banner).toMatch(/DRAFT/i);
    // preview does not persist a template
    expect(((await h.req("/api/templates", { cookie })).json.data as any[]).filter((x) => !x.builtin)).toEqual([]);
    expect((await h.req("/api/templates/preview", { method: "POST", cookie, body: { template: { ...t, kind: "receipt" } } })).status).toBe(400);
    expect((await h.req("/api/templates/preview", { method: "POST", cookie, body: { template: t, sessionId: "sess_missing_000" } })).status).toBe(404);
  });

  it("V3-09 renderDocModelPdf: valid PDF bytes for themed templates (a4 / serif / compact / mono) and every kind", async () => {
    h = await newHarness();
    const docs = h.v3.documents;
    const themes: [Record<string, unknown>, [number, number]][] = [
      [{ paper: "a4", fontFamily: "serif", density: "compact" }, [595, 842]],
      [{ paper: "letter", fontFamily: "mono", density: "comfortable" }, [612, 792]],
      [{ paper: "a4", fontFamily: "sans", density: "compact", headerNote: "Header ünïcödé — “quotes”", footerNote: "Footer €" }, [595, 842]],
    ];
    for (const kind of KINDS) {
      const builtin = docs.BUILTIN_TEMPLATES[kind];
      expect(builtin.id).toBe(`builtin:${kind}`);
      for (const [theme, size] of themes) {
        const tpl = { ...builtin, id: "tpl_qa", builtin: false, theme: { ...builtin.theme, ...theme } };
        const model = docs.buildDocModel(kind, docs.sampleDocModelInput(tpl));
        expect(model.theme.paper).toBe(theme.paper);
        const bytes: Uint8Array = await docs.renderDocModelPdf(model);
        const s = await pdfPageSize(bytes);
        expect([s.w, s.h], `${kind} ${JSON.stringify(theme)}`).toEqual(size);
        expect(s.pages).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // -------------------------------------------------------------- run history
  it("V3-10 run history (normal): ordered stages discovered…completed; listed succeeded; no PII in events", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    await putClient(h, cookie, { displayName: PLANTED_NAME, preferredName: PLANTED_PREFERRED });
    const id = await sync(h, cookie);
    const runId = workflowInstanceId(id, 1);
    const mid = await h.req(`/api/runs/${encodeURIComponent(runId)}`, { cookie });
    expect(mid.status, mid.text).toBe(200);
    expect(mid.json.data.summary.status).toBe("waiting");
    expect(mid.json.data.summary.currentStage).toBe("approval_wait");

    await review(h, cookie, id, {
      confirmedMinutes: 90,
      progressConfirmation: EXPECTED.demoProgressConfirmation,
      participantDirected: true,
      participantChoices: CHOICES,
    });
    await approve(h, cookie, id);

    const list = await h.req("/api/runs", { cookie });
    expect(list.status, list.text).toBe(200);
    const run = (list.json.data.runs as any[]).find((r) => r.runId === runId);
    expect(run, `run ${runId} not listed: ${list.text.slice(0, 400)}`).toBeTruthy();
    expect(run).toMatchObject({ runKind: "processing", sessionId: id, clientRef: "C-104", status: "succeeded", currentStage: "completed" });
    expect(run.endedAt).not.toBeNull();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    const det = await h.req(`/api/runs/${encodeURIComponent(runId)}`, { cookie });
    const stages = (det.json.data.events as any[]).map((e) => e.stage);
    expectOrdered(stages, ["discovered", "queued", "workflow_started", "load", "evidence", "match", "extraction", "assemble", "draft_saved", "approval_wait", "approved", "completed"]);
    for (const s of ["review_saved", "client_snapshot", "finalize"]) expect(stages, `missing stage ${s}`).toContain(s);
    expect(stages.at(-1)).toBe("completed");
    expect(run.eventCount).toBe(det.json.data.events.length);
    // deterministic ids → no duplicates
    const ids = (det.json.data.events as any[]).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // filters
    expect(((await h.req("/api/runs?status=failed", { cookie })).json.data.runs as any[])).toEqual([]);
    expect(((await h.req(`/api/runs?sessionId=${encodeURIComponent(id)}`, { cookie })).json.data.runs as any[]).length).toBeGreaterThanOrEqual(1);
    expect((await h.req("/api/runs/does-not-exist", { cookie })).status).toBe(404);

    const { events } = await allRunEvents(h, cookie);
    assertEventsClean(events);
    // recorder never put names in logs either
    for (const line of logs) for (const v of [PLANTED_NAME, PLANTED_PREFERRED]) expect(line.includes(v), `log leaked ${v}`).toBe(false);
    // interfaces-v3.md: workflow emits a "files" stage between finalize and completed
    expectOrdered(stages, ["finalize", "files", "completed"]);
  });

  it("V3-11 run history (live mode, fake OpenAI): run lists succeeded with aiProvider/model; client name not sent to AI", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    await putClient(h, cookie, { displayName: PLANTED_NAME, preferredName: PLANTED_PREFERRED });
    h.env.EXTRACTION_MODE = "live";
    const put = await h.req("/api/settings/ai", {
      method: "PUT",
      cookie,
      body: { provider: "openai", model: "gpt-4.1", privacy: { redactNames: true, redactContact: true, redactIdentifiers: true, redactAddresses: true, redactDates: true } },
    });
    expect(put.status, put.text).toBe(200);
    h.cloud.ai = () => structuredClone(demoFacts) as SessionFacts;
    const id = await sync(h, cookie);
    const calls = h.cloud.to(/api\.openai\.com/);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) for (const v of [PLANTED_NAME, PLANTED_PREFERRED]) expect(c.body.includes(v), `client name sent to AI`).toBe(false);
    await review(h, cookie, id, { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation });
    await approve(h, cookie, id);
    const runs = (await h.req("/api/runs", { cookie })).json.data.runs as any[];
    const run = runs.find((r) => r.runId === workflowInstanceId(id, 1));
    expect(run, JSON.stringify(runs)).toBeTruthy();
    expect(run).toMatchObject({ status: "succeeded", aiProvider: "openai", model: "gpt-4.1" });
    const { events } = await allRunEvents(h, cookie);
    if (process.env.QA_DEBUG) process.stderr.write(`LIVE STAGES ${events.map((e) => `${e.stage}:${e.status}:${e.label}`).join(" | ")}\n`);
    const ex = events.find((e) => e.stage === "extraction" && e.status === "succeeded");
    expect(ex, "no succeeded extraction event").toBeTruthy();
    assertEventsClean(events);
  });

  it("V3-12 run history (failure variant upstream-error): run listed failed with a reason", async () => {
    h = await newHarness("upstream-error");
    await h.mods.seed.seedDemoData(h.repo, { variant: "upstream-error" });
    const cookie = await h.login();
    const id = await sync(h, cookie);
    const d = await h.req(`/api/sessions/${id}`, { cookie });
    expect(d.json.data.session.status).toBe("FAILED");
    const failed = (await h.req("/api/runs?status=failed", { cookie })).json.data.runs as any[];
    const run = failed.find((r) => r.sessionId === id);
    expect(run, "failed run not listed").toBeTruthy();
    expect(run.status).toBe("failed");
    expect(run.currentStage).toBe("failed");
    expect(run.endedAt).not.toBeNull();
    const det = await h.req(`/api/runs/${encodeURIComponent(run.runId)}`, { cookie });
    const fe = (det.json.data.events as any[]).find((e) => e.stage === "failed" || e.status === "failed");
    expect(fe).toBeTruthy();
    const reason = fe.detail ?? fe.meta?.reason ?? fe.meta?.reasonCode ?? null;
    expect(reason, `failed event has no reason: ${JSON.stringify(fe)}`).toBeTruthy();
    assertEventsClean(det.json.data.events);
  });

  it("V3-13 delivery runs appear after a drive upload (delivery:<id>, delivery_drive)", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const id = await sync(h, cookie);
    await review(h, cookie, id, { confirmedMinutes: 90, progressConfirmation: EXPECTED.demoProgressConfirmation });
    await approve(h, cookie, id);
    await seedGoogle(h, cookie);
    const dr = await h.req(`/api/sessions/${id}/deliveries/drive`, { method: "POST", cookie, body: {} });
    expect([200, 201], dr.text).toContain(dr.status);
    expect(dr.json.data.status).toBe("done");
    const deliveryId = dr.json.data.id ?? dr.json.data.deliveryId;
    const runs = (await h.req("/api/runs", { cookie })).json.data.runs as any[];
    const del = runs.filter((r) => r.runKind === "delivery");
    expect(del.length, JSON.stringify(runs)).toBeGreaterThanOrEqual(1);
    if (deliveryId) expect(del.map((r) => r.runId)).toContain(`delivery:${deliveryId}`);
    expect(del[0].runId).toMatch(/^delivery:/);
    expect(del[0].sessionId).toBe(id);
    expect(del[0].status).toBe("succeeded");
    const det = await h.req(`/api/runs/${encodeURIComponent(del[0].runId)}`, { cookie });
    expect((det.json.data.events as any[]).map((e) => e.stage)).toContain("delivery_drive");
    const { events } = await allRunEvents(h, cookie);
    assertEventsClean(events, ["provider.google@example.invalid"]);
  });

  // -------------------------------------------------------------- isolation
  it("V3-14 other provider cannot see clients / templates / documents / runs (404 / empty)", async () => {
    h = await newHarness();
    const cookie = await seedLogin(h);
    const tpl = await createTemplate(h, cookie, template("invoice"));
    const id = await sync(h, cookie);
    const runId = workflowInstanceId(id, 1);
    const other = await h.login(OTHER_PROVIDER_IDENTITY);

    const cl = await h.req("/api/clients", { cookie: other });
    expect(cl.status).toBe(200);
    expect((cl.json.data as any[]).map((s) => s.client.clientRef)).not.toContain("C-104");
    expect((await h.req("/api/clients/C-104", { cookie: other })).status).toBe(404);

    const tl = await h.req("/api/templates", { cookie: other });
    expect(tl.status).toBe(200);
    expect((tl.json.data as any[]).filter((t) => !t.builtin)).toEqual([]);
    expect((await h.req(`/api/templates/${tpl.id}`, { method: "PUT", cookie: other, body: template("invoice") })).status).toBe(404);
    expect((await h.req(`/api/templates/${tpl.id}`, { method: "DELETE", cookie: other })).status).toBe(404);
    const od = await h.req("/api/templates/default/invoice", { method: "PUT", cookie: other, body: { templateId: tpl.id } });
    expect([400, 404]).toContain(od.status);
    const mine = (await getClient(h, cookie)).client;

    expect((await h.req(`/api/sessions/${id}/documents/invoice`, { cookie: other })).status).toBe(404);
    const pv = await h.req("/api/templates/preview", { method: "POST", cookie: other, body: { template: template("invoice"), sessionId: id } });
    expect(pv.status).toBe(404);

    const rl = await h.req("/api/runs", { cookie: other });
    expect(rl.status).toBe(200);
    expect(rl.json.data.runs).toEqual([]);
    expect((await h.req(`/api/runs/${encodeURIComponent(runId)}`, { cookie: other })).status).toBe(404);
    expect(((await h.req(`/api/runs?sessionId=${encodeURIComponent(id)}`, { cookie: other })).json.data.runs as any[])).toEqual([]);

    // unauthenticated
    for (const p of ["/api/clients", "/api/templates", "/api/runs"]) expect((await h.req(p)).status).toBe(401);
    expect((await getClient(h, cookie)).client).toEqual(mine);
  });
});
