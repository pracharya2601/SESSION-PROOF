/**
 * Cloudflare Workflows entrypoint (Agent 14). The composition root
 * (src/index.ts) calls setWorkflowDepsFactory() and re-exports SessionWorkflow.
 * Implementation modules are injected — never imported here.
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowParams } from "../contracts";
import type { Env } from "../env";
import { runSessionWorkflow, type StepLike, type WorkflowDeps } from "./run";

export { runSessionWorkflow, type StepLike, type WorkflowDeps } from "./run";

let depsFactory: ((env: Env) => WorkflowDeps) | null = null;

export function setWorkflowDepsFactory(fn: (env: Env) => WorkflowDeps): void {
  depsFactory = fn;
}

/** Adapts the runtime WorkflowStep to the minimal StepLike used by run.ts. */
function adaptStep(step: WorkflowStep): StepLike {
  return {
    do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      // Step results are small JSON objects (ids/status/revision), hence serializable.
      // `step` is an RPC stub: call the method directly (no .call/.bind on stub methods).
      const run = fn as unknown as () => Promise<Rpc.Serializable<T>>;
      return step.do(name, run) as unknown as Promise<T>;
    },
    async waitForEvent<T>(name: string, opts: { type: string; timeout: string | number }) {
      const ev = await step.waitForEvent(name, {
        type: opts.type,
        timeout: opts.timeout as Parameters<WorkflowStep["waitForEvent"]>[1]["timeout"],
      });
      return { payload: ev.payload as T };
    },
  };
}

export class SessionWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<{ outcome: string }> {
    const parsed = WorkflowParams.safeParse(event.payload);
    if (!parsed.success) throw new NonRetryableError("Invalid workflow params", "InvalidParams");
    if (!depsFactory) throw new Error("Workflow dependencies not configured");
    return runSessionWorkflow(depsFactory(this.env), parsed.data, adaptStep(step));
  }
}
