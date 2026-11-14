/**
 * Node-side stand-in for the workerd-only `cloudflare:workers` module, used by
 * vitest via the alias in vitest.config.ts. Only the base classes are provided;
 * tests should drive workflow logic through src/workflow/run.ts with a fake step.
 */
export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  abstract run(event: { payload: Params; timestamp: Date; instanceId: string }, step: unknown): Promise<unknown>;
}

export abstract class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export abstract class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env: Record<string, unknown> = {};
