# Frozen cross-agent interfaces (Agent 01)

Every agent builds against these names. Do not rename. Types come from `src/contracts`, `src/db/repository.ts`, `src/api/deps.ts`, `src/env.ts`.

## Domain (pure)
| Export | File | Owner |
|---|---|---|
| `matchEvidence: MatchEvidenceFn` | `src/domain/matching/index.ts` | 08 |
| `generateDocuments: GenerateDocumentsFn` | `src/domain/documents/index.ts` | 11 |
| `validateRequirements: ValidateRequirementsFn` | `src/domain/rules/index.ts` | 12 |
| `calculateBilling: CalculateBillingFn` | `src/domain/billing/index.ts` | 13 |
| `assembleBundle: AssembleBundleFn` | `src/domain/bundle.ts` | 11 (imports 12, 13 by the names above) |
| re-exports of all five | `src/domain/index.ts` | 11 |

## Fixtures / evidence / AI
| Export | File | Owner |
|---|---|---|
| `getVariant(name): { evidence: EvidenceResult \| Error; extractionRaw: unknown; extraAppointments: Appointment[] }`, `VARIANT_NAMES` | `fixtures/variants.ts` | 05 |
| `seedDemoData(repo: Repository, opts?: { variant?: string }): Promise<void>` | `src/calendar/seed.ts` | 05 |
| `VexoTokenProvider`, `notConfiguredTokenProvider` | `src/auth/vexo/index.ts` | 06 |
| `VexoMcpClient`, `createEvidenceSource(env, opts?: { mcpClient?: VexoMcpClient }): EvidenceSource` | `src/integrations/vexo/index.ts` | 07 |
| `createExtractor(env, opts?: { fetch?: typeof fetch }): Extractor`, `validateExtraction(raw, ctx): SessionFacts` | `src/ai/index.ts` | 10 |

## Persistence / jobs / workflow
| Export | File | Owner |
|---|---|---|
| `createRepository(db: D1Database): Repository` | `src/db/d1.ts` | 04 |
| `migrations/0001_init.sql` | | 04 |
| `JobDeps`, `discoverSessions(deps)`, `dispatchPendingDeliveries(deps)`, `notifyApproval(deps, approval)`, `handleQueueBatch(batch, deps)` | `src/jobs/index.ts` | 09 |
| `WorkflowDeps`, `StepLike`, `runSessionWorkflow(deps, params, step)` | `src/workflow/run.ts` | 14 |
| `SessionWorkflow` class, `setWorkflowDepsFactory(fn: (env: Env) => WorkflowDeps)` | `src/workflow/index.ts` | 14 |

```ts
interface JobDeps { repo: Repository; workflow: Workflow<WorkflowParams>; queue: Queue<QueuePayload>; clock: Clock; lookbackMinutes?: number; maxAttempts?: number }
interface WorkflowDeps { repo: Repository; evidence: EvidenceSource; extractor: Extractor; match: MatchEvidenceFn; assemble: AssembleBundleFn; clock: Clock; runtimeMode: RuntimeMode; approvalTimeout?: string }
interface StepLike { do<T>(name: string, fn: () => Promise<T>): Promise<T>; waitForEvent<T>(name: string, opts: { type: string; timeout: string | number }): Promise<{ payload: T }> }
```

## HTTP
| Export | File | Owner |
|---|---|---|
| `correlationId()`, `requireActor(deps)`, `originGuard(deps)` (Hono middleware), `apiError(c, status, code, message, retryable)`, `authRoutes(deps): Hono<AppBindings>` (POST /auth/dev-login, POST /auth/logout, GET /api/me), `encryptToken`, `decryptToken`, `log(level, event, fields)`, `escapeHtml(s)` | `src/security/index.ts` | 19 |
| `createApi(deps: ApiDeps): Hono` — mounts security middleware, `authRoutes`, health, sessions, sync, dev seed, and `reviewRoutes`; global error handler | `src/api/index.ts` | 15 |
| `healthRoutes`, `sessionRoutes`, `syncRoutes` | `src/api/health.ts`, `sessions.ts`, `sync.ts` | 15 |
| `reviewRoutes(deps): Hono<AppBindings>` — PATCH /api/sessions/:id/review, POST /api/sessions/:id/approve, GET /api/sessions/:id/export | `src/api/review.ts` | 16 |
| `saveReview(deps, actor, sessionId, req): Promise<SessionBundle>`, `approveSession(deps, actor, sessionId, req): Promise<ApproveResponse>`; expected failures throw `class ServiceError(status, code, message, retryable, details?)` (also exported here) | `src/services/approval/index.ts` | 16 |
| `renderExportHtml(final: FinalBundle): string`, `exportJson(final)` | `src/export/index.ts` | 16 |

Routes: GET /api/health · GET /api/me · GET /api/sessions · GET /api/sessions/:id · POST /api/sync (202) · POST /api/dev/seed (dev only) · PATCH /api/sessions/:id/review · POST /api/sessions/:id/approve (202 pending / 200 finalized) · GET /api/sessions/:id/export?format=json|html · POST /auth/dev-login · POST /auth/logout.
Envelopes: success `{ data, correlationId }`; failure `{ error: ApiError }`.

## UI
| Export | File | Owner |
|---|---|---|
| `api` object: `me() health() listSessions(cursor?) getSession(id) sync() seed() devLogin(identity) logout() saveReview(id, ReviewRequest) approve(id, ApprovalRequest): Promise<{ status: number; data: ApproveResponse }>`, `exportUrl(id, "json"\|"html")`, `class ApiClientError { status; code; message; correlationId; retryable }` | `src/ui/api.ts` | 17 |
| `App` (hash routes `#/`, `#/sessions/:id`), renders `<Review sessionId={id} onBack={…} />` | `src/ui/App.tsx` | 17 |
| `export default function Review(props: { sessionId: string; onBack: () => void })` | `src/ui/pages/Review.tsx` | 18 |
| CSS in `src/ui/styles/app.css` (17); review-specific classes prefixed `rv-` may live in `src/ui/components/review/review.css` (18) | | |

## Composition root
`src/index.ts` (Agent 01) wires: fetch → `createApi`, scheduled → discover + dispatch, queue → `handleQueueBatch`, exports `SessionWorkflow`.
