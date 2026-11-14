# src/auth/vexo — Vexo authorization seam

Status: **seam only.** The live Vexo connection (OAuth + MCP transport) is being
built separately as an MCP server. This directory exposes the port the rest of the
app depends on, a safe default, and tested security helpers.

## Exports (`index.ts`)

| Export | Purpose |
|---|---|
| `VexoTokenProvider` | `getAccessToken(providerId)`, `connectionStatus(providerId)` |
| `notConfiguredTokenProvider` | Default. `connected: false`; `getAccessToken` throws `EvidenceUnavailableError(kind "not_configured", retryable false)` |
| `createPkcePair()` | RFC 7636 S256 pair (WebCrypto, base64url): `{ codeVerifier, codeChallenge, codeChallengeMethod }` |
| `pkceChallenge(verifier)` | S256 challenge for a verifier |
| `createOAuthState(providerId, secret, now)` | HMAC-SHA256-signed state bound to the app user, returns `{ state, nonce }` |
| `verifyOAuthState(state, providerId, secret, now, maxAgeSec = 600)` | Checks signature, user binding and age (30 s future skew allowed). Returns `{ providerId, nonce, issuedAt }`; throws `VexoAuthError` |
| `assertSafeRedirect(url, appOrigin)` | Resolves against the app origin and rejects other origins, non-http(s) schemes, userinfo, backslashes and control chars. Returns the normalized URL |
| `assertIssuer(expected, actual)` | Exact string match (RFC 8414 / RFC 9207) |
| `VexoAuthError` | `code`: `invalid_state` \| `state_expired` \| `state_binding` \| `unsafe_redirect` \| `issuer_mismatch` |
| `base64UrlEncode` / `base64UrlDecode` | Helpers |

`now` is a `Date` or epoch milliseconds, so callers can pass `clock.now()`.

**One-time use is not enforced by the state itself.** HMAC and the timestamp make
state unforgeable, user-bound and time-limited, but a captured state can be
replayed inside its window. The real connection must persist `nonce` (along with
the PKCE verifier, keyed by nonce, TTL = `maxAgeSec`) when it starts the flow, and
on callback delete it atomically, so that a state is only valid if the delete
removed a row.

## What the real connection must do

1. **Discovery.** Fetch the authorization-server metadata
   (`/.well-known/oauth-authorization-server`, or protected-resource metadata
   first for MCP). Pin the `issuer` and check the metadata's `issuer` with
   `assertIssuer`. Use only the endpoints that metadata lists, and only over https.
2. **Client registration.** Use static client credentials from platform secrets
   (`wrangler secret`), or dynamic client registration (RFC 7591) whose result is
   stored server-side. Never put a client secret in code, URLs or responses.
3. **`GET /auth/vexo`** (mount later; needs an authenticated app actor):
   - `createPkcePair()` and `createOAuthState(actor.providerId, STATE_SECRET, clock.now())`.
   - Persist `{ nonce, providerId, codeVerifier, returnTo }` with a TTL. Check
     `returnTo` with `assertSafeRedirect` before you store it.
   - Return a 302 to the authorize endpoint with `response_type=code`, `client_id`,
     the registered `redirect_uri`, `scope`, `state`, `code_challenge` and
     `code_challenge_method=S256`.
4. **`GET /auth/vexo/callback`**:
   - If `error` is present, show a generic failure. Do not echo upstream text unescaped.
   - `verifyOAuthState(state, actor.providerId, STATE_SECRET, clock.now())`. The
     session user must be the one who started the flow.
   - Atomically consume the stored nonce. Reject the request if it is missing or already used.
   - If the server sends an `iss` parameter (RFC 9207), require it and check it
     with `assertIssuer`.
   - Exchange the code at the token endpoint with `code_verifier`, server-to-server.
   - Redirect only to the stored `returnTo`, after checking it again with `assertSafeRedirect`.
5. **Encrypted storage.** Encrypt access and refresh tokens with
   `encryptToken(…, env.TOKEN_ENCRYPTION_KEY)` from `src/security` before writing
   them to D1, and decrypt them only inside the provider. Store the expiry, the
   scope and the issuer alongside them. If `TOKEN_ENCRYPTION_KEY` is missing, stay
   on `notConfiguredTokenProvider` and do not store anything in plaintext.
6. **Per-provider binding.** Key credentials by `providerId` (the app user). A
   provider's evidence calls must only use that provider's token. Never fall back
   to another user's token.
7. **Bounded refresh.** Inside `getAccessToken`, refresh when the token is close
   to expiry. Allow at most one refresh attempt per call, use a timeout, and
   serialize refreshes per provider to avoid races with rotating refresh tokens.
   If the refresh is rejected (`invalid_grant`), mark the connection disconnected
   and throw `EvidenceUnavailableError("…", "auth", false)`. Throw transient
   failures as `"transport"` with `retryable: true`, and HTTP 429 as `"rate_limited"`.
8. **Never send tokens to the browser.** Tokens must never appear in API
   responses, URLs, logs (`log()` fields), exports, Workflow step results or error
   messages. `connectionStatus` returns only `connected` and a human-readable `detail`.
9. **Revocation and disconnect.** Delete the stored credentials, and call the
   revocation endpoint if the server advertises one.

The `VexoTokenProvider` is injected into `createEvidenceSource` (`src/integrations/vexo`).
Until the real provider exists, wire `notConfiguredTokenProvider`.
