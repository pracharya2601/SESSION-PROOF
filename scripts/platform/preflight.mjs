#!/usr/bin/env node
// Offline deploy preflight for env.production. Reads wrangler.jsonc, migrations/ and a few
// source files; creates nothing, deploys nothing, never prints secret values.
//
//   node scripts/platform/preflight.mjs             # config checks only (offline)
//   node scripts/platform/preflight.mjs --secrets   # + `wrangler secret list --env production` (read-only, needs login)
//   node scripts/platform/preflight.mjs --full      # + typecheck, tests, build, production dry-run
//   node scripts/platform/preflight.mjs --json      # machine-readable result
//   --access-confirmed                               # you have set up the Access apps (§5); marks that item PASS
//
// Exit code: 0 when every item is PASS, 1 when anything is TODO or FAIL.
//   PASS  ready
//   TODO  a decision or a step the operator still has to do (placeholder, secret, Access)
//   FAIL  the config or the build is wrong
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENV_NAME = "production";
export const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";
export const REQUIRED_SECRETS = ["SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "DEEPGRAM_API_KEY"];
/** Any one of these satisfies live extraction (src/env.ts). */
export const AI_KEY_SECRETS = ["AI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY"];
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net|invalid)$|^localhost$|^127\.|\.localhost$|<|>/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ JSONC
/** Parse JSON with // and /* *\/ comments and trailing commas. Strings are respected. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new SyntaxError("Unterminated block comment");
      i = end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Then drop trailing commas (`,` + whitespace + `}`/`]`), again skipping string contents.
  return JSON.parse(stripTrailingCommas(out));
}

function stripTrailingCommas(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ------------------------------------------------------------------ checks
const item = (status, name, detail) => ({ status, name, detail });

function originOf(raw, protocols) {
  try {
    const u = new URL(raw);
    if (!protocols.includes(u.protocol) || !u.host) return null;
    return { protocol: u.protocol, host: u.host, hostname: u.hostname, clean: u.pathname === "/" && !u.search && !u.hash };
  } catch {
    return null;
  }
}

/**
 * Pure config checks. `ctx`: { migrations: string[], indexSource?: string, securitySource?: string,
 * assetsDirExists?: boolean, migrationsDirExists?: boolean }.
 */
export function checkConfig(config, ctx = {}) {
  const items = [];
  const env = config?.env?.[ENV_NAME];
  if (!env) return [item("FAIL", "env.production block", "wrangler.jsonc has no env.production")];
  items.push(item("PASS", "env.production block", "present"));

  // vars
  const vars = env.vars ?? {};
  items.push(
    vars.AUTH_MODE === "access"
      ? item("PASS", "AUTH_MODE", "access")
      : item("FAIL", "AUTH_MODE", `must be "access" in production (is ${JSON.stringify(vars.AUTH_MODE)})`),
  );
  items.push(
    vars.RUNTIME_MODE === "deployed"
      ? item("PASS", "RUNTIME_MODE", "deployed")
      : item("FAIL", "RUNTIME_MODE", `must be "deployed" (is ${JSON.stringify(vars.RUNTIME_MODE)})`),
  );
  for (const k of ["EVIDENCE_MODE", "EXTRACTION_MODE"]) {
    const v = vars[k];
    items.push(
      v === "fixture" || v === "live"
        ? item("PASS", k, v)
        : item("FAIL", k, `must be set explicitly to "fixture" or "live" (is ${JSON.stringify(v)})`),
    );
  }
  if (vars.EVIDENCE_MODE === "live") {
    items.push(item("TODO", "EVIDENCE_MODE=live", "no live Vexo MCP client is wired; calendar discovery will fail with not_configured"));
  }

  const app = originOf(vars.APP_ORIGIN ?? "", ["https:"]);
  if (!app || !app.clean) {
    items.push(item("FAIL", "APP_ORIGIN", `must be a bare https:// origin (is ${JSON.stringify(vars.APP_ORIGIN)})`));
  } else if (PLACEHOLDER_HOST.test(app.hostname)) {
    items.push(item("TODO", "APP_ORIGIN", `placeholder host "${app.hostname}": set the real custom domain or workers.dev host`));
  } else {
    items.push(item("PASS", "APP_ORIGIN", `https://${app.host}`));
  }
  const pubApp = vars.PUBLIC_APP_ORIGIN === undefined ? undefined : originOf(vars.PUBLIC_APP_ORIGIN, ["https:"]);
  if (pubApp === undefined) {
    items.push(item("PASS", "PUBLIC_APP_ORIGIN", "unset (pairing link falls back to PUBLIC_STREAM_ORIGIN / APP_ORIGIN)"));
  } else if (!pubApp) {
    items.push(item("FAIL", "PUBLIC_APP_ORIGIN", "must be https:// in production (the phone reaches the Worker over the internet)"));
  } else if (app && pubApp.host !== app.host) {
    items.push(item("FAIL", "PUBLIC_APP_ORIGIN", `host ${pubApp.host} differs from APP_ORIGIN host ${app.host}`));
  } else {
    items.push(item("PASS", "PUBLIC_APP_ORIGIN", `https://${pubApp.host}`));
  }
  const pubWs = vars.PUBLIC_STREAM_ORIGIN === undefined ? undefined : originOf(vars.PUBLIC_STREAM_ORIGIN, ["wss:"]);
  if (pubWs === undefined) {
    items.push(item("PASS", "PUBLIC_STREAM_ORIGIN", "unset (streamUrl uses the request host)"));
  } else if (!pubWs) {
    items.push(item("FAIL", "PUBLIC_STREAM_ORIGIN", "must be wss:// in production (ws:// would be refused by iOS ATS and sends the token in clear)"));
  } else if (app && pubWs.host !== app.host) {
    items.push(item("FAIL", "PUBLIC_STREAM_ORIGIN", `host ${pubWs.host} differs from APP_ORIGIN host ${app.host}`));
  } else {
    items.push(item("PASS", "PUBLIC_STREAM_ORIGIN", `wss://${pubWs.host}`));
  }

  // ingress
  const routes = Array.isArray(env.routes) ? env.routes : env.route ? [env.route] : [];
  const workersDev = env.workers_dev === true;
  if (routes.length === 0 && !workersDev) {
    items.push(item("TODO", "Ingress", "no routes and workers_dev false: the Worker would have no URL. Choose a custom domain route or workers_dev: true (docs/deploy.md §4)"));
  } else if (routes.length > 0 && workersDev) {
    items.push(item("TODO", "Ingress", "both a route and workers.dev are enabled: two hostnames, both need their own Access application. Prefer one"));
  } else {
    const routeHosts = routes.map((r) => (typeof r === "string" ? r : r.pattern ?? "").replace(/\/.*$/, ""));
    const placeholder = routeHosts.find((h) => PLACEHOLDER_HOST.test(h));
    if (placeholder) items.push(item("TODO", "Ingress", `route host "${placeholder}" is a placeholder`));
    else if (app && routeHosts.length && !routeHosts.includes(app.hostname)) {
      items.push(item("FAIL", "Ingress", `route host(s) ${routeHosts.join(", ")} do not match APP_ORIGIN host ${app.hostname}`));
    } else if (workersDev && app && !app.hostname.endsWith(".workers.dev")) {
      items.push(item("FAIL", "Ingress", "workers_dev is true but APP_ORIGIN is not a *.workers.dev host"));
    } else {
      items.push(item("PASS", "Ingress", workersDev ? "workers.dev" : `route(s): ${routeHosts.join(", ")}`));
    }
  }
  items.push(
    env.preview_urls === false
      ? item("PASS", "preview_urls", "false (no unprotected preview hostnames)")
      : item("FAIL", "preview_urls", "set preview_urls: false so no second hostname bypasses Access"),
  );

  // assets
  const assets = env.assets ?? config.assets;
  const rwf = assets?.run_worker_first;
  if (!assets) items.push(item("FAIL", "Assets", "no assets binding"));
  else if (!Array.isArray(rwf) || !rwf.includes("/api/*") || !rwf.includes("/auth/*")) {
    items.push(item("FAIL", "Assets run_worker_first", 'must list "/api/*" and "/auth/*" or the SPA fallback swallows them'));
  } else if (rwf.includes("/__scheduled")) {
    items.push(item("TODO", "Assets run_worker_first", '"/__scheduled" is a wrangler-dev test route; drop it from production'));
  } else {
    items.push(item("PASS", "Assets run_worker_first", rwf.join(", ")));
  }
  if (ctx.assetsDirExists === false) {
    items.push(item("TODO", "Assets build", `${assets?.directory ?? "dist/client"} missing: run npm run build`));
  }

  // D1
  const d1 = (env.d1_databases ?? []).find((d) => d.binding === "DB");
  if (!d1) items.push(item("FAIL", "D1 binding DB", "missing in env.production"));
  else if (!d1.database_id || d1.database_id === PLACEHOLDER_DB_ID) {
    items.push(item("TODO", "D1 database_id", "placeholder: run provision.sh --apply and paste the id"));
  } else if (!UUID.test(d1.database_id)) {
    items.push(item("FAIL", "D1 database_id", "not a UUID"));
  } else items.push(item("PASS", "D1 database_id", d1.database_id));
  if (d1 && ctx.migrationsDirExists === false) items.push(item("FAIL", "D1 migrations_dir", `${d1.migrations_dir} not found`));

  // migrations
  const migs = [...(ctx.migrations ?? [])].sort();
  const bad = migs.filter((m, i) => !m.startsWith(String(i + 1).padStart(4, "0") + "_"));
  if (migs.length === 0) items.push(item("FAIL", "Migrations", "no migrations/*.sql found"));
  else if (bad.length) items.push(item("FAIL", "Migrations", `numbering gap or duplicate near ${bad[0]}`));
  else {
    items.push(
      item("PASS", "Migrations", `${migs.length} files (${migs[0]} … ${migs[migs.length - 1]}); apply with npm run db:migrate:remote`),
    );
  }

  // queue
  const prod = (env.queues?.producers ?? []).find((p) => p.binding === "SESSION_QUEUE");
  const cons = env.queues?.consumers ?? [];
  if (!prod) items.push(item("FAIL", "Queue producer SESSION_QUEUE", "missing"));
  else if (!cons.some((c) => c.queue === prod.queue)) {
    items.push(item("FAIL", "Queue consumer", `no consumer for "${prod.queue}" (messages would pile up)`));
  } else items.push(item("PASS", "Queue producer + consumer", prod.queue));

  // workflow
  const wf = (env.workflows ?? []).find((w) => w.binding === "SESSION_WORKFLOW");
  if (!wf) items.push(item("FAIL", "Workflow SESSION_WORKFLOW", "missing"));
  else if (ctx.indexSource !== undefined && !new RegExp(`export\\s*\\{[^}]*\\b${wf.class_name}\\b`).test(ctx.indexSource)) {
    items.push(item("FAIL", "Workflow class", `${wf.class_name} is not exported from the main module`));
  } else items.push(item("PASS", "Workflow", `${wf.name} (${wf.class_name})`));

  // cron + observability
  const crons = env.triggers?.crons ?? [];
  items.push(crons.length ? item("PASS", "Cron", crons.join(", ")) : item("FAIL", "Cron", "no triggers.crons (no discovery / delivery recovery)"));
  items.push(
    env.observability?.enabled === true
      ? item("PASS", "Observability", "Workers Logs enabled")
      : item("TODO", "Observability", "set observability.enabled: true to see logs after deploy"),
  );

  // Access JWT verification (security-review H2)
  if (ctx.securitySource !== undefined) {
    const verifies = /cloudflareaccess\.com\/cdn-cgi\/access\/certs|jwtVerify|ACCESS_AUD/.test(ctx.securitySource);
    const todo = /TODO\(production\): verify Cf-Access-Jwt-Assertion/.test(ctx.securitySource);
    if (verifies && !todo) {
      const missing = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"].filter((k) => !vars[k] || /</.test(String(vars[k])));
      items.push(
        missing.length
          ? item("TODO", "Access JWT verification", `implemented; set vars ${missing.join(", ")}`)
          : item("PASS", "Access JWT verification", "implemented and configured"),
      );
    } else {
      items.push(
        item("TODO", "Access JWT verification", "not implemented (security-review H2): bypassed paths let a forged Cf-Access-Authenticated-User-Email through. See docs/deploy.md §5.4"),
      );
    }
  }
  return items;
}

/** Compare required secrets with the names `wrangler secret list` returned. */
export function checkSecrets(names, vars = {}) {
  const have = new Set(names);
  const items = REQUIRED_SECRETS.map((s) =>
    have.has(s) ? item("PASS", `Secret ${s}`, "set") : item("TODO", `Secret ${s}`, `npx wrangler secret put ${s} --env ${ENV_NAME}`),
  );
  if (vars.EXTRACTION_MODE === "live") {
    const ai = AI_KEY_SECRETS.filter((s) => have.has(s));
    items.push(
      ai.length
        ? item("PASS", "AI key (EXTRACTION_MODE=live)", ai.join(", "))
        : item("TODO", "AI key (EXTRACTION_MODE=live)", `set one of ${AI_KEY_SECRETS.join(", ")}`),
    );
  }
  return items;
}

/** Secret names from `wrangler secret list --format json` output ([{name,type}]). */
export function parseSecretList(stdout) {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("no JSON array in wrangler output");
  const arr = JSON.parse(stdout.slice(start, stdout.lastIndexOf("]") + 1));
  return arr.map((s) => s.name).filter((n) => typeof n === "string");
}

// ------------------------------------------------------------------ runner
function sh(cmd, args, root) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" }, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function lastLines(text, n = 6) {
  return text.trim().split("\n").slice(-n).join(" | ");
}

export function loadContext(root) {
  const cfgPath = join(root, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(cfgPath, "utf8"));
  const env = config?.env?.[ENV_NAME] ?? {};
  const d1 = (env.d1_databases ?? []).find((d) => d.binding === "DB");
  const migDir = join(root, d1?.migrations_dir ?? "migrations");
  const assetsDir = join(root, (env.assets ?? config.assets)?.directory ?? "dist/client");
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : undefined);
  return {
    config,
    ctx: {
      migrations: existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")) : [],
      migrationsDirExists: existsSync(migDir),
      assetsDirExists: existsSync(assetsDir),
      indexSource: read(config.main ?? "src/index.ts"),
      securitySource: read("src/security/index.ts"),
    },
  };
}

export function main(argv = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")) {
  const flags = new Set(argv);
  const items = [];
  let config;
  try {
    const loaded = loadContext(root);
    config = loaded.config;
    items.push(item("PASS", "wrangler.jsonc parses", "JSONC with comments"));
    items.push(...checkConfig(config, loaded.ctx));
  } catch (err) {
    items.push(item("FAIL", "wrangler.jsonc parses", err instanceof Error ? err.message : String(err)));
  }
  const vars = config?.env?.[ENV_NAME]?.vars ?? {};

  if (flags.has("--secrets")) {
    const r = sh("npx", ["wrangler", "secret", "list", "--env", ENV_NAME, "--format", "json"], root);
    if (r.code !== 0) items.push(item("TODO", "Secrets", `could not list (not logged in, or the Worker is not deployed yet): ${lastLines(r.out, 2)}`));
    else {
      try {
        items.push(...checkSecrets(parseSecretList(r.out), vars));
      } catch (err) {
        items.push(item("FAIL", "Secrets", `unexpected wrangler output: ${err.message}`));
      }
    }
  } else {
    const needed = [...REQUIRED_SECRETS, ...(vars.EXTRACTION_MODE === "live" ? ["one AI key"] : [])];
    items.push(item("TODO", "Secrets", `not checked (add --secrets when logged in). Required: ${needed.join(", ")}`));
  }

  if (flags.has("--full")) {
    const steps = [
      ["Typecheck", "npm", ["run", "typecheck"]],
      ["Tests", "npm", ["test"]],
      ["Build (vite + default dry-run)", "npm", ["run", "build"]],
      ["Production dry-run", "npx", ["wrangler", "deploy", "--dry-run", "--env", ENV_NAME, "--outdir", ".wrangler/dry-run-prod"]],
    ];
    for (const [name, cmd, args] of steps) {
      const r = sh(cmd, args, root);
      items.push(r.code === 0 ? item("PASS", name, "ok") : item("FAIL", name, lastLines(r.out)));
    }
  } else {
    items.push(item("TODO", "Typecheck / tests / build", "not run (add --full)"));
  }
  items.push(
    flags.has("--access-confirmed")
      ? item("PASS", "Cloudflare Access", "operator confirmed: main app + bypass apps (docs/deploy.md §5)")
      : item("TODO", "Cloudflare Access", "manual: main app + bypass apps, docs/deploy.md §5; re-run with --access-confirmed once done"),
  );

  if (flags.has("--json")) {
    console.log(JSON.stringify({ items }, null, 2));
  } else {
    const width = Math.max(...items.map((i) => i.name.length));
    console.log(`Deploy preflight (env.${ENV_NAME})\n`);
    for (const i of items) console.log(`${i.status.padEnd(4)}  ${i.name.padEnd(width)}  ${i.detail}`);
    const counts = items.reduce((a, i) => ({ ...a, [i.status]: (a[i.status] ?? 0) + 1 }), {});
    console.log(`\n${counts.PASS ?? 0} PASS, ${counts.TODO ?? 0} TODO, ${counts.FAIL ?? 0} FAIL`);
  }
  return items.every((i) => i.status === "PASS") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
