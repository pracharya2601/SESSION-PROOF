# Deploy: demo on Cloudflare (env.production)

This is the step-by-step guide for a **synthetic-data demo** deployment that the iPhone (GlassCam) can reach from any network:

- The web app sits behind **Cloudflare Access** (`AUTH_MODE=access`).
- The phone authenticates itself with a **device key** (`Authorization: Bearer vfad_…`) and **per-visit stream tokens**.
- Band audio goes phone → Worker → **Deepgram**, through our Worker proxy (`DEEPGRAM_API_KEY` secret).
- All processing runs on **Queues + Workflows + D1**, with a 5-minute cron heartbeat.

**Status (2026-11-14): deployed** to `https://field-assist.prakashacharya.com`, version `357c72ff-262e-4b78-89cc-032d964eca64` (with review links). §11 lists what was verified live. Access JWT verification (§5.4, security-review **H2**) is implemented.

> **Still open: Cloudflare Access (§5.3) has to be set up in the dashboard.** Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, every Access-authenticated route returns **503 `AUTH_NOT_CONFIGURED`** (fail closed). The phone's device-key and stream-token routes already work. The static SPA shell is public, but it holds no data.

---

## 0. Decisions to make first

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Plan | Workers Free / **Workers Paid ($5/mo)** | Paid (§1) |
| D2 | Public hostname | **Custom domain** on a zone you own / `*.workers.dev` | Custom domain if you have a zone on Cloudflare; workers.dev works too (§4) |
| D3 | Extraction | `fixture` (canned demo facts, no AI key) / `live` (needs an AI key) | `fixture` for a first deploy. A real band transcript with `fixture` extraction gives canned facts that won't match what was said. Switch to `live` once the pipeline works |
| D4 | Access JWT verification | implement before deploy / accept the risk for a short private demo | **Done** (§5.4) |
| D5 | Who may sign in | the Access Allow policy's emails | Only your own email(s); each one must be mapped to a provider row (§7) |

---

## 1. Plan requirements and costs

Sources were checked on 2026-11-14. The "last updated" date of each page is shown.

| Product | Workers Free | Workers Paid | Source |
|---|---|---|---|
| Workers | 100k requests/day, **10 ms CPU per invocation** | $5/mo minimum; 10M requests + 30M CPU-ms/mo included | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (updated 2026-11-13) |
| Queues | Available. 10k operations/day, 24 h retention | 1M operations/mo included, then $0.40/M. Retention 4 days by default (max 14) | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [limits](https://developers.cloudflare.com/queues/platform/limits/) (2026-10-30) |
| Workflows | Available. **10 ms CPU per step**, 3,000 steps/day, 100 concurrent instances, 3-day state retention | 30 s CPU per step (max 5 min), 500k steps/mo included, 7-day retention | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) (2026-11-04), [limits](https://developers.cloudflare.com/workflows/reference/limits/) (2026-11-10) |
| D1 | 5M rows read/day, 100k written/day, 5 GB | 25B reads + 50M writes/mo included, 5 GB included | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (2026-10-30) |
| Access (Zero Trust) | Free for up to 50 users | $7/user/mo above that | [Cloudflare One plans](https://www.cloudflare.com/teams-access/) |

**Recommendation: Workers Paid.** Queues and Workflows now run on Free, but the Free CPU limit is 10 ms per request and 10 ms per Workflow step. Building the PDF (pdf-lib), assembling bundles, and proxying a WebSocket to Deepgram for a whole visit will very likely go over that.

Measured on the live deploy (2026-11-14, `wrangler tail`): `/api/health` 14 ms CPU, device API calls 8–27 ms, the 16 s Deepgram stream 145 ms, the queue batch 5 ms. All of them completed. So several requests already exceed 10 ms. The account's plan could not be read with the wrangler OAuth token. If it is on Free, expect occasional `exceededCpu` errors under load; PDF and export were not exercised yet. A demo uses a tiny fraction of the Paid allowances, so expect **about $5/month** for Cloudflare.

Deepgram streaming is billed separately by Deepgram per audio minute, on your Deepgram account. Check their current price; it was not verified here.

---

## 2. Prerequisites

```sh
npm ci
npx wrangler login                       # or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler whoami                      # confirm the right account
node scripts/platform/preflight.mjs      # what's still TODO (offline)
```

Zero Trust must be enabled on the account: dashboard → **Zero Trust** → pick a team name. The team domain is `https://<team>.cloudflareaccess.com`.

---

## 3. Provision D1 and the Queue

```sh
bash scripts/platform/provision.sh            # dry run: prints the commands
bash scripts/platform/provision.sh --apply    # creates D1 "vexo-field-assistant" + queue "vexo-session-processing"
```

Paste the printed id into `wrangler.jsonc` → `env.production.d1_databases[0].database_id`. It currently holds the all-zero placeholder, and preflight reports that as TODO.

There is no create step for the Workflow. `wrangler deploy` registers `vexo-session-workflow`.

Optional: a dead-letter queue. Create `vexo-session-dlq`, then add `"dead_letter_queue": "vexo-session-dlq"` to the consumer. Without one, a message that fails 5 times is dropped. The 5-minute heartbeat does not re-enqueue it (see `docs/reports/band-pipeline-observation.md` §2.4).

---

## 4. Choose the hostname and set the origins

Edit only `env.production` in `wrangler.jsonc`.

**Option A: custom domain** (recommended when you have a zone on Cloudflare)
```jsonc
"routes": [{ "pattern": "field.yourdomain.com", "custom_domain": true }],
"workers_dev": false,
```

**Option B: workers.dev** (no zone needed)
```jsonc
"workers_dev": true,
```
The host is `vexo-field-assistant-production.<account-subdomain>.workers.dev`. The Worker name gets the `-production` suffix from the environment. Your account subdomain is under Workers & Pages → overview.

Then set all three origins to that **one** host:
```jsonc
"APP_ORIGIN":           "https://field.yourdomain.com",
"PUBLIC_APP_ORIGIN":    "https://field.yourdomain.com",   // goes into the pairing link
"PUBLIC_STREAM_ORIGIN": "wss://field.yourdomain.com"      // goes into streamUrl
```

Why only one hostname: Access protects hostnames. Every extra hostname (workers.dev next to a custom domain, or preview URLs) is another way in that needs its own Access application. `preview_urls` is already `false`. Preflight fails if the hosts disagree or if both a route and workers.dev are on.

**Do not use the Worker-level "Protect this Worker behind Access" toggle**, or the account-level "Protect all Workers". The [Workers Access docs](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) (updated 2026-11-02) say Worker-level policies don't support WebSockets ("WebSocket upgrade requests … will fail with a `403`") and have no per-path exceptions. The band stream is a WebSocket and the phone needs bypass paths, so use **hostname-based self-hosted applications** (§5). Those work for a custom domain and for a `*.workers.dev` hostname alike.

---

## 5. Cloudflare Access

### 5.1 What must bypass Access, and why that is safe

These paths authenticate themselves, and the phone has no Access session:

| Access path (bypass) | Authenticates with | Code |
|---|---|---|
| `/api/device/*` | `Authorization: Bearer vfad_…`. SHA-256 lookup; a revoked device gets `401 DEVICE_REVOKED`; the provider must still exist. `requireDevice` runs for **every** `/api/device/*` path, before any other handler | `src/devices/auth.ts`, `src/api/device.ts` |
| `/api/visits/*/stream` | the stream token in `Sec-WebSocket-Protocol: vfa-stream, vfa-token.<t>` (or a first `auth` message, §13): an HMAC token scoped to that one visit, valid 4 h, with a separate key derivation from `SESSION_SECRET`. Deprecated: `?token=` | `src/api/visits.ts` `visitStreamRoutes`, `src/band/token.ts` |
| `/api/visits/*/stop` | `Authorization: Bearer <stream token>` (deprecated: `?token=`). POSTs also need `Origin` = the request origin | same |
| `/api/visits/*/status` | `Authorization: Bearer <stream token>` (deprecated: `?token=`) | same |
| `/api/health` | public; returns only modes and binding booleans | `src/api/health.ts` |

Everything else (`/`, `/assets/*`, `/auth/*`, all other `/api/*`) stays behind Access. The Worker then requires the Access identity there (`requireActor`).

**The catch.** Access path rules can't match query strings ([Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), updated 2026-04-17). So `/stop`, `/status` and `/stream` are bypassed **with or without** a stream token. Without a token, those routes fall through to the cookie/Access branch (`requireActor`). Today that branch **trusts the `Cf-Access-Authenticated-User-Email` header** (H2). On a bypassed path Access does not authenticate the request, and Cloudflare does not document stripping a client-sent copy of that header. An attacker who knows a provider's email could therefore send:

```
POST https://<host>/api/visits/<id>/stop        (no token)
Cf-Access-Authenticated-User-Email: provider@…
Origin: https://<host>
```

The stream route's cookie branch works the same way: a non-browser client can set any `Origin`. That gives stop/status/stream as that provider. Visit ids are random 128-bit values, so the attacker also needs a visit id.

A second way in is **path-normalisation mismatch**. A URL such as `/api/device/%2e%2e/sessions` can match the `/api/device/*` bypass at the edge, while the Worker's `new URL()` resolves it to `/api/sessions`, where the forged header would be accepted. Whether the edge normalises this first depends on zone URL-normalisation settings, which you can't set for workers.dev. Don't rely on it.

**workers.dev vs custom domain.** Requests can only reach the Worker through Cloudflare's edge for one of its hostnames. There is no origin IP to go around. So when every hostname has an Access application:
- On **non-bypassed** paths, a forged header has to get through Access login first. That is safe under either option.
- On **bypassed** paths, the forgery above works under **either** option. A custom domain does not fix it.
- A **forgotten hostname** (workers.dev left on next to a custom domain, or preview URLs) means *every* path accepts a forged header. That is why §4 insists on one hostname.

### 5.2 Status: both holes are closed

- **Forged header:** the Worker now verifies the Access JWT (§5.4) and never reads `Cf-Access-Authenticated-User-Email`. A bypassed request carries no valid Access JWT, so the fall-through branch returns 401 (503 while Access is unconfigured).
- **Path normalisation:** `/api/*` and `/auth/*` paths that contain `%2e`, `%2f`, `%5c`, a backslash, a `.`/`..` segment or an empty segment are rejected with **400 `BAD_PATH`** before any router runs (`isAmbiguousPath`, applied in the first middleware, `correlationId()`). Verified live: `/api/device/%2e%2e/sessions` and `/api/device/..%2fsessions` both return 400. The Cloudflare edge resolves a literal `/../` itself before the Worker sees it, so `/api/device/../sessions` arrives as `/api/sessions` and goes through Access like any other request.

### 5.3 Dashboard steps (Zero Trust → Access → Applications)

Create **two** self-hosted applications on the same hostname. The more specific path wins ([Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/): "the more specific rule takes precedence").

The wrangler OAuth login can't create these: it has no Access scope, and it can't read the Zero Trust organization. These steps are manual. The current host is `field-assist.prakashacharya.com`.

**0. Zero Trust (once per account).** Dashboard → **Zero Trust**. If asked, pick a team name (e.g. `prakash`) and the **Free** plan (up to 50 users, $0; a payment method may be requested but isn't charged). The team domain is `https://<team>.cloudflareaccess.com`. You can also find it under Settings → Custom Pages, or Settings → General → "Team domain".

**App 1: "Vexo Field Assist"** (login)
1. **Access → Applications → Add an application → Self-hosted**.
2. Public hostname: subdomain `field-assist`, domain `prakashacharya.com`, path empty (whole host).
3. Session duration: 8 h, the same as the dev cookie.
4. Policy **"Allow providers"**: Action **Allow**; Include → Emails → your email(s). For login methods, the One-time PIN is enough for a demo.
5. Save. Open the app's **Overview** and copy the **Application Audience (AUD) tag**: that is `ACCESS_AUD` for §5.4.

**App 2: "Vexo Field Assist: self-auth paths"** (bypass)
1. **Add an application → Self-hosted**.
2. Add one public hostname entry per path, all on the same host:
   - `/api/device/*`
   - `/api/visits/*/stream`
   - `/api/visits/*/stop`
   - `/api/visits/*/status`
   - `/api/health`
   - `/r/*` and `/api/review-link/*` (review links: they authenticate with their own link token)

   A trailing `*` does not match the parent path. A `*` in the middle can span several segments, so `/api/visits/a/b/stop` also matches. That is harmless, because the Worker has no such route and returns 401 or 404.
3. Policy **"Bypass self-authenticating"**: Action **Bypass**; Include → **Everyone**.
4. Save.

**Then tell the Worker** (both values are public, not secrets). In `wrangler.jsonc` → `env.production.vars`, uncomment and fill:
```jsonc
"ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
"ACCESS_AUD": "<App 1 Application Audience (AUD) tag>"
```
Then run `npm run preflight -- --secrets --access-confirmed` (expect no TODO for Access) and `npm run deploy`. Make sure the provider row's `identity` is the exact email you sign in with (§7).

Check it:
```sh
curl -si https://<host>/api/health | head -1          # 200, JSON
curl -si https://<host>/api/sessions | head -1        # 302 to <team>.cloudflareaccess.com (Access login)
curl -si https://<host>/api/device/me | head -1       # 401 UNAUTHENTICATED from the Worker (JSON), not an Access page
```

**Web UI side effect.** The web page's own **Stop** (`src/ui/api.ts` `stopVisit`) calls `POST /api/visits/:id/stop` **without** a stream token, and that path is now bypassed. Access doesn't add identity headers to bypassed requests, so this call returns 401 until the JWT check also accepts the `CF_Authorization` cookie, as specified below. The browser sends that cookie to the same host. The phone flow is not affected.

### 5.4 Access JWT verification (implemented)

**Implemented** on 2026-11-14 in `src/security/access-jwt.ts`, wired into `resolveActor` in `src/security/index.ts`. Tests: `src/security/access-jwt.test.ts`, which uses a locally generated RSA key and a fake JWKS fetch. Notes on how it differs from the spec below:
- `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are read through a local `AccessEnv` type, so `src/env.ts` was not changed. They can be added there later.
- `ACCESS_TEAM_DOMAIN` may be given with or without `https://` and a trailing slash. A placeholder that contains `<…>` counts as unset.
- An unknown `kid` refetches the JWKS once, at most every 30 s per team domain, so random kids can't force a fetch on every request. A stale key set is kept if Access is briefly unreachable.
- Rejections are logged as `auth.access_jwt_rejected` with a reason code only (`aud`, `exp`, `signature`, …). The token and the email are never logged.

The original specification:

1. **Env** (`src/env.ts`): add `ACCESS_TEAM_DOMAIN?: string` (e.g. `https://<team>.cloudflareaccess.com`) and `ACCESS_AUD?: string` (App 1's AUD tag). Set both as plain `vars` in `env.production`. A commented placeholder is already there. Neither is a secret.
2. **`resolveActor`, access branch** (`src/security/index.ts`):
   - If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, return `503 AUTH_NOT_CONFIGURED` (fail closed).
   - Token = the `Cf-Access-Jwt-Assertion` header, else the `CF_Authorization` cookie (that fallback keeps the web Stop working on the bypassed path). No token → `401 UNAUTHENTICATED`.
   - Verify it as a JWS against the JWKS at `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`:
     - `alg` must be `RS256`.
     - Pick the key by `kid`. Import it with `crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])` and verify `header.payload` with `crypto.subtle.verify`.
     - Cache the JWKS in module scope (e.g. 1 h). On an unknown `kid`, refetch once, because Access rotates its keys.
   - Check the claims:
     - `iss === ACCESS_TEAM_DOMAIN`
     - `aud` (a string or an array) includes `ACCESS_AUD`
     - `exp > now` and `nbf`/`iat <= now`, each with 60 s skew
     - `email` is a non-empty string. Service tokens carry `common_name` and no email, so reject them.
   - Identity = `payload.email.trim().toLowerCase()` → `findProviderByIdentity`, as today. **Stop reading `Cf-Access-Authenticated-User-Email` entirely.**
   - Remove the `TODO(production): verify Cf-Access-Jwt-Assertion` comment. `preflight.mjs` keys off it and also checks that `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set.
3. **Dependency**: plain WebCrypto is enough. Cloudflare's own Worker example uses `jose` (`createRemoteJWKSet` + `jwtVerify`); either is fine ([Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), updated 2026-11-02).
   - Alternative: the newer runtime `ctx.access`. It is populated only when Access authenticated the request and needs no JWT parsing ([Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)). It requires threading `executionCtx` into `resolveActor` and a newer wrangler/workers-types than 4.86. It is also harder to unit-test, so the JWT route is preferred.
4. **Tests** (`src/security/security.test.ts`): sign tokens with a test RSA key and a stubbed JWKS `fetch`. Cover:
   - valid header → actor
   - valid cookie only → actor
   - wrong `aud`, wrong `iss`, expired, bad signature, `alg: none`/HS256 → 401
   - unknown `kid` → one refetch
   - a forged email header with no JWT → 401
   - a missing env var → 503

   Mirror any harness wiring in `tests/e2e/*-harness.ts` if it changes.

---

## 6. Secrets

Set them on the **production** Worker. Values are prompted and never echoed. Don't paste them into chat or logs.

```sh
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_SECRET --env production        # ≥ 32 chars; signs stream tokens
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put TOKEN_ENCRYPTION_KEY --env production  # must decode to 32 bytes
npx wrangler secret put DEEPGRAM_API_KEY --env production                                             # paste at the prompt
# only if EXTRACTION_MODE=live (one of these; see docs/integrations.md):
npx wrangler secret put AI_API_KEY --env production
npx wrangler secret list --env production                                                             # names only
```

- `SESSION_SECRET` is required even with Access. `POST /api/visits` and `POST /api/device/visits` return 503 without it, because stream tokens are signed with a key derived from it. Rotating it invalidates every open stream token.
- Without `DEEPGRAM_API_KEY`, a deployed Worker has **no** transcriber (`simulated` is dev only). Server-transcribed visits then return `503 TRANSCRIPTION_NOT_CONFIGURED`.
- Optional: `GOOGLE_CLIENT_ID/SECRET` and `MS_CLIENT_ID/SECRET` for Connections. Their OAuth redirect URIs must use `APP_ORIGIN` (`docs/integrations.md`).

`wrangler secret put` against a Worker that doesn't exist yet creates it with no code. That is fine. You can also deploy first (§8) and set the secrets right after, but band visits won't work until they are set.

---

## 7. Remote schema and demo data

```sh
npm run db:migrate:remote                                                          # 8 migrations, 0001…0008
npx wrangler d1 migrations list vexo-field-assistant --remote --env production    # expect none pending
```

The deployed Worker **never seeds**: seeding is dev only. Access mode also needs a `providers` row whose `identity` is your Access email. A band visit also needs an earlier appointment for the client, because the service plan is copied from it (`422 NO_SERVICE_PLAN` otherwise).

**Used for the current deploy:** `scripts/platform/remote-seed.ts`. It writes only the synthetic provider (`provider_demo_001`, identity = `SEED_IDENTITY`), the demo service config, client `C-104` and one past template appointment. The SQL is generated by the real repository code, so nothing is copied from a local DB:
```sh
SEED_IDENTITY=you@example.com npx vite-node scripts/platform/remote-seed.ts -- --apply
```

The alternative is to copy the synthetic demo rows from a seeded local DB:

```sh
npm run db:migrate:local && npm run db:seed:local    # with npm run dev running, if not seeded yet
npx wrangler d1 export vexo-field-assistant --local --no-schema \
  --table providers --table service_configs --table appointments --table clients \
  --output .wrangler/demo-seed.sql
npx wrangler d1 execute vexo-field-assistant --remote --env production --file .wrangler/demo-seed.sql
npx wrangler d1 execute vexo-field-assistant --remote --env production --command \
  "DELETE FROM appointments WHERE id LIKE 'appt_visit_%'; UPDATE providers SET identity = lower('YOU@yourdomain.com') WHERE id = 'provider_demo_001';"
```

Use the exact email you sign in with through Access. The `DELETE` drops local band-visit appointments that have no visit rows remotely. Synthetic data only: never copy a local DB that holds real data.

---

## 8. Deploy

```sh
node scripts/platform/preflight.mjs --secrets --full    # want: no FAIL; TODOs only for things you consciously accept
npm run deploy                                          # typecheck + build + wrangler deploy --env production
npx wrangler deployments list --env production          # note the version id (rollback point)
```

The deploy output should list `DB`, `SESSION_QUEUE`, `SESSION_WORKFLOW` and `ASSETS`, the cron `*/5 * * * *`, the queue consumer, and the URL from §4.

---

## 9. Smoke test

`ORIGIN=https://field.yourdomain.com`

1. **Access edges** (§5.3 curl block): `/api/health` gives 200, `/api/sessions` redirects to Access, `/api/device/me` returns a Worker 401.
2. **Web**: open `$ORIGIN/`, sign in through Access, confirm **Today** shows the demo session (`/api/me` returns your provider). If you get 401 "Identity is not mapped", revisit §7.
3. **Forged-header negative test** (do this on every deploy):
   ```sh
   curl -si -H 'Cf-Access-Authenticated-User-Email: YOU@yourdomain.com' "$ORIGIN/api/visits/visit_x/status" | head -1
   ```
   Expect **401**. A **404 "Visit not found"** means the forged identity was accepted (H2 not fixed). Stop and fix §5.4 before going further.
4. **Pair the phone**: before Access works, use the operator script: `node scripts/platform/pair-device-remote.mjs --out <file> --name "iPhone"`. It writes the key and the `glasscam://pair?…` link to `<file>` (mode 0600) and never prints them; revoke with `--revoke dev_…`. Once Access works: web → **Settings → Devices** → name it → **Pair a phone**. The QR/link is `glasscam://pair?server=$ORIGIN&key=vfad_…`. `server` comes from `PUBLIC_APP_ORIGIN`; if the page warns "localhost", the vars are wrong. Scan it with GlassCam. The key is shown once; it is a secret.
5. **Phone visit**: in GlassCam pick a client (e.g. `C-104`) → start → record → stop. The phone calls `/api/device/*` with the bearer key and streams to `wss://…/api/visits/<id>/stream`, with the token in `Sec-WebSocket-Protocol`. Within ~1 min the session appears in Today as NEEDS_REVIEW.
6. **Pipeline**: `npx wrangler tail --env production` (look for `heartbeat.done`, the queue handling, `workflow.completed`; no transcript text, emails or tokens), and `npx wrangler workflows instances list vexo-session-workflow`.
7. Review → approve → export, as in `docs/runbook.md` §17.5 steps 9–16.

**Scripted stream smoke against https: `scripts/band/deployed-smoke.mjs`** (`npm run smoke:deployed`):
```sh
DEVICE_KEY=vfad_… BASE_URL=https://field-assist.prakashacharya.com \
  npm run smoke:deployed -- path/to/packets.bin C-104        # packets.bin: [u16 LE length][Opus packet]…
```
It checks health, the unauthenticated/forged-header/bad-path refusals, device me and clients, then runs a band visit with real Opus through Deepgram, stops it via the device API, and polls until the visit has a session. The transcript is reported as a word count only. `RESOLVE=host:ip` pins DNS, like curl `--resolve`. It was written to this design:
- **Auth**: read the device key from env (`DEVICE_KEY=vfad_…`, never from argv, so it stays out of shell history and `ps`). Send `Authorization: Bearer $DEVICE_KEY`. No cookie, no `Origin`.
- **Calls**:
  - `GET /api/device/me` (the `transcribers` list) instead of `/api/visits/capture-status`
  - `POST /api/device/visits` `{ clientRef, bandNumber: null, transport: "sim" }` instead of `POST /api/visits`
  - `POST /api/device/visits/:id/stop` instead of the cookie stop
- **Audio**: Deepgram is the only deployed transcriber, and the `0xab` filler bytes are not Opus. Expect zero segments, and probably a session with no evidence. Feed real Opus packets instead: demux an Ogg Opus file such as `dist/client/sample-speech.opus` into 20 ms packets, or replay a recorded band capture.
- **Completion**: device keys can't read `/api/sessions/:id` (it is behind Access). Poll `GET /api/device/visits/:id` until `visit.sessionId` is set, then check the session in the web UI. Or call the session API with `cloudflared access curl $ORIGIN/api/sessions/<id>` after `cloudflared access login $ORIGIN`.
- **Node**: Node 20 still needs `--experimental-websocket`; `wss://` works.

---

## 10. Rollback and teardown

```sh
npx wrangler deployments list --env production
npx wrangler rollback <version-id> --env production      # code + config only
```

- A rollback does **not** undo D1 migrations. Migrations are additive (`CREATE TABLE IF NOT EXISTS`), so older code keeps working. Don't run destructive schema rollbacks.
- Data: D1 Time Travel can restore the database to a point in time (`npx wrangler d1 time-travel info|restore vexo-field-assistant --env production`). It's simpler to keep this database demo-only.
- Workflow instances already running keep the code they started with. New ones use the rolled-back code.
- Kill switch: disable App 2 (bypass). The phone is then locked out and the web stays behind Access. Revoke devices in Settings → Devices.
- Teardown after the demo:
  - `npx wrangler delete --env production`
  - `npx wrangler queues delete vexo-session-processing`
  - `npx wrangler d1 delete vexo-field-assistant`
  - delete both Access apps

---

## 11. Verified live (2026-11-14, wrangler 4.86.0)

Deploy: `bash scripts/platform/provision.sh --apply` (D1 `fcbf44f5-578d-4f77-ac63-145148582b86`, queue `vexo-session-processing`) → migrations 0001–0008 → 3 secrets → `wrangler deploy --env production` → custom domain `field-assist.prakashacharya.com`, version `df459afc-cb54-4dbe-9931-07feb7af28b1`. Then 0009 (review links) and a redeploy: version `357c72ff-262e-4b78-89cc-032d964eca64`. The smoke test passed 11/11 on it, including the device review inbox; `/api/review-link/<bad>` returns `INVALID_REVIEW_LINK`.

DNS: a resolver that looked the name up before the custom domain existed caches NXDOMAIN for up to 30 min (the zone SOA minimum is 1800 s). Flush it on macOS with `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, or test with `curl --resolve field-assist.prakashacharya.com:443:104.21.34.170`.

| Check | Result |
|---|---|
| `GET /api/health` | 200 JSON, `runtimeMode=deployed`, `authMode=access`, db/queue/workflow bindings true |
| `GET /api/sessions`, `/api/me` without auth | 503 `AUTH_NOT_CONFIGURED` (Access vars unset: fail closed) |
| Forged `Cf-Access-Authenticated-User-Email` on `/api/visits/x/status` and `POST …/stop` | 503, not 404: the header is not trusted |
| `/api/device/%2e%2e/sessions`, `/api/device/..%2fsessions` | 400 `BAD_PATH` |
| `POST /auth/dev-login` | 404 |
| `/api/device/me` without a key, with a revoked key | 401, 401 |
| Device `me` / `clients` | 200; transcribers `deepgram,device`; C-104 listed |
| Band visit, real Opus (796 packets, ~16 s) → wss → Deepgram | 3 final segments, 50 words, 0 lost packets |
| Stop via device API → queue → Workflow | session `NEEDS_REVIEW`; workflow instance waiting for approval |
| `wrangler tail` | no device key, Deepgram key, email or client name; `Authorization` shown as REDACTED. Stream URLs carry no token (§13); a `stream.legacy_query_token` event means an old client still sent `?token=`, which then is in the logged URL |

Not verified yet: anything behind Access (web login, review/approve/export, PDF CPU time), because Access isn't set up.

### Offline checks (before the deploy)

- `npx wrangler deploy --dry-run --env production --outdir .wrangler/dry-run-prod` passes with no warnings. It reads 62 asset files, uploads 1585.73 KiB (385.30 KiB gzip), and binds `SESSION_WORKFLOW` (SessionWorkflow), `SESSION_QUEUE` (vexo-session-processing), `DB` (vexo-field-assistant), `ASSETS` and the 8 vars.
- `node scripts/platform/preflight.mjs --full`: typecheck, tests, build and the production dry-run all pass. What remains is TODO: placeholders, ingress, secrets, Access, and JWT verification.
- Preflight's own tests: `node --test scripts/platform/preflight.test.mjs`.
- Not verified: anything that needs an account (provisioning, secrets, Access behaviour, WebSocket via Access bypass, Deepgram from the deployed Worker).

## 12. Known issue: local V8 crash (local dev only)

While running the band pipeline locally, `wrangler dev` (wrangler 4.86's bundled workerd) aborted twice with "V8 fatal error … Missing deoptimization information for OptimizedJSFrame::Summarize" (signal 6). Both times it came right after a `workflow.completed` and a `GET /api/sessions/:id` (`docs/reports/band-pipeline-observation.md` §2.4). It is a crash of the **local workerd binary**, not of our code's logic. The deployed Worker runs on Cloudflare's production runtime, not on this binary, so it is not expected there.

Locally: restart `npm run dev`. A queue message lost in the crash leaves a session stuck in QUEUED; reset it with **Reset demo session (dev)**. Upgrading wrangler (4.162 is current) is the suggested fix, as a separate change.

## 13. The stream token stays out of request URLs

Cloudflare records the full request URL, query string included, in `wrangler tail` and (with `observability.enabled`) in Workers Logs. `Authorization` headers are redacted there; query strings are not. The band stream used to authenticate with `wss://…/api/visits/<id>/stream?token=…`, so anyone with read access to the account's logs could replay a visit's token for its 4 h lifetime.

Fixed (2026-11-14):
- `streamUrl` (visits and recordings) carries no token. The token comes back as `streamToken`.
- The stream authenticates with `Sec-WebSocket-Protocol: vfa-stream, vfa-token.<token>`, and the server echoes `vfa-stream`. The fallback is a first message `{"type":"auth","token":"…"}` within 5 s; missing or late auth closes with 1008. Stop and status take `Authorization: Bearer <token>`. Protocol: [band-bridge.md §2](band-bridge.md#2-stream).
- Updated clients: the browser recorder, GlassCam (`VisitStreamer.swift`, `URLSessionWebSocketTask` with protocols), and `scripts/band/*.mjs`.
- Backward compatibility for one release: `?token=` is still accepted on stream, stop and status. Each use logs `stream.legacy_query_token` with `{ route, uses }` (a per-isolate counter, never the token). To find old clients, search Workers Logs for that event. Then remove the `?token=` fallback (`streamCredential` / `httpStreamToken` in `src/api/visits.ts`).
- Rollout order: deploy the server first, then install the new GlassCam build. A new GlassCam against an old server cannot stream, because the old server only reads `?token=`. An old GlassCam against the new server cannot parse a token-less `streamUrl`, so it needs the update too.
- Still applies: the token is scoped to one visit and valid for 4 h. A token pasted into a URL by hand would still be logged.
