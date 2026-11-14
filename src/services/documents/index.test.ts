import { describe, expect, it } from "vitest";
import { builtinTemplateId, type ClientSnapshot, type TemplateInput } from "../../contracts";
import type { Repository } from "../../db/repository";
import { BUILTIN_TEMPLATES } from "../../documents/index";
import { ServiceError } from "../approval/index";
import { makeBundle } from "../approval/testkit";
import { clientInput, DeliveryFakeRepo, makeDeliveryDeps, NOW, OTHER_PROVIDER, PROVIDER, SESSION } from "../delivery/testkit";
import { loadDocModelInput, resolveTemplate } from "./index";

function tplInput(kind: TemplateInput["kind"], name: string): TemplateInput {
  const b = BUILTIN_TEMPLATES[kind];
  return { kind, name, theme: b.theme, sections: b.sections, text: b.text };
}

async function setup() {
  const repo = new DeliveryFakeRepo();
  const asRepo = repo as unknown as Repository;
  const clientTpl = await repo.createTemplate(PROVIDER, "tpl_client", tplInput("invoice", "Client"), NOW);
  const defaultTpl = await repo.createTemplate(PROVIDER, "tpl_default", tplInput("invoice", "Default"), NOW);
  const overrideTpl = await repo.createTemplate(PROVIDER, "tpl_override", tplInput("invoice", "Override"), NOW);
  const foreign = await repo.createTemplate(OTHER_PROVIDER, "tpl_foreign", tplInput("invoice", "Foreign"), NOW);
  const noteTpl = await repo.createTemplate(PROVIDER, "tpl_note", tplInput("session_note", "Note"), NOW);
  const client = await repo.upsertClient(PROVIDER, clientInput({ templates: { session_note: null, invoice: clientTpl.id, approval_record: null } }), NOW);
  return { repo, asRepo, client, clientTpl, defaultTpl, overrideTpl, foreign, noteTpl };
}

describe("resolveTemplate precedence", () => {
  it("override → client → provider default → builtin", async () => {
    const { repo, asRepo, client, overrideTpl, defaultTpl } = await setup();
    await repo.setDefaultTemplateId(PROVIDER, "invoice", defaultTpl.id);
    expect((await resolveTemplate(asRepo, PROVIDER, "invoice", client, overrideTpl.id)).id).toBe("tpl_override");
    expect((await resolveTemplate(asRepo, PROVIDER, "invoice", client)).id).toBe("tpl_client");
    expect((await resolveTemplate(asRepo, PROVIDER, "invoice", null)).id).toBe("tpl_default");
    await repo.setDefaultTemplateId(PROVIDER, "invoice", null);
    const b = await resolveTemplate(asRepo, PROVIDER, "invoice", null);
    expect(b.id).toBe(builtinTemplateId("invoice"));
    expect(b.builtin).toBe(true);
  });

  it("override with the builtin id selects the builtin even when the client has one", async () => {
    const { asRepo, client } = await setup();
    expect((await resolveTemplate(asRepo, PROVIDER, "invoice", client, "builtin:invoice")).id).toBe("builtin:invoice");
  });

  it("snapshots carry no template choice", async () => {
    const { asRepo, client } = await setup();
    const { notes: _n, templates: _t, ...rest } = client;
    const snap: ClientSnapshot = { ...rest, effectiveHourlyRateCents: 8000, capturedAt: NOW.toISOString() };
    expect((await resolveTemplate(asRepo, PROVIDER, "invoice", snap)).id).toBe("builtin:invoice");
  });

  it("foreign, missing, wrong-kind and wrong-builtin ids fall back", async () => {
    const { repo, asRepo, foreign, noteTpl } = await setup();
    for (const id of [foreign.id, "tpl_missing", noteTpl.id, "builtin:session_note", "builtin:evil"]) {
      expect((await resolveTemplate(asRepo, PROVIDER, "invoice", null, id)).id).toBe("builtin:invoice");
    }
    await repo.setDefaultTemplateId(PROVIDER, "invoice", foreign.id);
    expect((await resolveTemplate(asRepo, PROVIDER, "invoice", null)).id).toBe("builtin:invoice");
    // the other provider's client template pointing at our id doesn't leak either
    expect((await resolveTemplate(asRepo, OTHER_PROVIDER, "invoice", null, "tpl_client")).id).toBe("builtin:invoice");
  });
});

describe("loadDocModelInput", () => {
  it("completed: final bundle + frozen snapshot (not the live client); template from live client", async () => {
    const { repo, client } = await setup();
    const { deps } = makeDeliveryDeps(repo);
    const { notes: _n, templates: _t, ...rest } = client;
    await repo.saveClientSnapshot(SESSION, 2, { ...rest, effectiveHourlyRateCents: 8000, capturedAt: NOW.toISOString() });
    await repo.upsertClient(PROVIDER, { ...clientInput(), displayName: "Changed Later", hourlyRateCents: 9999, templates: client.templates }, NOW);
    const input = await loadDocModelInput(deps, PROVIDER, SESSION, "invoice");
    expect(input.final?.bundleRevision).toBe(2);
    expect(input.bundle).toBe(input.final?.bundle);
    expect(input.approval?.bundleRevision).toBe(2);
    expect(input.providerIdentity).toBe("p@example.test");
    expect(input.client?.displayName).toBe("Alex Example");
    expect(input.client?.effectiveHourlyRateCents).toBe(8000);
    expect(input.template.id).toBe("tpl_client");
  });

  it("completed without snapshot → client null", async () => {
    const { repo } = await setup();
    const { deps } = makeDeliveryDeps(repo);
    expect((await loadDocModelInput(deps, PROVIDER, SESSION, "session_note")).client).toBeNull();
  });

  it("draft: current bundle + live client as preview snapshot with the bundle's rate", async () => {
    const repo = new DeliveryFakeRepo({ completed: false });
    repo.drafts.set(SESSION, makeBundle({ bundleRevision: 2 }));
    await repo.upsertClient(PROVIDER, clientInput({ displayName: "Live Name", hourlyRateCents: 12345 }), NOW);
    const { deps } = makeDeliveryDeps(repo);
    const input = await loadDocModelInput(deps, PROVIDER, SESSION, "invoice", "tpl_missing");
    expect(input.final).toBeNull();
    expect(input.approval).toBeNull();
    expect(input.bundle.bundleRevision).toBe(2);
    expect(input.client).toMatchObject({ displayName: "Live Name", effectiveHourlyRateCents: 7500, capturedAt: NOW.toISOString() });
    expect(input.client).not.toHaveProperty("templates");
    expect(input.client).not.toHaveProperty("notes");
    expect(input.template.id).toBe("builtin:invoice");
  });

  it("404 for another provider's session; 409 NO_BUNDLE without a bundle", async () => {
    const { deps } = makeDeliveryDeps();
    const e1 = await loadDocModelInput(deps, OTHER_PROVIDER, SESSION, "invoice").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ServiceError);
    expect((e1 as ServiceError).status).toBe(404);
    const { deps: d2 } = makeDeliveryDeps(new DeliveryFakeRepo({ completed: false }));
    const e2 = await loadDocModelInput(d2, PROVIDER, SESSION, "invoice").catch((e: unknown) => e);
    expect((e2 as ServiceError).status).toBe(409);
    expect((e2 as ServiceError).code).toBe("NO_BUNDLE");
  });
});
