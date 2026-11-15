/**
 * CLI: npm run eval:ai [-- --mode fake|demo|live] [--provider openai] [--model gpt-4.1]
 *        [--cases a,b] [--concurrency 2] [--max-cost 2] [--dry-run] [--price-in N --price-out N] [--no-write]
 *        [--shim-max-completion-tokens]   (live, eval-only: force max_completion_tokens; the adapter already sends it for gpt-5 and o-series models)
 * Args arrive via AI_EVAL_ARGS (JSON) from scripts/ai-eval.mjs, or argv.
 * Keys are read from process.env or .dev.vars and NEVER printed or written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AI_DEFAULT_MODELS, AiProviderId } from "../src/contracts/v2";
import type { Env } from "../src/env";
import { apiKeyFor } from "../src/ai/providers";
import { estimateLiveCost, runEval, type EvalMode } from "./harness";
import { consoleTable, markdown } from "./lib/report";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out[k] = argv[++i]!;
    else out[k] = true;
  }
  return out;
}

function readDevVars(): Record<string, string> {
  const p = join(ROOT, ".dev.vars");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const KEY_NAMES = ["ANTHROPIC_API_KEY", "AI_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "AI_GATEWAY_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL", "MISTRAL_BASE_URL"] as const;

async function main() {
  const raw = process.env.AI_EVAL_ARGS ? (JSON.parse(process.env.AI_EVAL_ARGS) as string[]) : process.argv.slice(2);
  const a = parseArgs(raw);
  const mode = (typeof a.mode === "string" ? a.mode : "fake") as EvalMode;
  if (!["fake", "demo", "live"].includes(mode)) throw new Error(`unknown --mode ${String(a.mode)}`);
  const dev = readDevVars();
  const envVal = (k: string) => process.env[k] ?? dev[k];
  const provParsed = AiProviderId.safeParse(typeof a.provider === "string" ? a.provider : envVal("AI_PROVIDER") ?? "anthropic");
  if (!provParsed.success) throw new Error(`unknown --provider ${String(a.provider)}`);
  const provider = provParsed.data;
  const model = typeof a.model === "string" ? a.model : (mode === "live" ? envVal("AI_MODEL") : undefined) ?? AI_DEFAULT_MODELS[provider][0]!;
  const cases = typeof a.cases === "string" ? a.cases.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const price = { in: typeof a["price-in"] === "string" ? Number(a["price-in"]) : undefined, out: typeof a["price-out"] === "string" ? Number(a["price-out"]) : undefined };
  const concurrency = typeof a.concurrency === "string" ? Number(a.concurrency) : undefined;

  const env: Partial<Env> = {};
  if (mode === "live") {
    for (const k of KEY_NAMES) {
      const v = envVal(k);
      if (v && v.trim()) (env as Record<string, string>)[k] = v.trim();
    }
    if (!apiKeyFor(env as Env, provider)) {
      console.error(`Refusing to run live: no API key for ${provider} in the environment or .dev.vars (see docs/ai-evaluation.md).`);
      process.exit(2);
    }
    if (envVal("EXTRACTION_MODE") !== "live") console.warn("note: .dev.vars EXTRACTION_MODE is not 'live' (the app itself will not call the model; the eval does anyway).");
    const est = estimateLiveCost(model, cases, price);
    const maxCost = typeof a["max-cost"] === "string" ? Number(a["max-cost"]) : 1;
    console.log(
      `Live eval: ${provider} ${model}, ${est.calls} model call(s) over ${est.cases} case(s), ~${est.inputTokens} in / ~${est.outputTokens} out tokens.\n` +
        `Estimated cost: ~$${est.expectedUsd.toFixed(3)} (worst case with retries ~$${est.worstCaseUsd.toFixed(3)}) at $${est.price.in}/$${est.price.out} per MTok${est.priceKnown ? " (approx. list price)" : " (UNKNOWN model: conservative default)"}.`,
    );
    if (est.worstCaseUsd > maxCost) {
      console.error(`Worst-case estimate exceeds --max-cost ${maxCost}. Re-run with a higher --max-cost to proceed.`);
      process.exit(3);
    }
    if (a["dry-run"]) return;
  }

  const shimMaxCompletionTokens = a["shim-max-completion-tokens"] === true;
  const report = await runEval({ mode, provider, model, env, cases, concurrency, price, shimMaxCompletionTokens });
  console.log(consoleTable(report));
  const s = report.summary;
  console.log(
    `\ncitation validity ${s.citationValidity === null ? "—" : (s.citationValidity * 100).toFixed(1) + "%"} · goal recall ${s.goalRecall === null ? "—" : (s.goalRecall * 100).toFixed(1) + "%"} · forbidden leaked ${s.forbiddenLeaked}/${s.forbiddenHits} · PII leaked ${s.piiLeaked.length}/${s.piiPlanted} · injection resisted ${s.injectionResisted}/${s.injectionCases} · cost ~$${s.perf.costUsd.toFixed(4)}`,
  );
  const probeMiss = Object.entries(s.probes).filter(([, v]) => v.caught < v.total).map(([k, v]) => `${k} ${v.caught}/${v.total}`);
  console.log(`validator probes missed: ${probeMiss.join(", ") || "none"}`);
  if (!a["no-write"]) {
    const dir = join(ROOT, "evals", "reports");
    mkdirSync(dir, { recursive: true });
    const tag = `${report.generatedAt.replace(/[:.]/g, "-")}-${mode}${mode === "demo" ? "" : `-${provider}-${model}`}${shimMaxCompletionTokens ? "-shim" : ""}`.replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileSync(join(dir, `${tag}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(dir, `${tag}.md`), markdown(report));
    console.log(`\nreport: evals/reports/${tag}.json\nsummary: evals/reports/${tag}.md`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
