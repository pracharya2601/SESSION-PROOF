import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  AI_DEFAULT_MODELS,
  AI_PROVIDER_LABELS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  type AiProviderId,
  type AiProviderStatus,
  type AiSettings,
  type EmailSettings,
  type SettingsBundle,
  type StorageSettings,
} from "../contracts";
import type { Repository } from "../db/repository";
import type { Env } from "../env";
import type { ApiDeps, AppBindings } from "./deps";
import { settingsV2Routes } from "./settings-v2";

vi.mock("../ai/providers", () => ({
  aiProviderStatuses: (env: Env): AiProviderStatus[] => {
    const keys: Record<AiProviderId, string | undefined> = {
      anthropic: env.ANTHROPIC_API_KEY ?? env.AI_API_KEY,
      openai: env.OPENAI_API_KEY,
      gemini: env.GEMINI_API_KEY,
      mistral: env.MISTRAL_API_KEY,
    };
    return (Object.keys(keys) as AiProviderId[]).map((provider) => ({
      provider,
      label: AI_PROVIDER_LABELS[provider],
      configured: !!keys[provider],
      models: AI_DEFAULT_MODELS[provider],
    }));
  },
}));

class FakeSettingsRepo {
  storage = new Map<string, StorageSettings>();
  email = new Map<string, EmailSettings>();
  ai = new Map<string, AiSettings>();
  async getStorageSettings(id: string) {
    return this.storage.get(id) ?? structuredClone(DEFAULT_STORAGE_SETTINGS);
  }
  async saveStorageSettings(id: string, s: StorageSettings) {
    this.storage.set(id, structuredClone(s));
  }
  async getEmailSettings(id: string) {
    return this.email.get(id) ?? structuredClone(DEFAULT_EMAIL_SETTINGS);
  }
  async saveEmailSettings(id: string, s: EmailSettings) {
    this.email.set(id, structuredClone(s));
  }
  async getAiSettings(id: string) {
    return this.ai.get(id) ?? null;
  }
  async saveAiSettings(id: string, s: AiSettings) {
    this.ai.set(id, structuredClone(s));
  }
}

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SECRET-111",
  OPENAI_API_KEY: "sk-openai-SECRET-222",
  TOKEN_ENCRYPTION_KEY: "enc-SECRET-333",
  GOOGLE_CLIENT_SECRET: "gcs-SECRET-444",
};

function setup(envOver: Partial<Env> = {}, repo = new FakeSettingsRepo()) {
  const env = { EXTRACTION_MODE: "live", ...SECRETS, ...envOver } as Env;
  const deps = {
    repo: repo as unknown as Repository,
    clock: { now: () => new Date("2026-11-13T12:00:00Z") },
    env,
  } as unknown as ApiDeps;
  const appAs = (providerId: string) => {
    const app = new Hono<AppBindings>();
    app.use("*", async (c, next) => {
      c.set("correlationId", "corr-1");
      c.set("actor", { providerId, identity: `${providerId}@example.test` });
      await next();
    });
    app.route("/", settingsV2Routes(deps));
    return app;
  };
  return { app: appAs("prov-1"), appAs, repo };
}

const send = (app: Hono<AppBindings>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const data = async (r: Response) => ((await r.json()) as { data: SettingsBundle }).data;
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

const storage: StorageSettings = { provider: "google", folderPath: "Docs/{clientRef}", autoUploadOnComplete: true };
const email: EmailSettings = {
  provider: "microsoft",
  defaultTo: ["billing@example.test"],
  defaultCc: [],
  subjectTemplate: "Note {clientRef}",
  bodyTemplate: "Hi,\n\nSee attached.",
  attach: ["invoice"],
};
const ai: AiSettings = { provider: "openai", model: "gpt-4.1-mini", privacy: { ...DEFAULT_AI_SETTINGS.privacy, redactDates: false } };

describe("settings v2 routes", () => {
  it("GET returns defaults, provider statuses and extraction mode", async () => {
    const { app } = setup();
    const r = await send(app, "GET", "/api/settings");
    expect(r.status).toBe(200);
    const b = await data(r);
    expect(b.storage).toEqual(DEFAULT_STORAGE_SETTINGS);
    expect(b.email).toEqual(DEFAULT_EMAIL_SETTINGS);
    expect(b.ai).toEqual(DEFAULT_AI_SETTINGS);
    expect(b.extractionMode).toBe("live");
    expect(b.aiProviders.find((p) => p.provider === "openai")?.configured).toBe(true);
    expect(b.aiProviders.find((p) => p.provider === "gemini")?.configured).toBe(false);
  });

  it("respects env.AI_PROVIDER for defaults; ignores invalid values", async () => {
    const b = await data(await send(setup({ AI_PROVIDER: "gemini" }).app, "GET", "/api/settings"));
    expect(b.ai.provider).toBe("gemini");
    expect(b.ai.model).toBe(AI_DEFAULT_MODELS.gemini[0]);
    const b2 = await data(await send(setup({ AI_PROVIDER: "bogus" }).app, "GET", "/api/settings"));
    expect(b2.ai).toEqual(DEFAULT_AI_SETTINGS);
  });

  it("PUT storage/email/ai roundtrip and return the full bundle", async () => {
    const { app } = setup();
    let b = await data(await send(app, "PUT", "/api/settings/storage", storage));
    expect(b.storage).toEqual(storage);
    b = await data(await send(app, "PUT", "/api/settings/email", email));
    expect(b.email).toEqual(email);
    expect(b.storage).toEqual(storage);
    b = await data(await send(app, "PUT", "/api/settings/ai", ai));
    expect(b.ai).toEqual(ai);
    const g = await data(await send(app, "GET", "/api/settings"));
    expect(g).toMatchObject({ storage, email, ai });
    // null provider is allowed
    b = await data(await send(app, "PUT", "/api/settings/storage", { ...storage, provider: null }));
    expect(b.storage.provider).toBeNull();
  });

  it("invalid bodies, extra fields, providerId in body and malformed JSON are 400", async () => {
    const { app, repo } = setup();
    const cases: [string, unknown][] = [
      ["/api/settings/storage", { ...storage, folderPath: "bad:path" }],
      ["/api/settings/storage", { ...storage, provider: "dropbox" }],
      ["/api/settings/storage", { ...storage, extra: 1 }],
      ["/api/settings/storage", { ...storage, providerId: "evil" }],
      ["/api/settings/email", { ...email, defaultTo: ["not-an-email"] }],
      ["/api/settings/email", { ...email, subjectTemplate: "Hi\r\nBcc: x@evil.test" }],
      ["/api/settings/email", { ...email, subjectTemplate: "Hi\nthere" }],
      ["/api/settings/email", { ...email, providerId: "evil" }],
      ["/api/settings/ai", { ...ai, provider: "llama" }],
      ["/api/settings/ai", { ...ai, privacy: { ...ai.privacy, extra: true } }],
      ["/api/settings/ai", { ...ai, providerId: "evil" }],
      ["/api/settings/ai", "{not json"],
    ];
    for (const [path, body] of cases) {
      const r = await send(app, "PUT", path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      const e = await errCode(r);
      expect(e.code).toBe("INVALID_REQUEST");
      expect(e.message.length).toBeGreaterThan(0);
    }
    expect(repo.storage.size + repo.email.size + repo.ai.size).toBe(0);
  });

  it("issue messages are readable and name the field", async () => {
    const { app } = setup();
    const e = await errCode(await send(app, "PUT", "/api/settings/storage", { ...storage, extra: 1 }));
    expect(e.message).toMatch(/extra/);
    const e2 = await errCode(await send(app, "PUT", "/api/settings/email", { ...email, defaultTo: ["x"] }));
    expect(e2.message).toMatch(/defaultTo\.0/);
  });

  it("unconfigured AI provider: 422 in live mode, allowed in fixture mode", async () => {
    const live = setup();
    const r = await send(live.app, "PUT", "/api/settings/ai", { ...ai, provider: "mistral", model: "mistral-large-latest" });
    expect(r.status).toBe(422);
    expect((await errCode(r)).code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    expect(live.repo.ai.size).toBe(0);

    const fx = setup({ EXTRACTION_MODE: "fixture" });
    const r2 = await send(fx.app, "PUT", "/api/settings/ai", { ...ai, provider: "mistral", model: "mistral-large-latest" });
    expect(r2.status).toBe(200);
    const b = await data(r2);
    expect(b.ai.provider).toBe("mistral");
    expect(b.extractionMode).toBe("fixture");
  });

  it("settings are isolated per provider", async () => {
    const { appAs, repo } = setup();
    const a = appAs("prov-a");
    const b = appAs("prov-b");
    await send(a, "PUT", "/api/settings/storage", storage);
    await send(a, "PUT", "/api/settings/email", email);
    await send(a, "PUT", "/api/settings/ai", ai);
    const other = await data(await send(b, "GET", "/api/settings"));
    expect(other.storage).toEqual(DEFAULT_STORAGE_SETTINGS);
    expect(other.email).toEqual(DEFAULT_EMAIL_SETTINGS);
    expect(other.ai).toEqual(DEFAULT_AI_SETTINGS);
    expect([...repo.storage.keys()]).toEqual(["prov-a"]);
    expect([...repo.ai.keys()]).toEqual(["prov-a"]);
  });

  it("never returns key material", async () => {
    const { app } = setup({ GEMINI_API_KEY: "gem-SECRET-555", MISTRAL_API_KEY: "mis-SECRET-666" });
    const texts = [
      await (await send(app, "GET", "/api/settings")).text(),
      await (await send(app, "PUT", "/api/settings/ai", ai)).text(),
      await (await send(app, "PUT", "/api/settings/storage", storage)).text(),
      await (await send(app, "PUT", "/api/settings/email", email)).text(),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/SECRET/);
      expect(t).not.toMatch(/apiKey|api_key/i);
    }
  });
});
