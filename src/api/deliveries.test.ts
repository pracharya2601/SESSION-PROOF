import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiDeps, AppBindings } from "./deps";
import { DeliveryFakeRepo, makeDeliveryDeps, OTHER_PROVIDER, PROVIDER, SESSION } from "../services/delivery/testkit";

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

import { deliveryRoutes } from "./deliveries";

function appFor(repo = new DeliveryFakeRepo(), providerId = PROVIDER) {
  const { deps } = makeDeliveryDeps(repo);
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-1");
    c.set("actor", { providerId, identity: "p@example.test" });
    await next();
  });
  app.route("/", deliveryRoutes(deps as unknown as ApiDeps));
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

describe("delivery routes", () => {
  it("POST drive → 201 FileDelivery; GET lists it", async () => {
    const { app } = appFor();
    const r = await send(app, "POST", `/api/sessions/${SESSION}/deliveries/drive`, { provider: "google" });
    expect(r.status).toBe(201);
    const d = ((await r.json()) as { data: { status: string; webUrl: string } }).data;
    expect(d).toMatchObject({ status: "done", webUrl: "https://drive.example/fold-1" });
    const list = await app.request(`/api/sessions/${SESSION}/deliveries`);
    expect((((await list.json()) as { data: unknown[] }).data)).toHaveLength(1);
  });

  it("invalid bodies → 400", async () => {
    const { app } = appFor();
    for (const [path, body] of [
      ["drive", { provider: "dropbox" }],
      ["drive", { files: [] }],
      ["drive", { extra: 1 }],
      ["drive", "{bad"],
      ["email-draft", {}],
      ["email-draft", { to: ["not-an-email"] }],
      ["email-draft", { to: ["a@example.test"], bcc: ["x@example.test"] }],
    ] as const) {
      const r = await send(app, "POST", `/api/sessions/${SESSION}/deliveries/${path}`, body);
      expect(r.status).toBe(400);
      expect(await errCode(r)).toBe("INVALID_REQUEST");
    }
  });

  it("maps service errors: 404 wrong provider, 409 not finalized, 422 no provider, 409 connection, 502 cloud", async () => {
    const wrong = await send(appFor(new DeliveryFakeRepo(), OTHER_PROVIDER).app, "GET", `/api/sessions/${SESSION}/deliveries`);
    expect(wrong.status).toBe(404);
    const nf = await send(appFor(new DeliveryFakeRepo({ completed: false })).app, "POST", `/api/sessions/${SESSION}/deliveries/drive`, {});
    expect(await errCode(nf)).toBe("NOT_FINALIZED");
    const { app } = appFor();
    const np = await send(app, "POST", `/api/sessions/${SESSION}/deliveries/email-draft`, { to: ["a@example.test"] });
    expect(np.status).toBe(422);
    expect(await errCode(np)).toBe("NO_EMAIL_PROVIDER");
    m.getValidAccessToken.mockRejectedValueOnce(new m.ConnectionError("not_configured"));
    const nc = await send(app, "POST", `/api/sessions/${SESSION}/deliveries/drive`, { provider: "microsoft" });
    expect(nc.status).toBe(409);
    expect(await errCode(nc)).toBe("CONNECTION_REQUIRED");
    m.createDraft.mockRejectedValueOnce(new m.CloudApiError(500, "server", "x", true));
    const pe = await send(app, "POST", `/api/sessions/${SESSION}/deliveries/email-draft`, { provider: "google", to: ["a@example.test"] });
    expect(pe.status).toBe(502);
    const j = (await pe.json()) as { error: { code: string; retryable: boolean } };
    expect(j.error).toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
  });

  it("email draft never sends", async () => {
    const { app } = appFor();
    const r = await send(app, "POST", `/api/sessions/${SESSION}/deliveries/email-draft`, { provider: "google", to: ["a@example.test"] });
    expect(r.status).toBe(201);
    expect(m.createDraft).toHaveBeenCalledTimes(1);
    expect(m.sendDraft).not.toHaveBeenCalled();
  });
});
