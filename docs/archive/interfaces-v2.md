# v2 frozen interfaces (Agent 01)

v2 adds: three PDF artifacts per completed session, Files dashboard, cloud connections (Google Drive + Gmail, Microsoft OneDrive + Outlook behind one adapter), email **drafts** with attachments (the user presses Send in their mail app — we never send), Settings/Connections UI, a PII privacy controller in front of every inference call, and one inference adapter for Anthropic / OpenAI / Gemini / Mistral. Plus a full UI redesign.

Types: `src/contracts/v2.ts` (all v2 schemas + ports), `src/db/repository.ts` (v2 section), `src/env.ts` (new secrets), `src/api/deps.ts` (`ApiDeps.fetch?`). v1 doc: `docs/interfaces.md`.

## Backend modules
| Export | File | Owner |
|---|---|---|
| migration `0003_v2.sql`; v2 methods in `createRepository` | `migrations/`, `src/db/d1.ts` | V1 |
| `createInferenceProvider(env, sel: { provider: AiProviderId; model: string }, opts?: { fetch? }): InferenceProvider`, `aiProviderStatuses(env): AiProviderStatus[]`, `apiKeyFor(env, provider): string \| undefined` | `src/ai/providers/index.ts` (+ `anthropic.ts openai.ts gemini.ts mistral.ts`) | V2 |
| `createExtractor(env, opts?: { fetch?; resolveSettings?: (providerId: string) => Promise<AiSettings> ; retryDelayMs? })` — live mode = privacy.prepare → provider.generateStructured → validateExtraction → restoreFacts; provenance gets aiProvider/privacy | `src/ai/index.ts` (existing, refactor) | V2 |
| `createPrivacyController(): PrivacyController`, `scrubText(text, ctx)`, `buildPrivacyContext(appointment, options, extraTerms?)` | `src/privacy/index.ts` | V3 |
| `renderFilePdf(kind: FileKind, input: ArtifactInput): Promise<Uint8Array>`, `fileNameFor(kind, final: FinalBundle): string`, `sessionFiles(sessionId, final): SessionFile[]`, `type ArtifactInput = { final: FinalBundle; approval: ApprovalRecord; providerIdentity: string \| null }` | `src/artifacts/index.ts` | V4 |
| `oauthConfig(env, provider)`, `startConnection(deps, actor, provider, returnTo?) → StartConnectionResponse`, `completeConnection(deps, provider, code, state)`, `getValidAccessToken(deps, providerId, provider): Promise<string>` (refreshes; throws `ConnectionError(code)`), `disconnect(deps, providerId, provider)`, `connectionViews(deps, providerId): Promise<Connection[]>`, `connectionsRoutes(deps): Hono<AppBindings>` | `src/connections/index.ts` | V5 |
| `interface CloudStorageAdapter { ensureFolder(path: string): Promise<{ folderId: string; webUrl: string \| null }>; uploadFile(folderId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ fileId: string; webUrl: string \| null }> }`, `interface MailAdapter { createDraft(d: { to: string[]; cc: string[]; subject: string; bodyText: string; attachments: { filename: string; contentType: string; bytes: Uint8Array }[] }): Promise<{ draftId: string; webUrl: string \| null }> }`, `storageAdapterFor(provider, accessToken, fetch?)`, `mailAdapterFor(provider, accessToken, fetch?)`, `class CloudApiError(status, code, message, retryable)` | `src/integrations/cloud/index.ts` (+ `google.ts`, `microsoft.ts`, `mime.ts`) | V6 |
| `type DeliveryDeps = Pick<ApiDeps, "repo" \| "env" \| "clock" \| "fetch">`, `uploadToDrive(deps, actor, sessionId, req)`, `createEmailDraft(deps, actor, sessionId, req)`, `processFileDelivery(deps, deliveryId)` (jobs), `onSessionCompleted(deps, sessionId)` (enqueue auto upload if enabled), `renderTemplate(tpl, vars)`, `filesRoutes(deps)`, `deliveryRoutes(deps)` | `src/services/delivery/index.ts`, `src/api/files.ts`, `src/api/deliveries.ts` | V7 |
| `settingsV2Routes(deps): Hono<AppBindings>` | `src/api/settings-v2.ts` | V8 |

Agent 01 mounts the routers in `src/api/index.ts`, wires `file_delivery` into `src/jobs`, the completion hook into the workflow, and `resolveSettings` into `src/index.ts`.

## Routes
| Method + path | Body → response | Owner |
|---|---|---|
| GET `/api/files?cursor` | → `ListFilesResponse` | V7 |
| GET `/api/sessions/:id/files/:kind[?inline=1]` | → `application/pdf` (attachment unless inline) | V7 |
| GET `/api/sessions/:id/deliveries` | → `FileDelivery[]` | V7 |
| POST `/api/sessions/:id/deliveries/drive` | `DriveUploadRequest` → `FileDelivery` | V7 |
| POST `/api/sessions/:id/deliveries/email-draft` | `EmailDraftRequest` → `FileDelivery` (webUrl opens the draft) | V7 |
| GET `/api/connections` | → `Connection[]` (always both providers) | V5 |
| POST `/api/connections/:provider/start` | `{ returnTo?: string }` → `StartConnectionResponse` | V5 |
| DELETE `/api/connections/:provider` | → `{ disconnected: true }` | V5 |
| GET `/auth/connect/:provider/callback?code&state` | no cookie needed (state row carries providerId) → 302 `/#/connections?connected=<p>` or `?error=<code>` | V5 |
| GET `/api/settings` | → `SettingsBundle` | V8 |
| PUT `/api/settings/storage` \| `/email` \| `/ai` | `StorageSettings` \| `EmailSettings` \| `AiSettings` → `SettingsBundle` | V8 |
| GET/PUT `/api/settings/sync` | unchanged (v1) | — |

Envelopes unchanged: `{ data, correlationId }` / `{ error }`. All `/api/*` require the actor (cookie) and same-origin for mutations. OAuth redirect URI: `${APP_ORIGIN}/auth/connect/${provider}/callback`. Scopes — Google: `openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.compose`; Microsoft: `openid email offline_access User.Read Files.ReadWrite Mail.ReadWrite`.

## UI (React 18 + framer-motion 11 + lucide-react; no other UI libs)
| Export | File | Owner |
|---|---|---|
| v2 methods on `api`: `listFiles(cursor?)`, `fileUrl(sessionId, kind, opts?: { inline?: boolean })`, `listDeliveries(sessionId)`, `uploadToDrive(sessionId, req)`, `createEmailDraft(sessionId, req)`, `listConnections()`, `startConnection(provider, returnTo?)`, `disconnect(provider)`, `getSettings()`, `saveStorageSettings(s)`, `saveEmailSettings(s)`, `saveAiSettings(s)` (existing v1 methods keep working) | `src/ui/api.ts` | U1 |
| Design system: `Button` (variant primary/secondary/ghost/danger, size sm/md, loading, icon), `Card` (interactive?, glow?), `Badge` (tone neutral/info/success/warning/danger/fixture), `Input`, `Textarea`, `Select`, `Switch`, `Field` (label/hint/error), `Tabs`, `Dialog`, `Skeleton`, `EmptyState`, `PageHeader` (title, subtitle, actions), `AnimatedNumber`, `StatusPill` (SessionStatus), `useToast()` + `<ToastProvider>`, motion presets `fadeUp`, `stagger`, `pageTransition`, `springy` | `src/ui/design/index.ts` (+ files in `src/ui/design/`), `src/ui/styles/` | U1 |
| Shell: sidebar nav (Today, Files, Connections, Settings), top bar with mode badges + identity, animated page transitions, routes `#/`, `#/sessions/:id`, `#/files`, `#/connections`, `#/settings` | `src/ui/App.tsx`, `src/ui/shell/` | U1 |
| Today dashboard (redesign) | `src/ui/pages/Today.tsx` | U1 |
| `export default function Files()`, `export default function Connections()`, `export default function Settings()` | `src/ui/pages/Files.tsx`, `Connections.tsx`, `Settings.tsx` (+ `src/ui/components/files/`, `connections/`, `settings/`) | U2 |
| `export default function Review(props: { sessionId: string; onBack: () => void })` (redesign, same behaviour) | `src/ui/pages/Review.tsx`, `src/ui/components/review/` | U3 |
