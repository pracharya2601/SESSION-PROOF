# Runbook — vexo-field-assistant

One Cloudflare Worker (Hono API + cron + queue consumer + `SessionWorkflow`), one D1 database, one Queue, one Workflow, and the React UI served as static assets. Package manager: **npm** (one lockfile: `package-lock.json`). Toolchain: wrangler 4.86, vite 6, vitest 3, TypeScript 5.9.

## Bindings (frozen, handoff §6.3)

| Binding | Kind | Name in `wrangler.jsonc` |
|---|---|---|
| `DB` | D1 | `vexo-field-assistant` (migrations in `migrations/`) |
| `SESSION_QUEUE` | Queue producer + consumer | `vexo-session-processing` |
| `SESSION_WORKFLOW` | Workflow | `vexo-session-workflow`, class `SessionWorkflow` |
| `ASSETS` | Static assets | `dist/client`, SPA fallback, `run_worker_first: ["/api/*", "/auth/*", "/__scheduled"]` |

Vars: `EVIDENCE_MODE`, `EXTRACTION_MODE` (`fixture`/`live`), `AI_MODEL`, optional `AI_GATEWAY_URL`, `AUTH_MODE` (`dev`/`access`), `APP_ORIGIN`, `RUNTIME_MODE` (`local`/`deployed`), optional `FIXTURE_VARIANT`.
Secrets: `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AI_API_KEY` (only for live extraction).

## 1. Setup

```sh
npm ci
cp .dev.vars.example .dev.vars     # synthetic dev-only values; .dev.vars is gitignored
npm run smoke:platform             # optional: proves local D1/Queue/Workflow/assets work (port 8799)
```

Edit `.dev.vars` by hand if you need different values. Do not paste real keys into chat, logs, or committed files. To use live extraction locally, add `AI_API_KEY=...` to `.dev.vars` and set `EXTRACTION_MODE=live` there. Values in `.dev.vars` override `vars`.

## 2. Local run

```sh
npm run db:migrate:local   # applies migrations/*.sql to the local D1 in .wrangler/state
npm run db:seed:local      # loads the canonical demo data (scripts/seed/seed-local.mjs)
npm run dev                # vite build -> dist/client, then wrangler dev on http://localhost:8787
```

- UI hot reload: run `npm run dev` in one terminal and `npm run dev:ui` (vite on :5173, which proxies `/api` and `/auth` to :8787) in another.
- Cron locally: `npx wrangler dev --port 8787 --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` (prints "Ran scheduled event"). `/__scheduled` is listed in `assets.run_worker_first`, otherwise the SPA fallback swallows it. `/cdn-cgi/handler/scheduled` returns 500 under wrangler 4.86 with assets — use `/__scheduled`.
- Sync schedule: the cron is a fixed 5-minute heartbeat. Each provider sets on/off, interval (5 min – 1 day) and lookback days in the UI ("Automatic sync" on the Today page) or via `GET/PUT /api/settings/sync`; stored in `provider_sync_settings` (migration 0002). The heartbeat runs discovery only for providers who are due; delivery recovery runs every heartbeat regardless. Manual "Sync now" is scoped to the signed-in provider.
- Reset the demo session: Review page → **Reset demo session (dev)** (or `POST /api/dev/reset-session/:id`). Full reset: stop dev, delete `.wrangler/state`, then migrate and seed again.

| Script | Does |
|---|---|
| `dev` | build UI, then `wrangler dev --port 8787` |
| `dev:ui` | vite dev server for the UI only |
| `build` | `vite build` + `wrangler deploy --dry-run --outdir .wrangler/dry-run` (bundles the Worker and validates config) |
| `typecheck` | `tsc --noEmit` |
| `test` / `test:unit` / `test:integration` | vitest (all / `tests/unit` + `src` + `fixtures` / `tests/integration`) |
| `test:e2e` | `node scripts/e2e/demo.mjs`, run against the dev server |
| `db:migrate:local` / `db:migrate:remote` | D1 migrations, local or remote |
| `db:seed:local` | demo seed |
| `smoke:platform` | throwaway toolchain smoke test (`scripts/platform/smoke.sh`) |
| `deploy` | typecheck + build + `wrangler deploy` |

Tests run in node. `cloudflare:workers` is aliased to `scripts/platform/cloudflare-workers-stub.ts`, so test Workflow logic through `runSessionWorkflow` with a fake `StepLike`, not through workerd.

### What was verified locally (wrangler 4.86.0, `npm run smoke:platform`)

- All four bindings resolve in `wrangler dev` as `local` (D1, Queue, Workflow, Assets).
- D1: `wrangler d1 migrations apply --local` applies the SQL, and the Worker reads and writes it.
- Queue: `send()` is delivered to the `queue()` handler in the same dev process within about 1s, and the handler writes to D1.
- Workflow: `create()` → `step.do` runs → `status()` returns `complete` with output. Local status also includes a `__LOCAL_DEV_STEP_OUTPUTS` field.
- Assets: `/` and unknown non-API paths return the SPA shell. `/api/unknown` returns the Worker's 404 JSON instead of the SPA shell, and `/auth/*` reaches the Worker.
- No warnings were printed. The only notice was "update available".

## 3. Deploy

The full step-by-step guide is **[docs/deploy.md](deploy.md)**. It covers the plan and costs, provisioning, Access (login app plus bypass app), secrets, remote data, deploy, pairing the phone, smoke test and rollback. In short:

```sh
npx wrangler login
bash scripts/platform/provision.sh --apply             # D1 + Queue; prints database_id (dry run without --apply)
# edit wrangler.jsonc env.production: database_id, ingress (route or workers_dev), APP_ORIGIN / PUBLIC_APP_ORIGIN / PUBLIC_STREAM_ORIGIN
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET --env production
npx wrangler secret put TOKEN_ENCRYPTION_KEY --env production
npx wrangler secret put DEEPGRAM_API_KEY --env production
node scripts/platform/preflight.mjs --secrets --full   # PASS/TODO/FAIL checklist; exit 1 while anything is open
npm run deploy
```

- `env.production` repeats every binding, because bindings and vars are not inherited by an environment.
- Its `assets.run_worker_first` is `["/api/*", "/auth/*"]`. `/__scheduled` is a `wrangler dev --test-scheduled` route only, so it is left out.
- `observability` is on.
- The Workflow is created by `wrangler deploy`; it has no separate create command.
- Security-review H2 is fixed: the Worker verifies the Access JWT (`src/security/access-jwt.ts`) and never trusts the plain email header. Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, every Access route returns 503 (deploy.md §5.4).
- Preflight: `npm run preflight -- --secrets --full`. Its tests: `node --test scripts/platform/preflight.test.mjs`.

### Current deployment (2026-11-14)

| | |
|---|---|
| URL | `https://field-assist.prakashacharya.com` (custom domain; workers.dev off) |
| Worker | `vexo-field-assistant-production` on account `08bf6d58600c6d6b8e0734803d477859` (pinned as `env.production.account_id`) |
| Version | `357c72ff-262e-4b78-89cc-032d964eca64` (2nd deploy, adds review links; rollback target: `df459afc-cb54-4dbe-9931-07feb7af28b1`) |
| D1 | `vexo-field-assistant` `fcbf44f5-578d-4f77-ac63-145148582b86`, migrations 0001–0009 applied |
| Access | **not set up yet**: web UI/API return 503 `AUTH_NOT_CONFIGURED`. Steps: deploy.md §5.3 |

Operator tools for the deployed DB (no Access session needed; they use your wrangler login):

```sh
SEED_IDENTITY=you@example.com npx vite-node scripts/platform/remote-seed.ts -- --apply   # provider + C-104 + template appointment (synthetic)
node scripts/platform/pair-device-remote.mjs --out <file> --name "iPhone"               # key + pairing link go to <file> (0600), never printed
node scripts/platform/pair-device-remote.mjs --revoke dev_…                             # key stops working at once
DEVICE_KEY=vfad_… BASE_URL=https://<host> npm run smoke:deployed -- <packets.bin> C-104 # end-to-end band visit with real audio
```

### Prerequisites checklist (§17.4)

- [ ] Build passes (`npm run build`).
- [ ] Typecheck passes (`npm run typecheck`).
- [ ] Migration applied to the intended environment (`npx wrangler d1 migrations list vexo-field-assistant --remote`).
- [ ] Required bindings exist (D1 id pasted, queue created; `wrangler deploy` output lists DB, SESSION_QUEUE, SESSION_WORKFLOW, ASSETS).
- [ ] Required secrets exist (`npx wrangler secret list --env production`: SESSION_SECRET, TOKEN_ENCRYPTION_KEY, DEEPGRAM_API_KEY).
- [ ] API/auth routes are not swallowed by SPA fallback (`curl -i $ORIGIN/api/health` returns JSON, not HTML).
- [ ] OAuth callback origin matches `APP_ORIGIN` if evidence is live.
- [ ] Access control protects the deployed application (`AUTH_MODE=access`, login app + bypass app, `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` set; deploy.md §5). Forged-header test returns 401, or 503 while Access is unconfigured, never 404 (deploy.md §9.3).
- [ ] `EVIDENCE_MODE` explicitly configured.
- [ ] `EXTRACTION_MODE` explicitly configured.
- [ ] Release checks have evidence or are clearly marked unverified.
- [ ] Known-good deployment or rollback path recorded (`npx wrangler deployments list`, `npx wrangler rollback <version-id>`).

### Deployed smoke check (§17.5)

A successful deploy command does not prove the app works. With `ORIGIN=https://<your-host>`:

1. Open `$ORIGIN/` and confirm the UI renders.
2. Confirm asset paths: no 404s in devtools, and `/assets/*.js` returns JavaScript.
3. `curl -s $ORIGIN/api/health` returns a `{ data, correlationId }` envelope.
4. Call a protected read endpoint with auth: `GET /api/sessions` returns 200.
5. Call the same endpoint without auth and confirm it returns 401/403 with `{ error }`.
6. Seed or select controlled demo data through an operator path.
7. `POST /api/sync` returns 202.
8. Verify actual Queue and Workflow progression in `npx wrangler tail` and in the Workflows dashboard or `npx wrangler workflows instances list vexo-session-workflow`.
9. Load the generated review bundle: `GET /api/sessions/:id`.
10. Save corrections: `PATCH /api/sessions/:id/review`.
11. Confirm the revised amount.
12. Approve: `POST /api/sessions/:id/approve` returns 202 or 200.
13. Observe completion (status finalized).
14. Export: `GET /api/sessions/:id/export?format=json` and `?format=html`.
15. Compare revision and mode metadata in the export with the UI badges.
16. Check `npx wrangler tail` output for redaction: no tokens, secrets, or raw personal data.

### Rollback (§17.6)

Run `npx wrangler deployments list --env production`, then `npx wrangler rollback <version-id> --env production` (details: deploy.md §10). Do not run destructive schema rollbacks, and do not delete records to save a demo; prefer an isolated demo database. If the deployment is not repaired by M18, demo from the tested local build and state the limitation.
