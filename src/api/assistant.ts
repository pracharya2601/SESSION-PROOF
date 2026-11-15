/**
 * Review assistant routes.
 *   GET  /api/sessions/:id/assistant  → { available, provider, model, reason }
 *   POST /api/sessions/:id/assistant  { messages, expectedRevision } → AssistantReply
 *
 * Proposes edits only; the client applies one through PATCH /api/sessions/:id/review.
 * All session text goes through src/privacy before inference; logs carry ids and counts only.
 */
import { Hono, type Context } from "hono";
import { InferenceError, type AiSettings, type InferenceProvider } from "../contracts";
import { envDefaultAiSettings } from "../ai/index";
import { apiKeyFor, createInferenceProvider } from "../ai/providers";
import { buildPrivacyContext } from "../privacy";
import { clientKnownTerms } from "../clients";
import { apiError, log } from "../security/index";
import { AssistantRequest, buildCorpus, defaultLimiter, runAssistant, type AssistantStatus, type Limiter } from "../assistant";
import type { ApiDeps, AppBindings } from "./deps";
import { ok } from "./respond";

type C = Context<AppBindings>;

export const ASSISTANT_UNAVAILABLE_MESSAGE =
  "The review assistant isn't set up on this server (no AI key). Use Edit manually to make changes.";

export interface AssistantRouteOptions {
  limiter?: Limiter;
  /** Tests: replace the real provider (default: createInferenceProvider with deps.fetch). */
  providerFor?: (settings: AiSettings) => InferenceProvider;
}

function validId(id: string | undefined): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

/** The provider's saved AI settings when that vendor has a key, else the env default when it does. */
async function resolveSettings(deps: ApiDeps, providerId: string): Promise<AiSettings | null> {
  let saved: AiSettings | null = null;
  try {
    saved = (await deps.repo.getAiSettings(providerId)) ?? null;
  } catch {
    saved = null;
  }
  if (saved && apiKeyFor(deps.env, saved.provider)) return saved;
  const env = envDefaultAiSettings(deps.env);
  if (apiKeyFor(deps.env, env.provider)) return { ...env, privacy: saved?.privacy ?? env.privacy };
  return null;
}

export function assistantRoutes(deps: ApiDeps, opts: AssistantRouteOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const limiter = opts.limiter ?? defaultLimiter;
  const providerFor = opts.providerFor ?? ((s: AiSettings) => createInferenceProvider(deps.env, s, { fetch: deps.fetch }));

  app.get("/api/sessions/:id/assistant", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const actor = c.get("actor");
    const session = await deps.repo.getSessionForProvider(actor.providerId, id);
    if (!session) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const settings = await resolveSettings(deps, actor.providerId);
    const status: AssistantStatus = settings
      ? { available: true, provider: settings.provider, model: settings.model, reason: null }
      : { available: false, provider: null, model: null, reason: ASSISTANT_UNAVAILABLE_MESSAGE };
    return ok(c, status);
  });

  app.post("/api/sessions/:id/assistant", async (c: C) => {
    const id = c.req.param("id");
    if (!validId(id)) return apiError(c, 404, "NOT_FOUND", "Session not found", false);
    const actor = c.get("actor");
    const session = await deps.repo.getSessionForProvider(actor.providerId, id);
    if (!session) return apiError(c, 404, "NOT_FOUND", "Session not found", false);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return apiError(c, 400, "INVALID_REQUEST", "Malformed JSON body", false);
    }
    const parsed = AssistantRequest.safeParse(raw);
    if (!parsed.success) return apiError(c, 400, "INVALID_REQUEST", "Invalid assistant request", false);
    const req = parsed.data;

    if (session.status !== "NEEDS_REVIEW") {
      return apiError(c, 409, "INVALID_STATE", `Session is ${session.status}; the assistant works while it needs review.`, false);
    }
    if (session.currentBundleRevision !== req.expectedRevision) {
      return apiError(c, 409, "STALE_REVISION", "The bundle revision is no longer current", false);
    }
    const bundle = await deps.repo.getBundle(session.id, req.expectedRevision);
    if (!bundle) return apiError(c, 409, "STALE_REVISION", "The bundle revision is no longer current", false);

    const settings = await resolveSettings(deps, actor.providerId);
    if (!settings) return apiError(c, 503, "ASSISTANT_UNAVAILABLE", ASSISTANT_UNAVAILABLE_MESSAGE, false);

    const limited = limiter.hit(`${actor.providerId}:${session.id}`, deps.clock.now().getTime());
    if (!limited.ok) {
      c.header("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      return apiError(c, 429, "RATE_LIMITED", "Too many assistant messages for this session. Try again later or use Edit manually.", true);
    }

    // Fail closed: never call the model without the client's known names.
    let terms: { value: string; type: "NAME" }[];
    try {
      terms = clientKnownTerms(await deps.repo.getClient(actor.providerId, bundle.appointment.clientRef));
    } catch {
      return apiError(c, 503, "PRIVACY_UNAVAILABLE", "Could not prepare privacy protection; the assistant did not run.", true);
    }
    const privacy = { ...settings.privacy, redactNames: true, redactContact: true };
    const corpus = buildCorpus(bundle, req.messages, buildPrivacyContext(bundle.appointment, privacy, terms));

    const started = Date.now();
    try {
      const { reply, stats } = await runAssistant({ bundle, corpus, provider: providerFor(settings) });
      log("info", "assistant.reply", {
        correlationId: c.get("correlationId"),
        sessionId: session.id,
        revision: bundle.bundleRevision,
        provider: reply.provider,
        steps: stats.steps,
        toolCalls: stats.toolCalls,
        proposals: reply.proposals.length,
        invalidProposals: stats.invalidProposals,
        refusals: reply.refusals.length,
        citations: reply.citations.length,
        messages: req.messages.length,
        scrubbed: Object.values(corpus.findings).reduce((a, b) => a + b, 0),
        ms: Date.now() - started,
      });
      return ok(c, reply);
    } catch (err) {
      const kind = err instanceof InferenceError ? err.kind : "unexpected";
      log("warn", "assistant.failed", { correlationId: c.get("correlationId"), sessionId: session.id, kind, ms: Date.now() - started });
      if (kind === "not_configured" || kind === "auth") {
        return apiError(c, 503, "ASSISTANT_UNAVAILABLE", ASSISTANT_UNAVAILABLE_MESSAGE, false);
      }
      if (kind === "rate_limited") return apiError(c, 429, "RATE_LIMITED", "The AI provider is busy. Try again in a moment.", true);
      return apiError(c, 502, "ASSISTANT_FAILED", "The assistant could not answer just now. Try again, or use Edit manually.", true);
    }
  });

  return app;
}
