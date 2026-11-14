# v3 frozen interfaces (Agent 01)

v3 adds clients with a per-client hourly rate, self-determination receipt items (funding & authorization, participant direction, signatures & attestation, custom fields), a template designer, ONE document model rendered two ways (HTML/CSS preview in the UI, PDF only on download / drive sync), and run history ("see the agents working").

Types: `src/contracts/v3.ts` (+ additive ReviewEdits `participantDirected`/`participantChoices` and attestation fields `participant_direction`/`participant_choices` in schemas.ts), `src/db/repository.ts` ("v3" section). Earlier docs: `docs/interfaces.md`, `docs/interfaces-v2.md`.

## Key rules
- **Rate freeze:** the client's hourly rate is applied when a draft bundle is assembled (`config.rate.hourlyRateCents` + `rateVersion = clientRateVersion(ref, v)`), so an approved invoice never changes when the client's rate changes later.
- **Client snapshot:** frozen at finalization (`saveClientSnapshot`), and documents for a finalized revision always use the snapshot, never the live client record.
- **Privacy:** `displayName`/`preferredName` are added to the PII scrubber's known NAME terms. They are never sent to AI. They may appear on documents (provider's own files).
- **One document model:** `buildDocModel()` → `DocModel` (blocks). The UI renders `DocModel` as HTML (`DocPreview`). The server renders the same `DocModel` to PDF (`renderDocModelPdf`) only for `/files/:kind` downloads and drive/email deliveries.
- **History events** never contain transcript text, names, tokens or emails — only stages, statuses, counts, provider/model ids and reason codes.

## Backend modules
| Export | File | Owner |
|---|---|---|
| migration `0004_v3.sql`; v3 repo methods | `migrations/`, `src/db/d1.ts` | W1 |
| `buildDocModel(kind: FileKind, input: DocModelInput): DocModel`, `renderDocModelPdf(model: DocModel): Promise<Uint8Array>`, `BUILTIN_TEMPLATES: Record<FileKind, DocumentTemplate>`, `normalizeTemplate(kind, input: TemplateInput): TemplateInput` (fills/validates section keys), `sampleDocModelInput(template: DocumentTemplate): DocModelInput` (synthetic data for the designer) | `src/documents/index.ts` | W2 |
| `src/artifacts` keeps `renderFilePdf`, `fileNameFor`, `sessionFiles` working (now implemented via `src/documents` with builtin templates) | `src/artifacts/` | W2 |
| `effectiveRate(rate: RateRule, client: ClientRecord \| null): RateRule`, `snapshotClient(client: ClientRecord, rate: RateRule, now: Date): ClientSnapshot`, `clientKnownTerms(client: ClientRecord \| null): { value: string; type: "NAME" }[]`, `clientsRoutes(deps): Hono<AppBindings>` | `src/clients/index.ts`, `src/api/clients.ts` | W3 |
| `resolveTemplate(repo, providerId, kind, client: ClientRecord \| ClientSnapshot \| null, overrideId?): Promise<DocumentTemplate>`, `loadDocModelInput(deps, providerId, sessionId, kind, templateId?): Promise<DocModelInput>`, `templatesRoutes(deps)`, `documentsRoutes(deps)` | `src/services/documents/index.ts`, `src/api/templates.ts`, `src/api/documents.ts` | W4 |
| `createRunRecorder(repo, clock): RunRecorder`, `runsRoutes(deps)` | `src/history/index.ts`, `src/api/runs.ts` | W5 |

## Routes (all `/api/*` behind requireActor; mutations need same-origin)
| Method + path | Body → response | Owner |
|---|---|---|
| GET `/api/clients?search&includeInactive=1` | → `ClientSummary[]` | W3 |
| GET `/api/clients/:ref` | → `ClientSummary` (404 if not the actor's) | W3 |
| PUT `/api/clients/:ref` | `ClientInput` (clientRef must equal :ref) → `ClientRecord` | W3 |
| GET `/api/templates?kind` | → `DocumentTemplate[]` (builtins + custom, `isDefault` set) | W4 |
| POST `/api/templates` | `TemplateInput` → `DocumentTemplate` (id `tpl_<uuid>`) | W4 |
| PUT `/api/templates/:id` | `TemplateInput` → `DocumentTemplate` (builtin → 409 READ_ONLY) | W4 |
| DELETE `/api/templates/:id` | → `{ deleted: true }` (builtin → 409) | W4 |
| PUT `/api/templates/default/:kind` | `{ templateId: string \| null }` → `{ kind, templateId }` | W4 |
| POST `/api/templates/preview` | `PreviewTemplateRequest` → `DocModel` | W4 |
| GET `/api/sessions/:id/documents/:kind?templateId` | → `DocModel` (any session with a bundle; DRAFT banner if not completed) | W4 |
| GET `/api/sessions/:id/files/:kind` (v2) | now = resolved template + client snapshot → PDF | W4 |
| GET `/api/runs?status&sessionId&cursor` | → `ListRunsResponse` | W5 |
| GET `/api/runs/:runId` | → `RunDetail` (runId URL-encoded) | W5 |

## Run history instrumentation (W5)
Processing runs: `runId = workflowInstanceId(sessionId, processingRevision)`. Delivery runs: `runId = "delivery:" + deliveryId`. Emit from: jobs discovery (discovered, queued), workflow (workflow_started, load, evidence, match, privacy, extraction, assemble, draft_saved, approval_wait, approved, client_snapshot, finalize, files, completed / failed), review route (review_saved, approved), delivery service (delivery_drive, delivery_email). `WorkflowDeps` gains `recorder?: RunRecorder` and `resolveClient?: (appointment) => Promise<ClientRecord | null>`; `JobDeps` and `ApiDeps` gain `recorder?: RunRecorder`. Recording never fails the operation.

## UI
| Export | File | Owner |
|---|---|---|
| v3 `api` methods: `listClients(opts?: { search?: string; includeInactive?: boolean })`, `getClient(ref)`, `saveClient(input: ClientInput)`, `listTemplates(kind?)`, `createTemplate(input)`, `updateTemplate(id, input)`, `deleteTemplate(id)`, `setDefaultTemplate(kind, templateId \| null)`, `previewTemplate(req: PreviewTemplateRequest): Promise<DocModel>`, `getDocument(sessionId, kind, templateId?): Promise<DocModel>`, `listRuns(opts?: { status?; sessionId?; cursor? })`, `getRun(runId)` | `src/ui/api.ts` | W6 |
| Routes + sidebar items `#/clients`, `#/clients/:ref`, `#/templates`, `#/templates/:id`, `#/runs`, `#/runs/:runId` (lazy pages) | `src/ui/shell/`, `src/ui/App.tsx` | W6 |
| `export default function Clients()`, `export default function ClientDetail({ clientRef })` | `src/ui/pages/Clients.tsx`, `ClientDetail.tsx`, `src/ui/components/clients/` | W6 |
| `export function DocPreview(props: { model: DocModel; scale?: number; className?: string })` — paged, PDF-like HTML/CSS render of a DocModel (paper size, theme fonts/colors, header band, footer, banner) | `src/ui/components/doc/DocPreview.tsx` (+ css) | W7 |
| `export default function Templates()`, `export default function TemplateEditor({ templateId })` (live designer: theme, sections drag/toggle, text fields, sample vs real session preview) | `src/ui/pages/Templates.tsx`, `TemplateEditor.tsx`, `src/ui/components/templates/` | W7 |
| Files page + Review FilesCard previews switch from PDF iframe to `DocPreview` via `api.getDocument`; Download stays PDF | `src/ui/components/files/PreviewDialog.tsx`, `src/ui/components/review/FilesCard.tsx` | W7 |
| `export default function Runs()`, `export default function RunDetail({ runId })`, `export function RunTimeline(props: { sessionId: string })` (live, animated stage graph) | `src/ui/pages/Runs.tsx`, `RunDetail.tsx`, `src/ui/components/runs/` | W8 |
| Review page: "History" section with `RunTimeline`; CorrectionForm adds participant-direction inputs (directed yes/no, participant choices) | `src/ui/pages/Review.tsx`, `src/ui/components/review/CorrectionForm.tsx` | W8 |
