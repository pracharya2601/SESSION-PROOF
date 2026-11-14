import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../api/deps";
import { ServiceError } from "../approval/index";
import { BUILTIN_TEMPLATES } from "../../documents/index";
import { clientInput, DeliveryFakeRepo, makeDeliveryDeps, NOW, OTHER_PROVIDER, PROVIDER, SESSION } from "./testkit";

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

vi.mock("../../connections/index", () => ({ ConnectionError: m.ConnectionError, getValidAccessToken: m.getValidAccessToken }));
vi.mock("../../artifacts/index", () => ({
  sessionFiles: () => [],
}));
vi.mock("../../documents/index", async (orig) => ({
  ...((await orig()) as object),
  buildDocModel: m.buildDocModel,
  renderDocModelPdf: m.renderDocModelPdf,
}));
vi.mock("../../integrations/cloud/index", () => ({
  CloudApiError: m.CloudApiError,
  storageAdapterFor: () => ({ ensureFolder: m.ensureFolder, uploadFile: m.uploadFile }),
  mailAdapterFor: () => ({ createDraft: m.createDraft, send: m.sendDraft, sendDraft: m.sendDraft }),
}));

import { createEmailDraft, onSessionCompleted, processFileDelivery, renderTemplate, uploadToDrive } from "./index";

const actor: Actor = { providerId: PROVIDER, identity: "p@example.test" };

async function expectServiceError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).status).toBe(status);
  expect((err as ServiceError).code).toBe(code);
  return err as ServiceError;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renderTemplate", () => {
  it("replaces known placeholders, leaves unknown ones, strips CR/LF from values", () => {
    expect(renderTemplate("{clientRef} {serviceDate} {foo} {revision}", { clientRef: "C\r\n-1", serviceDate: "2026-11-13", revision: "2" })).toBe(
      "C -1 2026-11-13 {foo} 2",
    );
  });
});

describe("uploadToDrive", () => {
  it("not completed → 409 NOT_FINALIZED", async () => {
    const { deps } = makeDeliveryDeps(new DeliveryFakeRepo({ completed: false }));
    await expectServiceError(uploadToDrive(deps, actor, SESSION, { provider: "google" }), 409, "NOT_FINALIZED");
  });

  it("wrong provider → 404", async () => {
    const { deps } = makeDeliveryDeps();
    await expectServiceError(uploadToDrive(deps, { providerId: OTHER_PROVIDER, identity: "x" }, SESSION, { provider: "google" }), 404, "NOT_FOUND");
  });

  it("no provider → 422 NO_STORAGE_PROVIDER", async () => {
    const { deps } = makeDeliveryDeps();
    await expectServiceError(uploadToDrive(deps, actor, SESSION, {}), 422, "NO_STORAGE_PROVIDER");
  });

  it("not connected → 409 CONNECTION_REQUIRED, no delivery recorded", async () => {
    const { deps, repo } = makeDeliveryDeps();
    m.getValidAccessToken.mockRejectedValueOnce(new m.ConnectionError("not_connected"));
    const err = await expectServiceError(uploadToDrive(deps, actor, SESSION, { provider: "google" }), 409, "CONNECTION_REQUIRED");
    expect(err.message).toContain("not_connected");
    expect(repo.fileDeliveries.size).toBe(0);
  });

  it("success records done with folder url, uses rendered folder path and settings provider", async () => {
    const { deps, repo } = makeDeliveryDeps();
    repo.storage.set(PROVIDER, { provider: "microsoft", folderPath: "Docs/{clientRef}/{serviceDate}/r{revision}", autoUploadOnComplete: false });
    const d = await uploadToDrive(deps, actor, SESSION, { files: ["invoice", "session_note"] });
    expect(d).toMatchObject({ status: "done", externalId: "fold-1", webUrl: "https://drive.example/fold-1", provider: "microsoft", target: "drive" });
    expect(d.files).toEqual(["session_note", "invoice"]);
    expect(m.ensureFolder).toHaveBeenCalledWith("Docs/client-A/2026-11-13/r2");
    expect(m.uploadFile).toHaveBeenCalledTimes(2);
    expect(m.uploadFile.mock.calls[0]?.[3]).toBe("application/pdf");
    expect(m.getValidAccessToken).toHaveBeenCalledWith(deps, PROVIDER, "microsoft");
    expect(repo.fileDeliveries.get(d.id)?.status).toBe("done");
  });

  it("cloud failure → failed delivery + 502 PROVIDER_ERROR with retryable flag", async () => {
    const { deps, repo } = makeDeliveryDeps();
    m.uploadFile.mockRejectedValueOnce(new m.CloudApiError(503, "unavailable", "secret upstream detail token=abc", true));
    const err = await expectServiceError(uploadToDrive(deps, actor, SESSION, { provider: "google" }), 502, "PROVIDER_ERROR");
    expect(err.retryable).toBe(true);
    const [stored] = [...repo.fileDeliveries.values()];
    expect(stored?.status).toBe("failed");
    expect(stored?.error).not.toContain("token=abc");
  });
});

describe("v3 templates in deliveries", () => {
  it("drive upload renders each kind with the client's template (fallback builtin)", async () => {
    const { deps, repo } = makeDeliveryDeps();
    const b = BUILTIN_TEMPLATES.invoice;
    await repo.createTemplate(PROVIDER, "tpl_inv", { kind: "invoice", name: "Inv", theme: b.theme, sections: b.sections, text: b.text }, NOW);
    await repo.upsertClient(PROVIDER, clientInput({ templates: { session_note: null, invoice: "tpl_inv", approval_record: null } }), NOW);
    await uploadToDrive(deps, actor, SESSION, { provider: "google" });
    const used = m.buildDocModel.mock.calls.map(([kind, input]) => [kind, input.template.id]);
    expect(used).toEqual([
      ["session_note", "builtin:session_note"],
      ["invoice", "tpl_inv"],
      ["approval_record", "builtin:approval_record"],
    ]);
    expect(m.uploadFile.mock.calls.map((c) => c[1])).toEqual([
      "client-A_session_note_r2.pdf",
      "client-A_invoice_r2.pdf",
      "client-A_approval_record_r2.pdf",
    ]);
  });
});

describe("createEmailDraft", () => {
  it("uses templates, defaults and recipients; never sends", async () => {
    const { deps, repo } = makeDeliveryDeps();
    repo.email.set(PROVIDER, {
      provider: "google",
      defaultTo: [],
      defaultCc: ["cc@example.test"],
      subjectTemplate: "Notes {clientRef} {serviceDate} {amount}",
      bodyTemplate: "Rev {revision} by {providerIdentity} {unknown}",
      attach: [],
    });
    const d = await createEmailDraft(deps, actor, SESSION, { to: ["to@example.test"] });
    expect(d).toMatchObject({ target: "email_draft", status: "done", externalId: "draft-1", webUrl: "https://mail.example/draft-1" });
    expect(d.recipients).toEqual(["to@example.test", "cc@example.test"]);
    expect(d.files).toEqual(["session_note", "invoice", "approval_record"]);
    const arg = m.createDraft.mock.calls[0]?.[0] as { subject: string; bodyText: string; cc: string[]; attachments: { filename: string }[] };
    expect(arg.subject).toBe("Notes client-A 2026-11-13 $112.50");
    expect(arg.bodyText).toBe("Rev 2 by p@example.test {unknown}");
    expect(arg.cc).toEqual(["cc@example.test"]);
    expect(arg.attachments.map((a) => a.filename)).toEqual([
      "client-A_session_note_r2.pdf",
      "client-A_invoice_r2.pdf",
      "client-A_approval_record_r2.pdf",
    ]);
    expect(m.sendDraft).not.toHaveBeenCalled();
  });

  it("strips CR/LF from subject (header injection)", async () => {
    const { deps } = makeDeliveryDeps();
    await createEmailDraft(deps, actor, SESSION, { provider: "google", to: ["to@example.test"], subject: "Hi\r\nBcc: evil@example.test", files: ["invoice"] });
    const arg = m.createDraft.mock.calls[0]?.[0] as { subject: string; attachments: unknown[] };
    expect(arg.subject).not.toMatch(/[\r\n]/);
    expect(arg.attachments).toHaveLength(1);
  });

  it("no provider → 422; not connected → 409", async () => {
    const { deps } = makeDeliveryDeps();
    await expectServiceError(createEmailDraft(deps, actor, SESSION, { to: ["a@example.test"] }), 422, "NO_EMAIL_PROVIDER");
    m.getValidAccessToken.mockRejectedValueOnce(new m.ConnectionError("reauth_required"));
    await expectServiceError(createEmailDraft(deps, actor, SESSION, { provider: "microsoft", to: ["a@example.test"] }), 409, "CONNECTION_REQUIRED");
  });

  it("mail failure → failed delivery + 502", async () => {
    const { deps, repo } = makeDeliveryDeps();
    m.createDraft.mockRejectedValueOnce(new m.CloudApiError(400, "bad_request", "nope", false));
    const err = await expectServiceError(createEmailDraft(deps, actor, SESSION, { provider: "google", to: ["a@example.test"] }), 502, "PROVIDER_ERROR");
    expect(err.retryable).toBe(false);
    expect([...repo.fileDeliveries.values()][0]?.status).toBe("failed");
  });
});

describe("auto upload", () => {
  it("onSessionCompleted only when enabled + connected, idempotent per revision", async () => {
    const { deps, repo } = makeDeliveryDeps();
    expect((await onSessionCompleted(deps, SESSION)).enqueued).toBe(false);
    repo.storage.set(PROVIDER, { provider: "google", folderPath: "F/{clientRef}", autoUploadOnComplete: true });
    expect((await onSessionCompleted(deps, SESSION)).enqueued).toBe(false); // not connected
    repo.connect("google");
    const r1 = await onSessionCompleted(deps, SESSION);
    const r2 = await onSessionCompleted(deps, SESSION);
    expect(r1.enqueued).toBe(true);
    expect(r2.deliveryId).toBe(r1.deliveryId);
    expect(repo.fileDeliveries.size).toBe(1);
    expect([...repo.pending.keys()]).toEqual([`file_delivery:${SESSION}:2`]);
    expect(repo.pending.get(`file_delivery:${SESSION}:2`)).toMatchObject({ operation: "file_delivery", revision: 2, payload: { deliveryId: r1.deliveryId } });
  });

  it("processFileDelivery uploads as the session's provider, skips done, throws on retryable failure", async () => {
    const { deps, repo } = makeDeliveryDeps();
    repo.storage.set(PROVIDER, { provider: "google", folderPath: "F/{clientRef}", autoUploadOnComplete: true });
    repo.connect("google");
    const { deliveryId } = await onSessionCompleted(deps, SESSION);

    m.ensureFolder.mockRejectedValueOnce(new m.CloudApiError(503, "unavailable", "x", true));
    await expect(processFileDelivery(deps, deliveryId!)).rejects.toBeInstanceOf(ServiceError);
    expect(repo.fileDeliveries.get(deliveryId!)?.status).toBe("failed");

    const done = await processFileDelivery(deps, deliveryId!);
    expect(done?.status).toBe("done");
    expect(m.getValidAccessToken).toHaveBeenLastCalledWith(deps, PROVIDER, "google");
    expect(m.ensureFolder).toHaveBeenLastCalledWith("F/client-A");

    vi.clearAllMocks();
    const again = await processFileDelivery(deps, deliveryId!);
    expect(again?.status).toBe("done");
    expect(m.ensureFolder).not.toHaveBeenCalled();
  });

  it("processFileDelivery swallows non-retryable failures (recorded on delivery)", async () => {
    const { deps, repo } = makeDeliveryDeps();
    repo.storage.set(PROVIDER, { provider: "google", folderPath: "F", autoUploadOnComplete: true });
    repo.connect("google");
    const { deliveryId } = await onSessionCompleted(deps, SESSION);
    m.getValidAccessToken.mockRejectedValueOnce(new m.ConnectionError("reauth_required"));
    const res = await processFileDelivery(deps, deliveryId!);
    expect(res?.status).toBe("failed");
    expect(repo.fileDeliveries.get(deliveryId!)?.status).toBe("failed");
    expect(await processFileDelivery(deps, "missing")).toBeNull();
  });
});
