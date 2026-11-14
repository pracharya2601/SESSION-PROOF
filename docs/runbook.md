# Runbook — vexo-field-assistant

One Cloudflare Worker (Hono API + cron + queue consumer + `SessionWorkflow`), one D1 database, one Queue, one Workflow, and the React UI served as static assets. Package manager: **npm** (one lockfile: `package-lock.json`). Toolchain: wrangler 4.86, vite 6, vitest 3, TypeScript 5.9.

## Bindings (frozen, handoff §6.3)

| Binding | Kind | Name in `wrangler.jsonc` |
|---|---|---|
| `DB` | D1 | `vexo-field-assistant` (migrations in `migrations/`) |
| `SESSION_QUEUE` | Queue producer + consumer | `vexo-session-processing` |
| `SESSION_WORKFLOW` | Workflow | `vexo-session-workflow`, class `SessionWorkflow` |
| `ASSETS` | Static assets | `dist/client`, SPA fallback, `run_worker_first: ["/api/*", "/auth/*"]` |

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
- Cron locally: `npx wrangler dev --port 8787 --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.
- Reset local state: stop dev, delete `.wrangler/state`, then migrate and seed again.

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

### Provision (once)

```sh
npx wrangler login
bash scripts/platform/provision.sh           # prints the commands (dry run)
bash scripts/platform/provision.sh --apply   # creates the D1 + Queue and prints database_id
```

Paste the printed `database_id` into `wrangler.jsonc`. For the deployed environment, set `APP_ORIGIN` to the real origin, `RUNTIME_MODE` to `"deployed"`, and `AUTH_MODE` to `"access"` (behind Cloudflare Access). Then run:

```sh
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET          # prompts; value is not echoed
npx wrangler secret put TOKEN_ENCRYPTION_KEY    # e.g. openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put AI_API_KEY              # only if EXTRACTION_MODE=live
npx wrangler secret list                        # names only
npm run deploy
```

The Workflow is created by `wrangler deploy`; it has no separate create command.

### Prerequisites checklist (§17.4)

- [ ] Build passes (`npm run build`).
- [ ] Typecheck passes (`npm run typecheck`).
- [ ] Migration applied to the intended environment (`npx wrangler d1 migrations list vexo-field-assistant --remote`).
- [ ] Required bindings exist (D1 id pasted, queue created; `wrangler deploy` output lists DB, SESSION_QUEUE, SESSION_WORKFLOW, ASSETS).
- [ ] Required secrets exist (`npx wrangler secret list`).
- [ ] API/auth routes are not swallowed by SPA fallback (`curl -i $ORIGIN/api/health` returns JSON, not HTML).
- [ ] OAuth callback origin matches `APP_ORIGIN` if evidence is live.
- [ ] Access control protects the deployed application (`AUTH_MODE=access` + Access policy).
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

Run `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`. Do not run destructive schema rollbacks, and do not delete records to save a demo; prefer an isolated demo database. If the deployment is not repaired by M18, demo from the tested local build and state the limitation.
