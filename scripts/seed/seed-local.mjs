#!/usr/bin/env node
// Seeds SYNTHETIC demo data into a local `wrangler dev` worker.
// Usage: node scripts/seed/seed-local.mjs [baseUrl] [variant]
const base = process.argv[2] ?? process.env.SEED_BASE_URL ?? "http://localhost:8787";
const variant = process.argv[3];
const origin = new URL(base).origin;
const identity = "demo.provider@example.invalid";

const login = await fetch(`${base}/auth/dev-login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ identity }),
});
if (!login.ok) {
  console.error(`dev-login failed: ${login.status} ${await login.text()}`);
  process.exit(1);
}
const cookies = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""])
  .filter(Boolean)
  .map((c) => c.split(";")[0])
  .join("; ");

const res = await fetch(`${base}/api/dev/seed`, {
  method: "POST",
  headers: { "content-type": "application/json", origin, cookie: cookies },
  body: JSON.stringify(variant ? { variant } : {}),
});
const text = await res.text();
console.log(`POST /api/dev/seed -> ${res.status}`);
console.log(text);
if (!res.ok) process.exit(1);
