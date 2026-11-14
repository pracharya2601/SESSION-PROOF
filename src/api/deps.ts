/** API dependency container (FROZEN). Built by the composition root (src/index.ts). */
import type {
  ApprovalRecord,
  AssembleBundleFn,
  Clock,
  DiscoverySummary,
  DispatchSummary,
} from "../contracts";
import type { Repository } from "../db/repository";
import type { Env } from "../env";

export interface ApiDeps {
  repo: Repository;
  clock: Clock;
  env: Env;
  assemble: AssembleBundleFn;
  discover: () => Promise<DiscoverySummary>;
  dispatch: () => Promise<DispatchSummary>;
  notifyApproval: (approval: ApprovalRecord) => Promise<void>;
  /** Dev/operator only. */
  seed?: () => Promise<void>;
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
