#!/usr/bin/env node
// npm run eval:ai [-- --mode fake|demo|live --provider openai --model gpt-4.1 ...]
// Runs evals/run.ts under vite-node (TypeScript + the vitest alias config). Arguments are
// passed through AI_EVAL_ARGS so vite-node's own flags (e.g. --mode) never swallow them.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "vite-node.cmd" : "vite-node");
const r = spawnSync(bin, ["-c", "vitest.config.ts", "evals/run.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, AI_EVAL_ARGS: JSON.stringify(process.argv.slice(2)) },
});
process.exit(r.status ?? 1);
