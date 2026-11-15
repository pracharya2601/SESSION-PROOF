/**
 * v2 settings: GET /api/settings (bundle) and PUT /api/settings/storage | /email | /ai.
 * Always scoped to the authenticated actor; never returns secrets (aiProviders only
 * carries `configured` booleans).
 */
import { Hono, type Context } from "hono";
import type { z } from "zod";
import {
  AI_DEFAULT_MODELS,
  AiProviderId,
  AiSettings,
  DEFAULT_AI_SETTINGS,
  EMPTY_PROVIDER_PROFILE,
  EmailSettings,
  ProviderProfileInput,
  StorageSettings,
  missingProfileFields,
  type BusinessProfileView,
  type SettingsBundle,
} from "../contracts";
import { aiProviderStatuses } from "../ai/providers";
import type { Env } from "../env";
import { apiError } from "../security";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

/** AI defaults when the user has saved nothing: honour env.AI_PROVIDER if it names a known provider. */
export function defaultAiSettings(env: Env): AiSettings {
  const p = AiProviderId.safeParse(env.AI_PROVIDER?.trim().toLowerCase());
  if (!p.success || p.data === DEFAULT_AI_SETTINGS.provider) {
    return { ...DEFAULT_AI_SETTINGS, privacy: { ...DEFAULT_AI_SETTINGS.privacy } };
  }
  return {
    ...DEFAULT_AI_SETTINGS,
    provider: p.data,
    model: AI_DEFAULT_MODELS[p.data][0] ?? DEFAULT_AI_SETTINGS.model,
    privacy: { ...DEFAULT_AI_SETTINGS.privacy },
  };
}

async function bundle(deps: ApiDeps, providerId: string): Promise<SettingsBundle> {
  const [storage, email, ai] = await Promise.all([
    deps.repo.getStorageSettings(providerId),
    deps.repo.getEmailSettings(providerId),
    deps.repo.getAiSettings(providerId),
  ]);
  return {
    storage,
    email,
    ai: ai ?? defaultAiSettings(deps.env),
    aiProviders: aiProviderStatuses(deps.env),
    extractionMode: deps.env.EXTRACTION_MODE === "fixture" ? "fixture" : "live",
  };
}

function issuesMessage(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, "INVALID_REQUEST", "Body must be JSON.", false) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, res: apiError(c, 400, "INVALID_REQUEST", issuesMessage(parsed.error), false) };
  }
  return { ok: true, data: parsed.data };
}

export function settingsV2Routes(deps: ApiDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/settings", async (c) => ok(c, await bundle(deps, c.get("actor").providerId)));

  app.put("/api/settings/storage", async (c) => {
    const p = await parseBody(c, StorageSettings);
    if (!p.ok) return p.res;
    const providerId = c.get("actor").providerId;
    await deps.repo.saveStorageSettings(providerId, p.data, deps.clock.now());
    return ok(c, await bundle(deps, providerId));
  });

  app.put("/api/settings/email", async (c) => {
    const p = await parseBody(c, EmailSettings);
    if (!p.ok) return p.res;
    if (/[\r\n]/.test(p.data.subjectTemplate)) {
      return apiError(c, 400, "INVALID_REQUEST", "subjectTemplate: must be a single line (no line breaks).", false);
    }
    const providerId = c.get("actor").providerId;
    await deps.repo.saveEmailSettings(providerId, p.data, deps.clock.now());
    return ok(c, await bundle(deps, providerId));
  });

  app.put("/api/settings/ai", async (c) => {
    const p = await parseBody(c, AiSettings);
    if (!p.ok) return p.res;
    if (deps.env.EXTRACTION_MODE !== "fixture") {
      const status = aiProviderStatuses(deps.env).find((s) => s.provider === p.data.provider);
      if (!status?.configured) {
        return apiError(
          c,
          422,
          "AI_PROVIDER_NOT_CONFIGURED",
          `${status?.label ?? p.data.provider} is not configured on the server (no API key).`,
          false,
        );
      }
    }
    const providerId = c.get("actor").providerId;
    await deps.repo.saveAiSettings(providerId, p.data, deps.clock.now());
    return ok(c, await bundle(deps, providerId));
  });

  // v5: business profile printed on invoices (vendor #, address, logo, numbering).
  async function profileView(providerId: string): Promise<BusinessProfileView> {
    const stored = await deps.repo.getProviderProfile(providerId);
    const { providerId: _p, updatedAt, ...profile } = stored ?? { ...EMPTY_PROVIDER_PROFILE, providerId, updatedAt: null };
    return { profile, missing: missingProfileFields(profile), updatedAt };
  }

  app.get("/api/settings/business-profile", async (c) => ok(c, await profileView(c.get("actor").providerId)));

  app.put("/api/settings/business-profile", async (c) => {
    const p = await parseBody(c, ProviderProfileInput);
    if (!p.ok) return p.res;
    const providerId = c.get("actor").providerId;
    await deps.repo.saveProviderProfile(providerId, p.data, deps.clock.now());
    return ok(c, await profileView(providerId));
  });

  return app;
}
