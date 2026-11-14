// node --test scripts/platform/preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, checkSecrets, loadContext, parseJsonc, parseSecretList, PLACEHOLDER_DB_ID } from "./preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGS = ["0001_init.sql", "0002_x.sql"];
const INDEX = 'export { SessionWorkflow } from "./workflow";';

function goodConfig(overrides = {}) {
  const prod = {
    routes: [{ pattern: "field.acme.dev", custom_domain: true }],
    workers_dev: false,
    preview_urls: false,
    assets: { directory: "./dist/client", binding: "ASSETS", run_worker_first: ["/api/*", "/auth/*"] },
    d1_databases: [{ binding: "DB", database_name: "db", database_id: "1234abcd-1234-1234-1234-1234567890ab", migrations_dir: "migrations" }],
    queues: { producers: [{ binding: "SESSION_QUEUE", queue: "q" }], consumers: [{ queue: "q" }] },
    workflows: [{ binding: "SESSION_WORKFLOW", name: "wf", class_name: "SessionWorkflow" }],
    triggers: { crons: ["*/5 * * * *"] },
    observability: { enabled: true },
    vars: {
      AUTH_MODE: "access",
      RUNTIME_MODE: "deployed",
      EVIDENCE_MODE: "fixture",
      EXTRACTION_MODE: "fixture",
      APP_ORIGIN: "https://field.acme.dev",
      PUBLIC_APP_ORIGIN: "https://field.acme.dev",
      PUBLIC_STREAM_ORIGIN: "wss://field.acme.dev",
    },
    ...overrides,
  };
  return { main: "src/index.ts", env: { production: prod } };
}
const byName = (items, name) => items.find((i) => i.name === name);
const run = (cfg) => checkConfig(cfg, { migrations: MIGS, indexSource: INDEX });

test("parseJsonc: comments, trailing commas, and // or /* inside strings", () => {
  const v = parseJsonc(`{
    // line comment
    "a": "http://x/y", /* block */ "b": ["/api/*", "/*not a comment*/",],
    "c": "quote \\" // still string",
  }`);
  assert.deepEqual(v, { a: "http://x/y", b: ["/api/*", "/*not a comment*/"], c: 'quote " // still string' });
});

test("parseJsonc parses the real wrangler.jsonc", () => {
  const cfg = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  assert.equal(cfg.env.production.vars.AUTH_MODE, "access");
  assert.equal(cfg.env.production.vars.RUNTIME_MODE, "deployed");
});

test("a complete config is all PASS", () => {
  const items = run(goodConfig());
  assert.deepEqual(items.filter((i) => i.status !== "PASS"), []);
});

test("placeholders are TODO: database_id, example.com origin, no ingress", () => {
  const cfg = goodConfig({ routes: undefined });
  cfg.env.production.d1_databases[0].database_id = PLACEHOLDER_DB_ID;
  cfg.env.production.vars.APP_ORIGIN = "https://field-assist.example.com";
  cfg.env.production.vars.PUBLIC_APP_ORIGIN = "https://field-assist.example.com";
  cfg.env.production.vars.PUBLIC_STREAM_ORIGIN = "wss://field-assist.example.com";
  const items = run(cfg);
  assert.equal(byName(items, "D1 database_id").status, "TODO");
  assert.equal(byName(items, "APP_ORIGIN").status, "TODO");
  assert.equal(byName(items, "Ingress").status, "TODO");
});

test("dev auth or local runtime in production is FAIL", () => {
  const cfg = goodConfig();
  cfg.env.production.vars.AUTH_MODE = "dev";
  cfg.env.production.vars.RUNTIME_MODE = "local";
  const items = run(cfg);
  assert.equal(byName(items, "AUTH_MODE").status, "FAIL");
  assert.equal(byName(items, "RUNTIME_MODE").status, "FAIL");
});

test("origins must share one host, https + wss", () => {
  const cfg = goodConfig();
  cfg.env.production.vars.PUBLIC_STREAM_ORIGIN = "ws://field.acme.dev";
  cfg.env.production.vars.PUBLIC_APP_ORIGIN = "https://other.acme.dev";
  const items = run(cfg);
  assert.equal(byName(items, "PUBLIC_STREAM_ORIGIN").status, "FAIL");
  assert.equal(byName(items, "PUBLIC_APP_ORIGIN").status, "FAIL");
});

test("route host must match APP_ORIGIN; workers_dev needs a workers.dev origin", () => {
  assert.equal(byName(run(goodConfig({ routes: [{ pattern: "x.acme.dev", custom_domain: true }] })), "Ingress").status, "FAIL");
  assert.equal(byName(run(goodConfig({ routes: undefined, workers_dev: true })), "Ingress").status, "FAIL");
  const wd = goodConfig({ routes: undefined, workers_dev: true });
  for (const k of ["APP_ORIGIN", "PUBLIC_APP_ORIGIN"]) wd.env.production.vars[k] = "https://app.acme.workers.dev";
  wd.env.production.vars.PUBLIC_STREAM_ORIGIN = "wss://app.acme.workers.dev";
  assert.equal(byName(run(wd), "Ingress").status, "PASS");
});

test("/__scheduled in production run_worker_first is TODO; missing /api/* is FAIL", () => {
  const a = goodConfig();
  a.env.production.assets.run_worker_first = ["/api/*", "/auth/*", "/__scheduled"];
  assert.equal(byName(run(a), "Assets run_worker_first").status, "TODO");
  const b = goodConfig();
  b.env.production.assets.run_worker_first = ["/auth/*"];
  assert.equal(byName(run(b), "Assets run_worker_first").status, "FAIL");
});

test("queue without consumer, missing workflow export, migration gap are FAIL", () => {
  const cfg = goodConfig();
  cfg.env.production.queues.consumers = [];
  const items = checkConfig(cfg, { migrations: ["0001_a.sql", "0003_c.sql"], indexSource: "export default {}" });
  assert.equal(byName(items, "Queue consumer").status, "FAIL");
  assert.equal(byName(items, "Workflow class").status, "FAIL");
  assert.equal(byName(items, "Migrations").status, "FAIL");
});

test("Access JWT verification: TODO while the TODO marker is in src/security", () => {
  const cfg = goodConfig();
  const todo = checkConfig(cfg, { migrations: MIGS, securitySource: "// TODO(production): verify Cf-Access-Jwt-Assertion before trusting" });
  assert.equal(byName(todo, "Access JWT verification").status, "TODO");
  const implNoVars = checkConfig(cfg, { migrations: MIGS, securitySource: "jwtVerify(token, jwks, { audience: env.ACCESS_AUD })" });
  assert.match(byName(implNoVars, "Access JWT verification").detail, /ACCESS_TEAM_DOMAIN, ACCESS_AUD/);
  cfg.env.production.vars.ACCESS_TEAM_DOMAIN = "https://acme.cloudflareaccess.com";
  cfg.env.production.vars.ACCESS_AUD = "abc123";
  const impl = checkConfig(cfg, { migrations: MIGS, securitySource: "jwtVerify(token, jwks, { audience: env.ACCESS_AUD })" });
  assert.equal(byName(impl, "Access JWT verification").status, "PASS");
});

test("secrets: required list, AI key only for live extraction", () => {
  const items = checkSecrets(["SESSION_SECRET", "TOKEN_ENCRYPTION_KEY"], { EXTRACTION_MODE: "fixture" });
  assert.equal(byName(items, "Secret DEEPGRAM_API_KEY").status, "TODO");
  assert.equal(byName(items, "Secret SESSION_SECRET").status, "PASS");
  assert.equal(items.some((i) => i.name.startsWith("AI key")), false);
  const live = checkSecrets(["SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "DEEPGRAM_API_KEY", "OPENAI_API_KEY"], { EXTRACTION_MODE: "live" });
  assert.ok(live.every((i) => i.status === "PASS"));
});

test("parseSecretList reads wrangler JSON with banner noise", () => {
  const out = ' ⛅️ wrangler 4.86.0\n[\n  { "name": "SESSION_SECRET", "type": "secret_text" }\n]\n';
  assert.deepEqual(parseSecretList(out), ["SESSION_SECRET"]);
});

test("the repo's own config has no FAIL items (only operator TODOs)", () => {
  const { config, ctx } = loadContext(root);
  const fails = checkConfig(config, ctx).filter((i) => i.status === "FAIL");
  assert.deepEqual(fails, []);
});
