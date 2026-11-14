/**
 * Minimal SYNTHETIC seed for the deployed D1 (env.production). The deployed Worker never seeds.
 *
 * Writes exactly: one provider (id provider_demo_001, identity = your Access login email),
 * the demo service config, the demo client C-104 ("Sam Rivera (synthetic)") and one past
 * template appointment for it (band visits copy their service plan from it). Nothing is copied
 * from a local database. Statements come from the real repository code (src/db/d1.ts) run
 * against a recording D1 stub, so they always match the schema.
 *
 *   SEED_IDENTITY=you@example.com npx vite-node scripts/platform/remote-seed.ts            # print SQL path
 *   SEED_IDENTITY=you@example.com npx vite-node scripts/platform/remote-seed.ts -- --apply # + d1 execute --remote
 *
 * Re-running is safe (all upserts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRepository } from "../../src/db/d1";
import { demoClientInput } from "../../src/calendar/seed";
import { DEMO_PROVIDER_ID, demoAppointment, demoConfig } from "../../fixtures/scenario";

const DB_NAME = "vexo-field-assistant";
const OUT = ".wrangler/remote-seed.sql";

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function recordingDb(statements: string[]): D1Database {
  const prepare = (sql: string) => {
    const bound = (args: unknown[]) => {
      let i = 0;
      const text = sql.replace(/\?/g, () => literal(args[i++]));
      if (i !== args.length) throw new Error("bind count mismatch");
      const push = () => statements.push(`${text.trim().replace(/\s+RETURNING \*$/, "")};`);
      return {
        run: async () => {
          push();
          return { success: true, meta: { changes: 1 } };
        },
        // The client upsert reads its row back (RETURNING *); give it one so no read is needed.
        first: async () => {
          if (/^\s*SELECT/i.test(text)) return null;
          push();
          return null;
        },
        all: async () => ({ results: [] }),
      };
    };
    return {
      bind: (...args: unknown[]) => bound(args),
      run: () => bound([]).run(),
      first: () => bound([]).first(),
      all: () => bound([]).all(),
    };
  };
  return { prepare } as unknown as D1Database;
}

async function main() {
  const identity = process.env.SEED_IDENTITY?.trim().toLowerCase();
  if (!identity || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identity)) {
    console.error("Set SEED_IDENTITY to the email you sign in with through Cloudflare Access.");
    process.exit(2);
  }
  const statements: string[] = [];
  const repo = createRepository(recordingDb(statements));
  await repo.upsertProvider(DEMO_PROVIDER_ID, identity);
  await repo.upsertServiceConfig(demoConfig.plan.serviceCode, demoConfig);
  await repo.upsertAppointment(demoAppointment);
  try {
    await repo.upsertClient(DEMO_PROVIDER_ID, demoClientInput, new Date());
  } catch (err) {
    // getClient read-back after the INSERT (stub returns no row); the INSERT is recorded.
    if (!(err instanceof Error) || err.message !== "client upsert failed") throw err;
  }
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(OUT, `-- SYNTHETIC remote seed (scripts/platform/remote-seed.ts)\n${statements.join("\n")}\n`, { mode: 0o600 });
  console.log(`wrote ${statements.length} statements to ${OUT} (client ${demoAppointment.clientRef}, appointment ${demoAppointment.id} at ${demoAppointment.startAt})`);
  if (process.argv.includes("--apply")) {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", DB_NAME, "--remote", "--env", "production", "--file", OUT, "-y"], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }
}

void main();
