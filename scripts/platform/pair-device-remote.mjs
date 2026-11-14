#!/usr/bin/env node
// Operator pairing for the DEPLOYED Worker, for when the web UI (Settings → Devices) can't be
// used yet, e.g. before Cloudflare Access is set up. Inserts one paired_devices row into the
// remote D1 (env.production) with a freshly generated device key; only SHA-256(key) is stored,
// exactly like POST /api/devices.
//
// The key and the pairing link are written ONCE to --out (mode 0600) and never printed.
//
//   node scripts/platform/pair-device-remote.mjs --out <file> [--name "iPhone"] [--provider provider_demo_001]
//   node scripts/platform/pair-device-remote.mjs --revoke <dev_id>
//
// The file holds: DEVICE_KEY=…, DEVICE_ID=…, PAIRING_LINK=glasscam://pair?…
// Revoke later in Settings → Devices, or with --revoke.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./preflight.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_NAME = "vexo-field-assistant";
const MAX_ACTIVE = 10;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function d1(sql) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", DB_NAME, "--remote", "--env", "production", "--json", "--command", sql], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
  });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
  }
  const out = r.stdout;
  return JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1))[0]?.results ?? [];
}

function publicOrigin() {
  const cfg = parseJsonc(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"));
  const vars = cfg.env?.production?.vars ?? {};
  for (const [raw, map] of [
    [vars.PUBLIC_APP_ORIGIN, { "https:": "https:", "http:": "http:" }],
    [vars.PUBLIC_STREAM_ORIGIN, { "wss:": "https:", "ws:": "http:" }],
    [vars.APP_ORIGIN, { "https:": "https:", "http:": "http:" }],
  ]) {
    try {
      const u = new URL(raw);
      if (map[u.protocol]) return `${map[u.protocol]}//${u.host}`;
    } catch {
      /* next */
    }
  }
  throw new Error("no public origin in wrangler.jsonc env.production.vars");
}

function main() {
  const accountId = (() => {
    try {
      return parseJsonc(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8")).env?.production?.account_id;
    } catch {
      return undefined;
    }
  })();
  if (!process.env.CLOUDFLARE_ACCOUNT_ID && accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  const revokeId = arg("--revoke");
  if (revokeId) {
    if (!/^dev_[0-9a-f]{32}$/.test(revokeId)) throw new Error("--revoke expects a dev_… id");
    d1(`UPDATE paired_devices SET revoked_at = ${sqlString(new Date().toISOString())} WHERE id = ${sqlString(revokeId)} AND revoked_at IS NULL`);
    console.log(`revoked ${revokeId}`);
    return;
  }

  const out = arg("--out");
  if (!out) throw new Error("--out <file> is required (the key is written there, never printed)");
  if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite a key file`);
  const name = arg("--name", "iPhone").trim();
  if (!name || name.length > 60) throw new Error("--name must be 1–60 characters");
  const providerId = arg("--provider", "provider_demo_001");

  const prov = d1(`SELECT id FROM providers WHERE id = ${sqlString(providerId)}`);
  if (prov.length !== 1) throw new Error(`provider ${providerId} not found in the remote D1 (run scripts/platform/remote-seed.ts first)`);
  const active = d1(`SELECT COUNT(*) AS n FROM paired_devices WHERE provider_id = ${sqlString(providerId)} AND revoked_at IS NULL`);
  if (Number(active[0]?.n ?? 0) >= MAX_ACTIVE) throw new Error(`provider already has ${MAX_ACTIVE} active devices`);

  const key = `vfad_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const id = `dev_${randomUUID().replace(/-/g, "")}`;
  const createdAt = new Date().toISOString();
  d1(
    `INSERT INTO paired_devices (id, provider_id, name, key_hash, created_at) VALUES (${[id, providerId, name, keyHash, createdAt]
      .map(sqlString)
      .join(", ")})`,
  );
  const link = `glasscam://pair?server=${publicOrigin()}&key=${key}&name=${encodeURIComponent(name)}`;
  writeFileSync(out, `DEVICE_ID=${id}\nDEVICE_KEY=${key}\nPAIRING_LINK=${link}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`paired ${id} ("${name}") for ${providerId}; key + link written to ${out} (0600). Revoke: --revoke ${id}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
