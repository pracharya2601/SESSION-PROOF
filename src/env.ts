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

  // secrets
  AI_API_KEY?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
}
