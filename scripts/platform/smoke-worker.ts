/**
 * Toolchain smoke worker (Agent 03). NOT part of the app.
 * Exercises the same binding names as wrangler.jsonc: DB, SESSION_QUEUE,
 * SESSION_WORKFLOW, ASSETS. Run via scripts/platform/smoke.sh.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface SmokeEnv {
  DB: D1Database;
  SESSION_QUEUE: Queue<{ id: string }>;
  SESSION_WORKFLOW: Workflow<{ id: string }>;
  ASSETS: Fetcher;
}

export class SessionWorkflow extends WorkflowEntrypoint<SmokeEnv, { id: string }> {
  async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    const a = await step.do("write", async () => {
      await this.env.DB.prepare("INSERT INTO smoke_log (kind, ref) VALUES ('workflow', ?)")
        .bind(event.payload.id)
        .run();
      return { wrote: event.payload.id };
    });
    return a;
  }
}

export default {
  async fetch(req: Request, env: SmokeEnv): Promise<Response> {
    const url = new URL(req.url);
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/api/bindings") {
      return json({
        DB: typeof env.DB?.prepare,
        SESSION_QUEUE: typeof env.SESSION_QUEUE?.send,
        SESSION_WORKFLOW: typeof env.SESSION_WORKFLOW?.create,
        ASSETS: typeof env.ASSETS?.fetch,
      });
    }
    if (url.pathname === "/api/d1") {
      const r = await env.DB.prepare("SELECT count(*) AS n FROM smoke_log").first<{ n: number }>();
      const rows = await env.DB.prepare("SELECT kind, ref FROM smoke_log ORDER BY rowid").all();
      return json({ count: r?.n, rows: rows.results });
    }
    if (url.pathname === "/api/queue") {
      const id = url.searchParams.get("id") ?? "q1";
      await env.SESSION_QUEUE.send({ id });
      return json({ sent: id }, 202);
    }
    if (url.pathname === "/api/workflow") {
      const id = url.searchParams.get("id") ?? "w1";
      const inst = await env.SESSION_WORKFLOW.create({ id, params: { id } });
      return json({ instance: inst.id }, 202);
    }
    if (url.pathname.startsWith("/api/workflow/")) {
      const inst = await env.SESSION_WORKFLOW.get(url.pathname.split("/").pop()!);
      return json(await inst.status());
    }
    if (url.pathname.startsWith("/auth/")) return json({ worker: true, path: url.pathname });
    return json({ error: "not found" }, 404);
  },

  async queue(batch: MessageBatch<{ id: string }>, env: SmokeEnv): Promise<void> {
    for (const m of batch.messages) {
      await env.DB.prepare("INSERT INTO smoke_log (kind, ref) VALUES ('queue', ?)").bind(m.body.id).run();
      m.ack();
    }
  },

  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<SmokeEnv, { id: string }>;
