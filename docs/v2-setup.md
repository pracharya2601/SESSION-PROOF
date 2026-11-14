# v2 setup: cloud connections, AI providers, privacy

This guide covers what v2 needs beyond the v1 runbook (`docs/runbook.md`):

- OAuth clients for **Google** (Drive and Gmail) and **Microsoft** (OneDrive and Outlook)
- API keys for the four inference providers
- the token encryption key
- switching extraction to live mode
- how the privacy controller behaves

Everything works in fixture mode with none of this configured. Connections show `not_configured`, and AI providers show `configured: false`.

`APP_ORIGIN` is the exact origin the browser uses, with no trailing slash. Examples are `http://localhost:8787` for local dev and `https://field-assist.example.com` for production. Every OAuth redirect URI is derived from it:

```
${APP_ORIGIN}/auth/connect/google/callback
${APP_ORIGIN}/auth/connect/microsoft/callback
```

The redirect URI registered with each provider must match this string character for character. Scheme, host, port and path all count.

## 1. Google OAuth client (Drive and Gmail)

1. Open Google Cloud Console and create or select a project.
2. Go to **APIs & Services → Library** and enable:
   - **Google Drive API**
   - **Gmail API**
3. Go to **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access) and set it up:
   - User type: *External*, or *Internal* for a Workspace-only deployment.
   - While the app is in *Testing*, add each provider account under **Test users**.
   - Under **Data access**, add these scopes:
     - `openid`
     - `email`
     - `https://www.googleapis.com/auth/drive.file`. The app only sees files and folders it created. It cannot read the rest of the drive.
     - `https://www.googleapis.com/auth/gmail.compose`. This allows creating drafts. The app never calls a send endpoint. The user opens the draft in Gmail and presses Send.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs: add `${APP_ORIGIN}/auth/connect/google/callback` for every origin you use, for example both `http://localhost:8787/...` and the production origin.
   - Authorized JavaScript origins: not needed, because the token exchange happens on the server.
5. Copy the **Client ID** into `GOOGLE_CLIENT_ID` and the **Client secret** into `GOOGLE_CLIENT_SECRET`.

The app asks for offline access, so Google returns a refresh token on the first consent. To force a new refresh token, remove the app at https://myaccount.google.com/permissions and connect again.

## 2. Microsoft Entra app (OneDrive and Outlook)

1. Open the Entra admin center and go to **Identity → Applications → App registrations → New registration**.
   - Supported account types:
     - *Single tenant*: set `MS_TENANT` to your tenant ID or domain.
     - *Any organizational directory*: use `MS_TENANT=organizations`.
     - *Organizational directories and personal Microsoft accounts*: use `MS_TENANT=common`, which is the default when the variable is unset.
   - Redirect URI: platform **Web**, value `${APP_ORIGIN}/auth/connect/microsoft/callback`. Add one per origin under **Authentication** afterwards.
2. Go to **Certificates & secrets → New client secret**. Copy the secret **Value**, not the Secret ID, into `MS_CLIENT_SECRET`. Note the expiry date and rotate the secret before it expires.
3. Copy the **Application (client) ID** from Overview into `MS_CLIENT_ID`.
4. Go to **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add:
   - `openid`
   - `email`
   - `offline_access` (needed for refresh tokens)
   - `User.Read`
   - `Files.ReadWrite` (needed to create the folder and upload the PDFs to OneDrive)
   - `Mail.ReadWrite` (needed to create drafts with attachments)

   Do **not** add `Mail.Send`. The app never sends mail.

   If your tenant requires admin consent, click **Grant admin consent**.

## 3. Secrets and variables

| Name | Kind | Needed for |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | secret, base64 encoding of exactly 32 bytes | Encrypting stored OAuth tokens (AES-256-GCM). **Required** for connections. |
| `SESSION_SECRET` | secret | Session cookies (v1) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | Google connection |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | secret | Microsoft connection |
| `MS_TENANT` | var or secret | Microsoft tenant (`common`, `organizations`, a tenant ID or a domain). Default `common`. |
| `ANTHROPIC_API_KEY` | secret | Anthropic. The legacy name `AI_API_KEY` is still read. |
| `OPENAI_API_KEY` | secret | OpenAI |
| `GEMINI_API_KEY` | secret | Google Gemini |
| `MISTRAL_API_KEY` | secret | Mistral |
| `OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `MISTRAL_BASE_URL`, `AI_GATEWAY_URL` | var, optional | Base URL overrides, for example a Cloudflare AI Gateway |
| `AI_PROVIDER` | var, optional | Default provider for users without AI settings (`anthropic`, `openai`, `gemini` or `mistral`) |
| `EXTRACTION_MODE` | var | `fixture` (default) or `live` |

A provider whose key is missing shows as not configured in **Settings → AI**. A live extraction that selects it fails with a non-retryable `not_configured` error. There is no silent fallback to another provider or to fixtures.

### Local (`.dev.vars`, never committed)

```ini
SESSION_SECRET=dev-only-session-secret-change-me-0123456789
TOKEN_ENCRYPTION_KEY=<output of: openssl rand -base64 32>
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_TENANT=common
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
MISTRAL_API_KEY=...
# EXTRACTION_MODE=live
```

Restart `wrangler dev` after editing. Values in `.dev.vars` override `vars` in `wrangler.jsonc`.

### Deployed (`wrangler secret put`)

```sh
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY --env production
npx wrangler secret put GOOGLE_CLIENT_ID      --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET  --env production
npx wrangler secret put MS_CLIENT_ID          --env production
npx wrangler secret put MS_CLIENT_SECRET      --env production
npx wrangler secret put MS_TENANT             --env production   # or set it as a var
npx wrangler secret put ANTHROPIC_API_KEY     --env production
npx wrangler secret put OPENAI_API_KEY        --env production
npx wrangler secret put GEMINI_API_KEY        --env production
npx wrangler secret put MISTRAL_API_KEY       --env production
npx wrangler secret list --env production     # shows names only
```

Changing `TOKEN_ENCRYPTION_KEY` makes every stored connection undecryptable. After rotating it, users must reconnect.

## 4. Switching extraction to live

1. Put the key for at least one provider in place (section 3).
2. Set `EXTRACTION_MODE=live`:
   - locally, in `.dev.vars`
   - for production, in `env.production.vars` in `wrangler.jsonc`, then redeploy
3. In the app, open **Settings → AI** and pick the provider and model. The choice is saved per user (`PUT /api/settings/ai`). Users without saved settings get `AI_PROVIDER`, which defaults to `anthropic`, with the default model for that provider.
4. Sync a session. The bundle provenance shows `extractionMode: live`, the provider and model, and the privacy report.

`EVIDENCE_MODE` is a separate setting. Live evidence needs the Vexo MCP client, as in v1.

## 5. Privacy controller

Every live inference call goes through the privacy controller (`src/privacy`) before any data leaves the Worker:

1. **Prepare.** Evidence excerpts are scanned, and PII is replaced with stable tokens such as `[NAME_1]`, `[EMAIL_1]`, `[PHONE_1]`, `[SSN_1]`, `[ID_1]`, `[ADDRESS_1]`, `[DATE_1]` and `[CLIENT_REF_1]`. The same value always gets the same token within one call. Evidence ids, timestamps and speaker roles are kept, so citations still work.
   - Known terms are always redacted. These are the appointment's client reference and any extra terms the caller passes to `buildPrivacyContext`.
   - Speaker labels that look like a person's name, such as "Jane Doe" rather than "Provider" or "Participant", are also redacted. So is every later mention of that name.
   - Pattern detection runs on top of that. The switches in **Settings → AI → Privacy** each control one category:
     - `redactNames`
     - `redactContact` (emails and phone numbers)
     - `redactIdentifiers` (SSN, Medicaid and MRN-style IDs, client refs)
     - `redactAddresses`
     - `redactDates` (DOB-like dates; service timestamps are kept)

     All switches are on by default.
2. **Infer.** Only scrubbed text goes to the selected provider: the system prompt, the scrubbed evidence and the plan goals.
3. **Restore.** Tokens in the model's structured output are mapped back to the original values inside the Worker. The output is then validated (schema, cited evidence ids, plan goal ids) as in v1.
4. **Vault.** The token-to-value map lives only in memory for the duration of the call. It is never persisted, logged or sent anywhere.
5. **Report.** The bundle provenance records the provider, the model and a privacy report.
   - The report has `scrubbed` plus a count of findings per category. It never contains the values themselves.
   - `scrubbed` is `true` only when something was actually replaced. The synthetic demo transcript contains no PII, so it reports `{ scrubbed: false, findings: {} }`.

Fixture extraction makes no network call, so the controller is bypassed there.

## 6. Delivery behaviour (reminder)

- **Upload to Drive/OneDrive.** The app creates the folder path from **Settings → Storage** (`{clientRef}` and `{serviceDate}` are expanded) and uploads the three PDFs: Session Note, Invoice and Approval Record. If **Auto-upload on completion** is on, this runs automatically when a session is COMPLETED.
- **Email draft.** The app creates a **draft** in Gmail or Outlook with the rendered subject and body, the recipients and the PDF attachments, and returns a link that opens the draft. The app never sends mail. The user reviews the draft and presses Send in their mail client.
- Tokens are stored encrypted and never returned by any API. `GET /api/connections` shows only the status, the account email and the scopes.
