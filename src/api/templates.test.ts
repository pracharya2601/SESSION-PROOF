import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DocModel, DocumentTemplate, TemplateInput } from "../contracts";
import { BUILTIN_TEMPLATES } from "../documents/index";
import { makeBundle } from "../services/approval/testkit";
import { DeliveryFakeRepo, makeDeliveryDeps, OTHER_PROVIDER, PROVIDER, SESSION } from "../services/delivery/testkit";
import type { ApiDeps, AppBindings } from "./deps";
import { templatesRoutes } from "./templates";

function appFor(repo = new DeliveryFakeRepo(), providerId = PROVIDER) {
  const { deps } = makeDeliveryDeps(repo);
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-1");
    c.set("actor", { providerId, identity: "p@example.test" });
    await next();
  });
  app.route("/", templatesRoutes(deps as unknown as ApiDeps));
  return { app, repo };
}

const send = (app: Hono<AppBindings>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const data = async <T>(r: Response) => ((await r.json()) as { data: T }).data;
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

function tplInput(kind: TemplateInput["kind"] = "invoice", name = "Mine"): TemplateInput {
  const b = BUILTIN_TEMPLATES[kind];
  return { kind, name, theme: { ...b.theme, accentColor: "#123456" }, sections: b.sections, text: { ...b.text, title: "Custom title" } };
}

describe("templates routes", () => {
  it("lists builtins with builtin default when nothing is set; kind filter; bad kind 400", async () => {
    const { app } = appFor();
    const all = await data<DocumentTemplate[]>(await app.request("/api/templates"));
    expect(all.map((t) => t.id)).toEqual(["builtin:session_note", "builtin:invoice", "builtin:approval_record"]);
    expect(all.every((t) => t.builtin && t.isDefault)).toBe(true);
    const inv = await data<DocumentTemplate[]>(await app.request("/api/templates?kind=invoice"));
    expect(inv.map((t) => t.id)).toEqual(["builtin:invoice"]);
    expect((await app.request("/api/templates?kind=evil")).status).toBe(400);
  });

  it("CRUD + default", async () => {
    const { app, repo } = appFor();
    const cr = await send(app, "POST", "/api/templates", tplInput());
    expect(cr.status).toBe(201);
    const created = await data<DocumentTemplate>(cr);
    expect(created.id).toMatch(/^tpl_[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ kind: "invoice", name: "Mine", builtin: false });

    const setDef = await send(app, "PUT", "/api/templates/default/invoice", { templateId: created.id });
    expect(setDef.status).toBe(200);
    expect(await data(setDef)).toEqual({ kind: "invoice", templateId: created.id });
    const list = await data<DocumentTemplate[]>(await app.request("/api/templates?kind=invoice"));
    expect(list.find((t) => t.id === created.id)?.isDefault).toBe(true);
    expect(list.find((t) => t.id === "builtin:invoice")?.isDefault).toBe(false);

    const up = await send(app, "PUT", `/api/templates/${created.id}`, { ...tplInput(), name: "Renamed" });
    expect(up.status).toBe(200);
    expect(await data<DocumentTemplate>(up)).toMatchObject({ name: "Renamed", isDefault: true });

    const kindChange = await send(app, "PUT", `/api/templates/${created.id}`, tplInput("session_note"));
    expect(kindChange.status).toBe(400);

    const del = await send(app, "DELETE", `/api/templates/${created.id}`);
    expect(del.status).toBe(200);
    expect(await data(del)).toEqual({ deleted: true });
    expect(await repo.getDefaultTemplateId(PROVIDER, "invoice")).toBeNull();
    expect((await send(app, "DELETE", `/api/templates/${created.id}`)).status).toBe(404);

    const back = await send(app, "PUT", "/api/templates/default/invoice", { templateId: "builtin:invoice" });
    expect(back.status).toBe(200);
    const clear = await send(app, "PUT", "/api/templates/default/invoice", { templateId: null });
    expect(await data(clear)).toEqual({ kind: "invoice", templateId: null });
  });

  it("builtins are read-only", async () => {
    const { app } = appFor();
    const put = await send(app, "PUT", "/api/templates/builtin:invoice", tplInput());
    expect(put.status).toBe(409);
    expect(await errCode(put)).toBe("READ_ONLY");
    const del = await send(app, "DELETE", "/api/templates/builtin:invoice");
    expect(del.status).toBe(409);
    expect(await errCode(del)).toBe("READ_ONLY");
  });

  it("validation: non-strict body, bad JSON, bad default kind/id", async () => {
    const { app } = appFor();
    expect((await send(app, "POST", "/api/templates", { ...tplInput(), extra: 1 })).status).toBe(400);
    expect((await send(app, "POST", "/api/templates", "{nope")).status).toBe(400);
    expect((await send(app, "POST", "/api/templates", { ...tplInput(), theme: { ...tplInput().theme, accentColor: "red" } })).status).toBe(400);
    expect((await send(app, "PUT", "/api/templates/default/evil", { templateId: null })).status).toBe(400);
    expect((await send(app, "PUT", "/api/templates/default/invoice", { templateId: "tpl_missing" })).status).toBe(404);
    expect((await send(app, "PUT", "/api/templates/default/invoice", { templateId: "builtin:session_note" })).status).toBe(404);
    expect((await send(app, "PUT", "/api/templates/default/invoice", {})).status).toBe(400);
  });

  it("isolation: another provider's template is invisible and immutable", async () => {
    const { app, repo } = appFor();
    const created = await data<DocumentTemplate>(await send(app, "POST", "/api/templates", tplInput()));
    const other = appFor(repo, OTHER_PROVIDER).app;
    const list = await data<DocumentTemplate[]>(await other.request("/api/templates?kind=invoice"));
    expect(list.map((t) => t.id)).toEqual(["builtin:invoice"]);
    expect((await send(other, "PUT", `/api/templates/${created.id}`, tplInput())).status).toBe(404);
    expect((await send(other, "DELETE", `/api/templates/${created.id}`)).status).toBe(404);
    expect((await send(other, "PUT", "/api/templates/default/invoice", { templateId: created.id })).status).toBe(404);
    expect(repo.templates.has(created.id)).toBe(true);
  });

  it("preview with synthetic sample data", async () => {
    const { app } = appFor();
    const r = await send(app, "POST", "/api/templates/preview", { template: tplInput() });
    expect(r.status).toBe(200);
    const model = await data<DocModel>(r);
    expect(model.kind).toBe("invoice");
    expect(model.theme.accentColor).toBe("#123456");
    expect(model.title).toBe("Custom title");
    expect(model.blocks.length).toBeGreaterThan(0);
  });

  it("preview with a real session (unsaved template substituted); foreign session 404", async () => {
    const repo = new DeliveryFakeRepo();
    const { app } = appFor(repo);
    const r = await send(app, "POST", "/api/templates/preview", { template: tplInput("session_note"), sessionId: SESSION });
    expect(r.status).toBe(200);
    const model = await data<DocModel>(r);
    expect(model.kind).toBe("session_note");
    expect(model.templateId).toBe("preview");
    expect(model.theme.accentColor).toBe("#123456");
    expect(JSON.stringify(model)).toContain("client-A");
    const other = appFor(repo, OTHER_PROVIDER).app;
    expect((await send(other, "POST", "/api/templates/preview", { template: tplInput(), sessionId: SESSION })).status).toBe(404);
    const nob = appFor(new DeliveryFakeRepo({ completed: false })).app;
    expect((await send(nob, "POST", "/api/templates/preview", { template: tplInput(), sessionId: SESSION })).status).toBe(409);
    const draftRepo = new DeliveryFakeRepo({ completed: false });
    draftRepo.drafts.set(SESSION, makeBundle({ bundleRevision: 2 }));
    expect((await send(appFor(draftRepo).app, "POST", "/api/templates/preview", { template: tplInput(), sessionId: SESSION })).status).toBe(200);
  });
});
