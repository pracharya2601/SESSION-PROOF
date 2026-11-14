/** Environment contract (handoff §6.3). Binding names are frozen. */
import type { QueuePayload, WorkflowParams } from "./contracts";

export interface Env {
  DB: D1Database;
  SESSION_QUEUE: Queue<QueuePayload>;
  SESSION_WORKFLOW: Workflow<WorkflowParams>;
  ASSETS: Fetcher;

  EVIDENCE_MODE: "live" | "fixture";
  EXTRACTION_MODE: "live" | "fixture";
  AI_MODEL: string;
  AI_GATEWAY_URL?: string;
  AUTH_MODE: "dev" | "access";
  APP_ORIGIN: string;
  RUNTIME_MODE: "local" | "deployed";

  /** Fixture variant selector for synthetic evidence/extraction (default "normal"). */
  FIXTURE_VARIANT?: string;

  /**
   * Band visits: origin used for the `streamUrl` returned by POST /api/visits, instead of the
   * request's own host, so a phone bridge (GlassCam) can reach it. Must be ws:// or wss://
   * (e.g. "ws://192.168.1.20:8787" for a phone on the LAN in dev, "wss://field.example.com").
   * Anything else is ignored (and logged). Unset → derived from the request URL.
   */
  PUBLIC_STREAM_ORIGIN?: string;

  /** v2: default inference provider when a user has no AI settings (anthropic|openai|gemini|mistral). */
  AI_PROVIDER?: string;

  // secrets
  /** Anthropic key (legacy name). */
  AI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  /** Optional base URL overrides (e.g. Cloudflare AI Gateway per provider). */
  OPENAI_BASE_URL?: string;
  GEMINI_BASE_URL?: string;
  MISTRAL_BASE_URL?: string;
  /** OAuth clients for Connections (Drive/Gmail, OneDrive/Outlook). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  /** Azure AD tenant; default "common". */
  MS_TENANT?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  /** Band visits: Deepgram live speech-to-text. Absent → simulated transcript in local dev, disabled when deployed. */
  DEEPGRAM_API_KEY?: string;
  SESSION_SECRET?: string;
}
