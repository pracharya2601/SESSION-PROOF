# Security review (Agent 19)

Scope: application access, CSRF/origin, secrets, evidence minimization, rendering. This is a
sprint review of a synthetic-data demo. **It is not a production compliance determination.**
Line refs are as of review time (2026-11-13) and may drift.

## Helpers provided (`src/security/index.ts`)

| Export | Behavior |
|---|---|
| `correlationId()` | `crypto.randomUUID()` → `c.var.correlationId` + `X-Correlation-Id` header |
| `apiError(c, status, code, message, retryable, details?)` | `{ error: { code, message, retryable, correlationId, details? } }` |
| `requireActor(deps)` | dev: HMAC-SHA256 cookie `vfa_session` `{providerId, identity, exp}`, `SESSION_SECRET` ≥ 32 chars else 503 `AUTH_NOT_CONFIGURED`, constant-time compare, expiry check, identity re-mapped via `repo.findProviderByIdentity` on every request. access: `Cf-Access-Authenticated-User-Email` (lower-cased) → `findProviderByIdentity`. Otherwise 401 `UNAUTHENTICATED` |
| `originGuard(deps)` | non-GET/HEAD/OPTIONS need `Origin` = `APP_ORIGIN` or request origin; missing / `null` Origin rejected → 403 `ORIGIN_REJECTED` |
| `authRoutes(deps)` | `POST /auth/dev-login` (404 unless AUTH_MODE=dev **and** RUNTIME_MODE≠deployed **and** loopback host; unknown identity 401; cookie HttpOnly, SameSite=Strict, Path=/, Secure on https, Max-Age 8h), `POST /auth/logout`, `GET /api/me` |
| `encryptToken` / `decryptToken` | AES-256-GCM, random 12-byte IV, `v1.` + base64url(iv‖ct‖tag); key must base64-decode to 32 bytes |
| `log(level, event, fields)` | JSON line; recursively redacts keys matching `/token\|secret\|authorization\|cookie\|password\|excerpt\|transcript\|text\|prompt\|content/i` |
| `escapeHtml(s)` | `& < > " ' \`` |
| extras | `isOwner`, `signSession`, `verifySession`, `timingSafeEqual`, `redact`, `isLoopbackHost`, `SESSION_COOKIE` |

Tests: `src/security/security.test.ts` (24 passing).

## Findings

Severity: **H** fix before any deployment with real data · **M** fix before release · **L** hardening.

### H1 — Default deploy config ships dev auth (`wrangler.jsonc:35-37`)
`vars` set `AUTH_MODE: "dev"`, `RUNTIME_MODE: "local"`, `APP_ORIGIN: http://localhost:8787`, and
no `workers_dev`/`preview_urls: false`. A plain `wrangler deploy` publishes a dev-auth Worker on
a public `*.workers.dev` URL. Mitigation in place: dev-login now refuses non-loopback hosts
and `RUNTIME_MODE=deployed`, so no public login is issued, but the deployment is then simply
unusable rather than protected. **Action (Agent 01/03):** add an `env.production` block with
`AUTH_MODE: "access"`, `RUNTIME_MODE: "deployed"`, the real `APP_ORIGIN`, `workers_dev: false`,
`preview_urls: false`, and put the route behind a Cloudflare Access application. If Access is
not available, keep the demo local and synthetic-only (handoff §16.1).

### H2 — Access mode trusts the email header without JWT verification (`src/security/index.ts`, `resolveActor`)
`Cf-Access-Authenticated-User-Email` is only trustworthy if every path to the Worker goes
through Access. **TODO before production:** verify `Cf-Access-Jwt-Assertion` (team JWKS,
`aud` = Access app AUD tag, `iss`, `exp`) and take identity from the verified claims. Depends on H1
(`workers_dev: false`), otherwise the header is attacker-controlled.

### M1 — Model gateway logging/caching not controlled in code (`src/ai/index.ts:175`)
Prompts carry evidence excerpts. When `AI_GATEWAY_URL` points at Cloudflare AI Gateway, request/
response logging and caching are configured in the dashboard, not here. **Action:** disable
Gateway logging and caching (or set an explicit retention policy) before live extraction;
record the setting in the release notes. No prompt/response logging found in `src/ai`.

### M2 — `POST /api/sync` runs global discovery for any provider (`src/api/sync.ts:11-13`)
Any authenticated provider triggers discovery + dispatch across **all** providers and receives
global counts (`examined/created/enqueued`, `attempted/failed`). Small cross-tenant info leak
and cost-amplification vector. **Action:** scope discovery to `actor.providerId` or return only
`{ accepted: true }`; add rate limiting.

### M3 — Sensitive API responses lack `Cache-Control: no-store` (`src/api/sessions.ts:22-58`, `src/api/review.ts:42-58`)
Session detail returns evidence excerpts, facts and billing. Export routes already set
`no-store` (`review.ts:78,83`); JSON API routes do not. **Action:** set `Cache-Control: no-store`
on all `/api/*` responses (e.g. one middleware in `src/api/index.ts`).

### M4 — `/api/dev/seed` gated only by AUTH_MODE (`src/api/dev.ts:10`, `src/index.ts:59`)
Any authenticated user can reseed in dev auth mode, including on a deployed dev-mode Worker.
Reachability is limited by the dev-login loopback restriction, but **action:** also require
`RUNTIME_MODE !== "deployed"`.

### L1 — Excerpt volume upper bound (`src/contracts/schemas.ts:111,118`)
Evidence is window-filtered and the rest of the day is discarded (`src/integrations/vexo/live.ts:297`),
so whole-day transcripts are not stored or returned. Still, 500 items × 4000 chars allows ~2 MB
of transcript text per session in D1, `GET /api/sessions/:id`, and the export. Consider a lower
per-session cap.

### L2 — Token storage format vs migration (`migrations/0001_init.sql:138-141`)
Columns `*_token_ciphertext` + `*_token_iv` exist; `encryptToken` embeds the IV in a versioned
`v1.` blob. Store the blob in `*_ciphertext` and leave `*_iv` NULL (or drop it). No OAuth token
store is implemented yet (`src/auth/vexo/index.ts:21` `notConfiguredTokenProvider`), so
§16.2 "encrypt at rest" is untested end-to-end.

### L3 — Ad-hoc loggers bypass redaction (`src/workflow/run.ts:67`, `src/jobs/index.ts:48`)
Both log ids/revisions/status only today (jobs' field type is primitives-only), so no leak now.
Prefer `log()` from `src/security` so future fields are redacted.

### L4 — Export includes approval idempotency key (`src/export/index.ts:97`, `exportJson` `approval`)
Not a credential, but unnecessary in a printed record. Low.

### L5 — Origin guard requires an `Origin` header
Browsers send it on same-origin POST/PATCH `fetch` (`src/ui/api.ts:53`), so the UI works.
Non-browser clients (curl, e2e harness) must send `Origin` explicitly.

## Verified OK

- **Authorization on every route:** `src/api/index.ts:26` applies `requireActor` to `/api/*`;
  only `/api/health` (registered earlier, `:24`, no personal data) and `/auth/*` are public.
  `/api/me` enforces `requireActor` itself.
- **Ownership scoping:** `getSessionForProvider` in `src/api/sessions.ts:41`,
  `src/services/approval/index.ts:44`, `src/export/index.ts:19`; D1 query filters
  `provider_id` (`src/db/d1.ts:382,398`). Cross-provider reads return 404
  (`src/api/api.test.ts:211`).
- **No client-supplied provider ids/amounts:** `ReviewRequest`/`ApprovalRequest` are `.strict()`
  and contain only revision, idempotency key, `confirmedMinutes`, `progressConfirmation`
  (`src/contracts/schemas.ts:297-319`). Actor comes from `c.get("actor")`
  (`src/api/review.ts:42,57`); amount is computed server-side by `assemble`.
- **CSRF:** SameSite=Strict cookie + `originGuard` on all unsafe methods (`src/api/index.ts:21`).
- **Export HTML escaping:** every dynamic value goes through `e()` → `escapeHtml`
  (`src/export/index.ts:36`); served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`
  and `nosniff` (`src/api/review.ts:75-79`). UI renders excerpts as React text
  (`src/ui/components/review/EvidencePanel.tsx:46`); no `dangerouslySetInnerHTML`/`innerHTML`
  in `src/ui`.
- **Frontend bundle secrets:** no `import.meta.env`, API keys, or secret names in `src/ui` or
  `dist/client`. `sessionStorage` holds only approval idempotency keys
  (`src/ui/pages/Review.tsx:58-65`). `.dev.vars` is gitignored; its `SESSION_SECRET` is ≥ 32
  chars and `TOKEN_ENCRYPTION_KEY` decodes to 32 bytes.
- **Workflow step results:** steps return status/ids/revisions only; evidence and bundles are
  written to D1 inside the step (`src/workflow/run.ts:81-190, 236-330`).
- **Error responses:** unhandled errors return a generic 500 and log only `errorName`
  (`src/api/index.ts:64-73`); AI errors carry status codes only (`src/ai/index.ts:193-197`).
- **Vexo OAuth state:** HMAC-signed, user-bound, time-limited, same-origin redirect checks
  (`src/auth/vexo/index.ts:127-233`). Vexo authorization is not used as app authentication.

## Remaining limits (do not claim production compliance)

Access JWT verification (H2), production Access deployment (H1), Gateway retention (M1),
token-at-rest store, amendments/deletion/retention, access auditing, incident response and
legal agreements are out of scope for this sprint (handoff §16.5).
