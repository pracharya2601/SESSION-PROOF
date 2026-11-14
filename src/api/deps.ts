/** API dependency container (FROZEN). Built by the composition root (src/index.ts). */
import type {
  ApprovalRecord,
  AssembleBundleFn,
  Clock,
  DiscoverySummary,
  DispatchSummary,
  RunRecorder,
} from "../contracts";
import type { Repository } from "../db/repository";
import type { Env } from "../env";

export interface ApiDeps {
  repo: Repository;
  clock: Clock;
  env: Env;
  assemble: AssembleBundleFn;
  /** Discovery for one provider (manual sync is always scoped to the actor). */
  discover: (opts?: { providerId: string; lookbackMinutes?: number }) => Promise<DiscoverySummary>;
  dispatch: () => Promise<DispatchSummary>;
  notifyApproval: (approval: ApprovalRecord) => Promise<void>;
  /** Dev/operator only. */
  seed?: () => Promise<void>;
  /** v2: injectable fetch for outbound provider calls (OAuth, Drive, Mail, AI). Default: global fetch. */
  fetch?: typeof fetch;
  /** v3: run history recorder (best-effort; never fails a request). */
  recorder?: RunRecorder;
}

/** Authenticated actor — always derived server-side. */
export interface Actor {
  providerId: string;
  identity: string;
}

/** Hono env typing shared by all routers. */
export type AppBindings = {
  Variables: { actor: Actor; correlationId: string };
};
