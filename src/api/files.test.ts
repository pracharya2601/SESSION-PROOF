import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiDeps, AppBindings } from "./deps";
import { clientInput, DeliveryFakeRepo, makeDeliveryDeps, NOW, OTHER_PROVIDER, PROVIDER, SESSION } from "../services/delivery/testkit";
import { BUILTIN_TEMPLATES } from "../documents/index";

const m = vi.hoisted(() => {
  class ConnectionError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class CloudApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly retryable: boolean) {
      super(message);
    }
  }
  return {
    ConnectionError,
    CloudApiError,
    getValidAccessToken: vi.fn(async () => "tok"),
    buildDocModel: vi.fn((kind: string, input: { bundle: { bundleRevision: number }; template: { id: string } }) => ({
      kind,
      templateId: input.template.id,
      filename: `client-A_${kind}_r${input.bundle.bundleRevision}.pdf`,
    })),
    renderDocModelPdf: vi.fn(async (model: { kind: string }) => new TextEncoder().encode(`%PDF-${model.kind}`)),
    ensureFolder: vi.fn(async (_path: string) => ({ folderId: "fold-1", webUrl: "https://drive.example/fold-1" })),
    uploadFile: vi.fn(async (_f: string, name: string, _b: Uint8Array, _ct: string) => ({ fileId: `f-${name}`, webUrl: null })),
    createDraft: vi.fn(async (_d: unknown) => ({ draftId: "draft-1", webUrl: "https://mail.example/draft-1" })),
    sendDraft: vi.fn(),
  };
});

vi.mock("../connections/index", () => ({ ConnectionError: m.ConnectionError, getValidAccessToken: m.getValidAccessToken }));
vi.mock("../artifacts/index", () => ({
  sessionFiles: (sessionId: string, final: { bundleRevision: number }) =>
    ["session_note", "invoice", "approval_record"].map((kind) => ({
      kind,
      label: kind,
      filename: `client-A_${kind}_r${final.bundleRevision}.pdf`,
      contentType: "application/pdf",
      downloadUrl: `/api/sessions/${sessionId}/files/${kind}`,
    })),
}));
vi.mock("../documents/index", async (orig) => ({
  ...((await orig()) as object),
  buildDocModel: m.buildDocModel,
  renderDocModelPdf: m.renderDocModelPdf,
}));
vi.mock("../integrations/cloud/index", () => ({
  CloudApiError: m.CloudApiError,
  storageAdapterFor: () => ({ ensureFolder: m.ensureFolder, uploadFile: m.uploadFile }),
  mailAdapterFor: () => ({ createDraft: m.createDraft, send: m.sendDraft, sendDraft: m.sendDraft }),
}));

import { filesRoutes } from "./files";

function appFor(repo = new DeliveryFakeRepo(), providerId = PROVIDER) {
  const { deps } = makeDeliveryDeps(repo);
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-1");
    c.set("actor", { providerId, identity: "p@example.test" });
    await next();
  });
  app.route("/", filesRoutes(deps as unknown as ApiDeps));
  return { app, repo };
}

const send = (app: Hono<AppBindings>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

beforeEach(() => vi.clearAllMocks());

describe("files routes", () => {
  it("GET /api/files lists completed sessions with files + deliveries", async () => {
    const { app, repo } = appFor();
    await repo.createFileDelivery({
      id: "fd_1", sessionId: SESSION, bundleRevision: 2, target: "drive", provider: "google", files: ["invoice"], status: "done",
      externalId: "f", webUrl: null, recipients: [], error: null, createdAt: "2026-11-13T15:00:00.000Z", updatedAt: "2026-11-13T15:00:00.000Z",
    });
    const r = await app.request("/api/files");
    expect(r.status).toBe(200);
    const { ListFilesResponse } = await import("../contracts");
    const body = ListFilesResponse.parse(((await r.json()) as { data: unknown }).data);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ sessionId: SESSION, clientRef: "client-A", bundleRevision: 2, amountCents: 11250, confirmedMinutes: 90, evidenceMode: "fixture" });
    expect(body.items[0]?.files.map((f) => f.kind)).toEqual(["session_note", "invoice", "approval_record"]);
    expect(body.items[0]?.deliveries).toHaveLength(1);
    const other = await appFor(repo, OTHER_PROVIDER).app.request("/api/files");
    expect((((await other.json()) as { data: { items: unknown[] } }).data.items)).toHaveLength(0);
  });

  it("downloads PDF bytes with safe headers; inline=1 switches disposition", async () => {
    const { app } = appFor();
    const r = await app.request(`/api/sessions/${SESSION}/files/invoice`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="client-A_invoice_r2.pdf"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("%PDF-invoice");
    expect(m.buildDocModel).toHaveBeenCalledWith("invoice", expect.objectContaining({ providerIdentity: "p@example.test" }));
    const inl = await app.request(`/api/sessions/${SESSION}/files/session_note?inline=1`);
    expect(inl.headers.get("content-disposition")).toMatch(/^inline; filename=/);
  });

  it("bad kind 400; wrong provider 404; not completed 409", async () => {
    const { app } = appFor();
    const bad = await app.request(`/api/sessions/${SESSION}/files/evil`);
    expect(bad.status).toBe(400);
    expect(await errCode(bad)).toBe("INVALID_REQUEST");
    const wrong = await appFor(new DeliveryFakeRepo(), OTHER_PROVIDER).app.request(`/api/sessions/${SESSION}/files/invoice`);
    expect(wrong.status).toBe(404);
    const nf = await appFor(new DeliveryFakeRepo({ completed: false })).app.request(`/api/sessions/${SESSION}/files/invoice`);
    expect(nf.status).toBe(409);
    expect(await errCode(nf)).toBe("NOT_FINALIZED");
  });

  it("PDF uses the client's invoice template + frozen snapshot; filename from the DocModel", async () => {
    const repo = new DeliveryFakeRepo();
    const b = BUILTIN_TEMPLATES.invoice;
    const t = await repo.createTemplate(PROVIDER, "tpl_inv", { kind: "invoice", name: "Inv", theme: b.theme, sections: b.sections, text: b.text }, NOW);
    const foreign = await repo.createTemplate(OTHER_PROVIDER, "tpl_foreign", { kind: "invoice", name: "F", theme: b.theme, sections: b.sections, text: b.text }, NOW);
    const client = await repo.upsertClient(PROVIDER, clientInput({ templates: { session_note: foreign.id, invoice: t.id, approval_record: null } }), NOW);
    const { notes: _n, templates: _t, ...rest } = client;
    await repo.saveClientSnapshot(SESSION, 2, { ...rest, effectiveHourlyRateCents: 8000, capturedAt: NOW.toISOString() });
    const { app } = appFor(repo);
    const r = await app.request(`/api/sessions/${SESSION}/files/invoice`);
    expect(r.status).toBe(200);
    expect(m.buildDocModel).toHaveBeenLastCalledWith(
      "invoice",
      expect.objectContaining({ template: expect.objectContaining({ id: "tpl_inv" }), client: expect.objectContaining({ effectiveHourlyRateCents: 8000 }) }),
    );
    expect(m.renderDocModelPdf).toHaveBeenLastCalledWith(expect.objectContaining({ templateId: "tpl_inv", filename: "client-A_invoice_r2.pdf" }));
    // foreign template id on the client → builtin
    await app.request(`/api/sessions/${SESSION}/files/session_note`);
    expect(m.buildDocModel).toHaveBeenLastCalledWith("session_note", expect.objectContaining({ template: expect.objectContaining({ id: "builtin:session_note" }) }));
  });
});
