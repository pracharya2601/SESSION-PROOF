# v2 test report (Q2)

**Build under test:** working tree as of 2026-11-13. There is no git, so there is no commit id.

**Runtime:** local only, using vitest, Miniflare D1 with all three migrations, and the fake Queue and Workflow bindings from `tests/e2e/harness.ts`.

**Outbound HTTP:** every outbound call went to the recording fake in `tests/e2e/v2-fake-fetch.ts`. That covers Google OAuth, Drive and Gmail; Microsoft OAuth and Graph (OneDrive, Outlook); Anthropic; OpenAI; Gemini; and Mistral.

**Not tested:**
- No real Google or Microsoft account and no real AI vendor was contacted.
- Nothing was deployed.
- `wrangler dev` was not run for v2.

## Files

| File | Purpose |
|---|---|
| `tests/integration/v2-flow.test.ts` | 18 tests, ids V2-01 to V2-13 |
| `tests/e2e/v2-harness.ts` | Wraps the v1 harness. It builds `createApi` with `fetch` injected, and mirrors the `src/index.ts` v2 wiring: `jobs.processFileDelivery`, workflow `onCompleted`, and `resolveSettings` |
| `tests/e2e/v2-fake-fetch.ts` | Stateful fake for Drive, OneDrive, Gmail and Outlook, plus AI vendor envelopes, a send-endpoint detector and request recording |

The API under test is the real `createApi`. Agent 01 has mounted `filesRoutes`, `deliveryRoutes`, `connectionsRoutes` and `settingsV2Routes` in it. The harness detects this and does not mount them a second time.

## Results

| ID | Result | Evidence | Owner if failing |
|---|---|---|---|
| V2-01 Files list + PDF downloads | PASS | See details below | |
| V2-02 Google OAuth + Drive + Gmail draft | PASS | See details below | |
| V2-03 Microsoft OneDrive + Outlook draft | PASS | See details below | |
| V2-04 Token refresh | PASS | An expired access token leads to one `grant_type=refresh_token` call, then the upload succeeds and the new expiry is stored | |
| V2-05 Auto-upload hooks | PASS | See details below | |
| V2-05b Auto-upload disabled / not connected | PASS | Nothing is enqueued and no Google calls are made | |
| V2-05c Auto-upload end to end | PASS | The workflow completion hook runs, then jobs dispatch runs, and the result is `drive:done`. This uses the same wiring as `src/index.ts` | |
| V2-06 Wrong provider | PASS | See details below | |
| V2-07 Not completed / not connected / validation | PASS | See details below | |
| V2-08 Provider failure | PASS | Gmail returns 403. The delivery is marked `failed` with a safe message that contains no token | |
| V2-09 Settings | PASS | See details below | |
| V2-10 Live extraction through each provider (anthropic, openai, gemini, mistral) | PASS ×4 | See details below | |
| V2-11 Name, DOB and address redaction | PASS | The planted name, DOB and street address are not sent raw | |
| V2-12 Unconfigured provider | PASS | Live extraction with no Gemini key throws, and no network call is made | |
| V2-13 Live mode end to end | PASS | See details below | |
| Tokens never in API responses | PASS | Every API response body in every test was scanned for access and refresh tokens, client secrets, AI keys and the encrypted token blobs. None were found | |
| Tokens never in logs | PASS | Captured console output was scanned for the same values and for the auth code. The V2-10 tests also checked that none of the planted PII values appear in logs | |
| Real Google or Microsoft OAuth, Drive, Gmail, OneDrive or Outlook | NOT RUN | No live accounts or credentials | |
| Real AI vendor calls | NOT RUN | No live keys | |
| `wrangler dev` black-box run for v2 | NOT RUN | Not done. The dev server on port 8787 was left alone | |
| UI pages (Files, Connections, Settings, Review redesign) | NOT RUN | No browser tests. See typecheck below | U1, U2, U3 |

### Details

**V2-01 Files list + PDF downloads**
- `GET /api/files` returns one row with rev 2, 11250 cents, 90 minutes and the three kinds.
- Each `downloadUrl` returns 200 with:
  - `application/pdf`
  - `attachment; filename="C-104_2026-11-13_…_r2.pdf"`
  - `no-store`
  - a body that starts with `%PDF-` and contains `%%EOF`
  - a Content-Length that matches the body
- `?inline=1` returns an inline Content-Disposition.
- An unknown kind returns 400.

**V2-02 Google OAuth + Drive + Gmail draft**
- Start returns a PKCE S256 authorize URL with the redirect URI `${APP_ORIGIN}/auth/connect/google/callback` and the `gmail.compose` scope.
- The callback calls the fake token endpoint (with `code_verifier`) and returns a 302 with `connected=google`. Replaying the same state is rejected with `invalid_state`.
- Drive:
  - The folder walk creates three folders (`Vexo Field Assistant` / `C-104` / `2026-11-13`) with the correct parents.
  - Three `multipart/related` uploads go into the leaf folder, each with a Bearer token and a PDF body.
  - The delivery ends `done` with `externalId` set to the folder id and `webUrl` set to the folder URL.
  - A second upload reuses the existing folders.
- Gmail:
  - `drafts.create` receives a raw MIME message with three attachment parts.
  - Each attachment decodes to `%PDF-` and has the correct filename.
  - The Subject decodes to `Session documentation — C-104 — 2026-11-13`.
  - The body is rendered, including `$112.50`.
- No send endpoint was called.
- Disconnect deletes the stored connection.

**V2-03 Microsoft OneDrive + Outlook draft**
- The encrypted `StoredConnection` was seeded directly through `repo.saveConnection` and `encryptToken`.
- OneDrive:
  - The path lookups return 404, then three folders are created through `children`.
  - Three files are uploaded by PUT to `…:/name:/content`, each with a PDF body.
  - `webUrl` is the folder URL.
- Outlook:
  - `POST /me/messages` creates a draft with the subject, the To and Cc recipients, and three `fileAttachment` parts.
  - The attachments are base64 PDFs.
- No `sendMail` or `/send` call was made.

**V2-05 Auto-upload hooks**
- `onSessionCompleted` enqueues once and is idempotent: it returns the same `fd_auto_…_r2` id, and the `file_delivery:<id>:2` pending row has the payload `{deliveryId}` only.
- `processFileDelivery` uploads three files and marks the delivery done.
- Running it a second time makes no new upload.

**V2-06 Wrong provider**
- The other provider gets 404 on files (all three kinds), on the deliveries list, on the drive upload and on the email draft.
- That provider's `/api/files` is empty and does not mention C-104.
- Unauthenticated requests get 401. A cross-origin POST gets 403.

**V2-07 Not completed / not connected / validation**
- A session in NEEDS_REVIEW returns 409 on files, drive and email-draft.
- A completed session without a connection returns 409 on drive and email-draft, including when Microsoft is requested explicitly.
- No storage provider set returns 422.
- Bad bodies return 400: empty `to`, an invalid email, an unknown `bcc` key, an unknown provider, an unknown file kind.
- No delivery rows were written in any of these cases.

**V2-09 Settings**
- Defaults: storage provider null, AI provider `anthropic`, `extractionMode` `fixture`, and all four AI providers show `configured: true` with no key values in the response.
- PUT returns 400 for 10 invalid bodies. These include:
  - a folder path containing `:`, and an empty folder path
  - an unknown provider
  - a stray key
  - a bad email
  - a CRLF injected into the subject template
  - an unknown attach kind
  - an unknown AI provider, an empty model, and a partial privacy object
- After the rejected PUTs, the stored settings are unchanged. A valid PUT round-trips.
- 401 without a cookie, 403 cross-origin.
- Settings are scoped per provider.
- In live mode, selecting a provider that has no key returns 422.

**V2-10 Live extraction through each provider**
- The provider is switched with `PUT /api/settings/ai`, then `createExtractor(env, { fetch, resolveSettings: repo.getAiSettings })` runs.
- Each request goes to the correct vendor URL.
- The planted evidence line is never sent raw. The SSN, phone, email and client ref C-104 are also absent from every request body. The API key is not in the body or the URL.
- The fake model echoes the privacy tokens back.
- The restored facts contain no tokens and do contain the original SSN, email and phone.
- `out.aiProvider` and `out.privacy` are set; `privacy.findings` holds counts only, never values.

**V2-13 Live mode end to end**
- Sync runs the workflow with Mistral selected in the saved AI settings.
- The session ends in NEEDS_REVIEW with provenance `extractionMode: live`, `aiProvider: mistral`, the chosen model, and `privacy: {scrubbed: false, findings: {}}`. The synthetic transcript contains no PII, so nothing was replaced.
- Exactly one Mistral call was made, with a Bearer key and without C-104 in the body. No other vendor was called.

## Failures and open items

There are no failing v2 integration tests.

Open items:

1. **Typecheck:** passes. `npx tsc --noEmit` exits 0 on a re-run after U2 landed `src/ui/pages/Files.tsx`. The earlier error in `src/ui/App.tsx` about the missing `./pages/Files` is fixed. The UI is still not browser-tested.
2. **Gmail draft link:** `webUrl` is best effort (`#drafts?compose=<messageId>`), as V6 documents. It is not verified against real Gmail. This is a limitation, not a failure.
3. **Workflow wiring coverage:** the v2 harness copies the `src/index.ts` wiring (`onCompleted`, `processFileDelivery`, `resolveSettings`) rather than importing it. A change to the composition root therefore needs a matching harness change.

## Whole-repo run

`npx vitest run` passed: **33 test files, 628 tests, all passed**, 0 failed and 0 skipped. This includes `tests/integration/v2-flow.test.ts` with 18 of 18 passing.
