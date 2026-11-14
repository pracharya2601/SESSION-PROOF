/** Environment contract (handoff §6.3). Binding names are frozen. */
import type { SessionQueueMessage, WorkflowParams } from "./contracts";

export interface Env {
  DB: D1Database;
  SESSION_QUEUE: Queue<SessionQueueMessage>;
  SESSION_WORKFLOW: Workflow<WorkflowParams>;
  ASSETS: Fetcher;
  /**
   * Offline recordings (src/offline): R2 bucket holding uploaded VXREC1 files ONLY until they are
   * transcribed (key audio-tmp/<provider>/<visit>.bin; deleted right after, or 24 h after a final
   * failure). Absent → /api/device/offline-visits returns 503 OFFLINE_NOT_CONFIGURED.
   */
  AUDIO_TMP?: R2Bucket;

  EVIDENCE_MODE: "live" | "fixture";
  EXTRACTION_MODE: "live" | "fixture";
  AI_MODEL: string;
  AI_GATEWAY_URL?: string;
  /** "public": NO login — every request acts as PUBLIC_PROVIDER_ID (owner's choice for an open demo). */
  AUTH_MODE: "dev" | "access" | "public";
  /** AUTH_MODE "public" only: the provider every visitor acts as. */
  PUBLIC_PROVIDER_ID?: string;
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

  /**
   * Paired devices: the http(s) origin a phone uses for the device API, put into the pairing
   * link (e.g. "http://192.168.1.20:8787" on the LAN in dev, "https://field.example.com").
   * Unset → derived from PUBLIC_STREAM_ORIGIN (ws→http, wss→https), else APP_ORIGIN.
   */
  PUBLIC_APP_ORIGIN?: string;

  /**
   * Notifications (src/notify): sender address for notification emails, e.g.
   * "Vexo Field Assistant <notify@field.example.com>". Email stays off unless this AND a sender
   * (RESEND_API_KEY or the NOTIFY_EMAIL binding) are set, and the provider opted in.
   */
  NOTIFY_FROM?: string;
  /** Cloudflare Email Workers `send_email` binding (needs Email Routing on NOTIFY_FROM's domain; verified destinations only). */
  NOTIFY_EMAIL?: SendEmail;
  /** Force a sender when both are configured ("resend" | "cloudflare"). Default: resend. */
  NOTIFY_EMAIL_PROVIDER?: "resend" | "cloudflare";

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
  /** Notifications: Resend HTTP API key (email sender; with NOTIFY_FROM). */
  RESEND_API_KEY?: string;
  SESSION_SECRET?: string;
}
