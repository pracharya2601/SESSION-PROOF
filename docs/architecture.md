# Architecture

Types live in `src/contracts/` (v1 `schemas.ts`, `v2.ts`, `v3.ts`), `src/db/repository.ts`, `src/api/deps.ts` and `src/env.ts`. Those files are the source of truth; this page is the map.

## Flow
```
cron */5 (or POST /api/sync)
  → jobs.discoverSessions: per provider, respects sync settings (interval, lookback)
  → Queue → handleQueueBatch → SESSION_WORKFLOW.create(wf-<session>-r<rev>)
  → runSessionWorkflow steps:
      load → evidence → match → privacy → extraction → assemble → draft_saved
      → approval_wait   (waitForEvent "provider-approved")
      → approved → client_snapshot → finalize → files → completed
  → onCompleted → optional auto-upload (file_delivery job)
```
- **Review** (`PATCH /review`) creates a new bundle revision with the server recalculating checks and billing.
- **Approve** (`POST /approve`) stores a durable approval and notifies the workflow. If no live instance exists, `jobs.notifyApproval` calls `finalizeDirect` instead.
- **Amend** (`POST /amend`) moves the final into `superseded_finals`, opens revision n+1 with an `amendment_reason` attestation, and requires approval again.

## Modules
| Concern | Exports | File |
|---|---|---|
| Domain (pure) | `matchEvidence`, `generateDocuments`, `validateRequirements`, `calculateBilling`, `assembleBundle` | `src/domain/*` (re-exported from `src/domain/index.ts`) |
| Fixtures/seed | `getVariant`, `VARIANT_NAMES`, `seedDemoData(repo, {variant?})` | `fixtures/variants.ts`, `src/calendar/seed.ts` |
| Evidence | `createEvidenceSource(env, {mcpClient?})`, `VexoMcpClient` (to be filled by the MCP server) | `src/integrations/vexo/` |
| Extraction | `createExtractor(env, {fetch?, resolveSettings?, resolveKnownTerms?})`, `validateExtraction` | `src/ai/index.ts` |
| Inference adapter | `createInferenceProvider(env, {provider, model})`, `aiProviderStatuses(env)` | `src/ai/providers/` |
| Privacy | `createPrivacyController()`, `scrubText`, `buildPrivacyContext` | `src/privacy/` |
| Persistence | `createRepository(db)` | `src/db/d1.ts` |
| Jobs | `discoverSessions`, `dispatchPendingDeliveries`, `notifyApproval`, `handleQueueBatch`, `runScheduledSync` | `src/jobs/index.ts` |
| Workflow | `runSessionWorkflow(deps, params, step)`, `SessionWorkflow`, `setWorkflowDepsFactory` | `src/workflow/` |
| Approval | `saveReview`, `approveSession`, `amendSession`, `finalizeDirect`, `ServiceError` | `src/services/approval/` |
| Documents | `buildDocModel(kind, input)`, `renderDocModelPdf(model)`, `BUILTIN_TEMPLATES`, `normalizeTemplate`, `resolveTemplate`, `loadDocModelInput` | `src/documents/`, `src/services/documents/` |
| Files (compat) | `renderFilePdf`, `fileNameFor`, `sessionFiles` | `src/artifacts/` |
| Clients | `effectiveRate`, `snapshotClient`, `clientKnownTerms` | `src/clients/` |
| Cloud | `startConnection`, `completeConnection`, `getValidAccessToken`; `storageAdapterFor`, `mailAdapterFor` | `src/connections/`, `src/integrations/cloud/` |
| Delivery | `uploadToDrive`, `createEmailDraft`, `processFileDelivery`, `onSessionCompleted` | `src/services/delivery/` |
| Run history | `createRunRecorder(repo, clock)`. Recording never fails the operation | `src/history/` |
| Security | `requireActor`, `originGuard`, `apiError`, `encryptToken`/`decryptToken`, `log` (redacting), `escapeHtml` | `src/security/` |
| Export | `renderExportHtml`, `exportJson` | `src/export/` |

## Routes
Every `/api/*` route needs the actor (cookie in dev, Access header in production), except `/api/health`. Mutations must be same-origin. Responses are wrapped as `{ data, correlationId }` or `{ error }` with `Cache-Control: no-store`.

| Area | Routes |
|---|---|
| Auth | `POST /auth/dev-login`, `POST /auth/logout`, `GET /api/me`, `GET /api/health` |
| Sessions | `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sync` (202) |
| Review | `PATCH /api/sessions/:id/review`, `POST /api/sessions/:id/approve` (202 pending / 200 finalized), `POST /api/sessions/:id/amend`, `GET /api/sessions/:id/revisions`, `GET /api/sessions/:id/export?format=json\|html` |
| Documents/files | `GET /api/sessions/:id/documents/:kind?templateId` (DocModel), `GET /api/sessions/:id/files/:kind[?inline=1]` (PDF), `GET /api/files` |
| Delivery | `GET /api/sessions/:id/deliveries`, `POST …/deliveries/drive`, `POST …/deliveries/email-draft` |
| Connections | `GET /api/connections`, `POST /api/connections/:provider/start`, `DELETE /api/connections/:provider`, `GET /auth/connect/:provider/callback` |
| Settings | `GET /api/settings`, `PUT /api/settings/storage\|email\|ai`, `GET/PUT /api/settings/sync` |
| Clients | `GET /api/clients?search&includeInactive`, `GET/PUT /api/clients/:ref` |
| Templates | `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id` (builtin → 409), `PUT /api/templates/default/:kind`, `POST /api/templates/preview` |
| Runs | `GET /api/runs?status&sessionId&cursor`, `GET /api/runs/:runId` |
| Dev only (dev auth + local runtime) | `POST /api/dev/seed`, `POST /api/dev/reset-session/:id` |

## Data rules
- **Rate freeze:** the client's hourly rate goes into `config.rate` when a draft is assembled (`rateVersion = client:<ref>:v<n>`). A rate change after approval never changes an approved invoice.
- **Client snapshot:** taken at finalize (`saveClientSnapshot`). Documents for a finalized revision use the snapshot, never the live client.
- **One document model:** `buildDocModel` feeds both the UI (`DocPreview`, HTML/CSS paged like a PDF) and `renderDocModelPdf`. A PDF is produced only when a file is downloaded or delivered.
- **Privacy:** client `displayName`/`preferredName` are added as known NAME terms and are never sent to AI. Run events hold stages, statuses, counts, provider/model ids and reason codes only.
- **Run ids:** a processing run is `workflowInstanceId(sessionId, processingRevision)`; a delivery run is `delivery:<deliveryId>`.

## UI
Hash routes: `#/` Today, `#/sessions/:id` Review, `#/files`, `#/clients[/:ref]`, `#/templates[/:id]`, `#/runs[/:runId]`, `#/connections`, `#/settings`. The design system is in `src/ui/design/` (Button, Card, Badge, Field, Dialog, Toast, motion presets…). The API client is `src/ui/api.ts`.

Review page (`src/ui/pages/Review.tsx`, `src/ui/components/review/`): the documents sit on the left. The right rail holds the status card with `ApprovalChecklist` (blockers → Fix → Save → Approve), the correction form, the files card, the approval record, `AmendCard` (Amend, earlier revisions, dev reset) and `RunTimeline`.

## Migrations
`0001_init` · `0002_sync_settings` · `0003_v2` (connections, settings, deliveries) · `0004_v3` (clients, templates, snapshots, run events) · `0005_amendments` (`superseded_finals`).
