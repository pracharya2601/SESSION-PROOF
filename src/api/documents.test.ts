import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DocModel, TemplateInput } from "../contracts";
import { BUILTIN_TEMPLATES } from "../documents/index";
import { makeBundle } from "../services/approval/testkit";
import { clientInput, DeliveryFakeRepo, makeDeliveryDeps, NOW, OTHER_PROVIDER, PROVIDER, SESSION } from "../services/delivery/testkit";
import type { ApiDeps, AppBindings } from "./deps";
import { documentsRoutes } from "./documents";

function appFor(repo = new DeliveryFakeRepo(), providerId = PROVIDER) {
  const { deps } = makeDeliveryDeps(repo);
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-1");
    c.set("actor", { providerId, identity: "p@example.test" });
    await next();
  });
  app.route("/", documentsRoutes(deps as unknown as ApiDeps));
  return { app, repo };
}
const data = async <T>(r: Response) => ((await r.json()) as { data: T }).data;

function tplInput(kind: TemplateInput["kind"], name: string): TemplateInput {
  const b = BUILTIN_TEMPLATES[kind];
  return { kind, name, theme: { ...b.theme, accentColor: "#abcdef" }, sections: b.sections, text: b.text };
}

describe("documents route", () => {
  it("completed: uses the frozen client snapshot; later client edits don't change the document", async () => {
    const repo = new DeliveryFakeRepo();
    const client = await repo.upsertClient(PROVIDER, clientInput({ displayName: "Frozen Name" }), NOW);
    const { notes: _n, templates: _t, ...rest } = client;
    await repo.saveClientSnapshot(SESSION, 2, { ...rest, effectiveHourlyRateCents: 7500, capturedAt: NOW.toISOString() });
    const { app } = appFor(repo);
    const r1 = await app.request(`/api/sessions/${SESSION}/documents/invoice`);
    expect(r1.status).toBe(200);
    const before = await data<DocModel>(r1);
    expect(before.kind).toBe("invoice");
    expect(before.templateId).toBe("builtin:invoice");
    expect(JSON.stringify(before)).toContain("Frozen Name");

    await repo.upsertClient(PROVIDER, clientInput({ displayName: "Renamed Later", hourlyRateCents: 99999, fundingSource: "Other" }), NOW);
    const after = await data<DocModel>(await app.request(`/api/sessions/${SESSION}/documents/invoice`));
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("Renamed Later");
  });

  it("draft: uses the live client and is marked DRAFT", async () => {
    const repo = new DeliveryFakeRepo({ completed: false });
    repo.drafts.set(SESSION, makeBundle({ bundleRevision: 2 }));
    await repo.upsertClient(PROVIDER, clientInput({ displayName: "Live Name" }), NOW);
    const { app } = appFor(repo);
    const model = await data<DocModel>(await app.request(`/api/sessions/${SESSION}/documents/session_note`));
    expect(model.banner ?? "").toMatch(/draft/i);
    await repo.upsertClient(PROVIDER, clientInput({ displayName: "Edited Name" }), NOW);
    const model2 = await data<DocModel>(await app.request(`/api/sessions/${SESSION}/documents/invoice`));
    expect(JSON.stringify(model2)).toContain("Edited Name");
  });

  it("templateId query and client template choice", async () => {
    const repo = new DeliveryFakeRepo();
    const t = await repo.createTemplate(PROVIDER, "tpl_inv", tplInput("invoice", "Inv"), NOW);
    const { app } = appFor(repo);
    const m1 = await data<DocModel>(await app.request(`/api/sessions/${SESSION}/documents/invoice?templateId=${t.id}`));
    expect(m1.templateId).toBe("tpl_inv");
    expect(m1.theme.accentColor).toBe("#abcdef");
    await repo.upsertClient(PROVIDER, clientInput({ templates: { session_note: null, invoice: t.id, approval_record: null } }), NOW);
    expect((await data<DocModel>(await app.request(`/api/sessions/${SESSION}/documents/invoice`))).templateId).toBe("tpl_inv");
  });

  it("bad kind 400; other provider 404 (and its template id falls back to builtin); no bundle 409", async () => {
    const repo = new DeliveryFakeRepo();
    const { app } = appFor(repo);
    expect((await app.request(`/api/sessions/${SESSION}/documents/evil`)).status).toBe(400);
    expect((await appFor(repo, OTHER_PROVIDER).app.request(`/api/sessions/${SESSION}/documents/invoice`)).status).toBe(404);
    await repo.createTemplate(OTHER_PROVIDER, "tpl_foreign", tplInput("invoice", "Foreign"), NOW);
    const m = await data<DocModel>(await app.request(`/api/sessions/${SESSION}/documents/invoice?templateId=tpl_foreign`));
    expect(m.templateId).toBe("builtin:invoice");
    const nob = await appFor(new DeliveryFakeRepo({ completed: false })).app.request(`/api/sessions/${SESSION}/documents/invoice`);
    expect(nob.status).toBe(409);
  });
});
