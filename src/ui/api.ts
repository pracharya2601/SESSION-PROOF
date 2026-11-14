/**
 * Browser API client (Agent 17). Same-origin JSON fetch against the Worker.
 * Success envelope: { data, correlationId }. Failure envelope: { error }.
 */
import type {
  ApprovalRequest,
  ApproveResponse,
  DiscoverySummary,
  DispatchSummary,
  HealthResponse,
  ListSessionsResponse,
  ReviewRequest,
  SessionBundle,
  SessionDetail,
  SupersededRevision,
  SyncSettings,
  SyncSettingsView,
  // v2
  AiSettings,
  Connection,
  ConnectionProvider,
  DriveUploadRequest,
  EmailDraftRequest,
  EmailSettings,
  FileDelivery,
  FileKind,
  ListFilesResponse,
  SettingsBundle,
  StartConnectionResponse,
  StorageSettings,
  // v3
  ClientInput,
  ClientRecord,
  ClientSummary,
  DocModel,
  DocumentTemplate,
  ListRunsResponse,
  PreviewTemplateRequest,
  RunDetail,
  RunSummary,
  TemplateInput,
  // band capture
  CaptureStatus,
  StartVisitRequest,
  StartVisitResponse,
  StopVisitResponse,
  VisitDetail,
  // paired devices
  PairDeviceResponse,
  PairedDevice,
} from "../contracts";
import type {
  ListNotificationsResponse,
  NotificationSettings,
  NotificationSettingsView,
  TestNotificationResult,
} from "../notify/types";

/** GET /api/me — shape kept loose; the server derives identity. */
export interface MeResponse {
  providerId: string;
  identity?: string;
  email?: string;
  displayName?: string;
  authMode?: "dev" | "access" | "public";
  [key: string]: unknown;
}

export interface SyncResponse {
  discovery?: DiscoverySummary;
  dispatch?: DispatchSummary;
  [key: string]: unknown;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, correlationId: string, retryable: boolean) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.retryable = retryable;
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiClientError(0, "NETWORK", "The server could not be reached. Check your connection and retry.", "", true);
  }

  const headerCid = res.headers.get("x-correlation-id") ?? "";
  let json: unknown = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;

  if (!res.ok || "error" in obj) {
    const err = (obj.error && typeof obj.error === "object" ? obj.error : {}) as Record<string, unknown>;
    throw new ApiClientError(
      res.status,
      typeof err.code === "string" ? err.code : res.status >= 500 ? "SERVER_ERROR" : "HTTP_" + res.status,
      typeof err.message === "string" ? err.message : `Request failed (${res.status}).`,
      typeof err.correlationId === "string" ? err.correlationId : headerCid,
      typeof err.retryable === "boolean" ? err.retryable : res.status >= 500 || res.status === 429,
    );
  }
  if (!("data" in obj)) {
    throw new ApiClientError(res.status, "BAD_RESPONSE", "Unexpected response from server.", headerCid, true);
  }
  return { status: res.status, data: obj.data as T };
}

async function dataOf<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return (await request<T>(method, path, body)).data;
}

const enc = encodeURIComponent;

export const api = {
  me: () => dataOf<MeResponse>("GET", "/api/me"),
  health: () => dataOf<HealthResponse>("GET", "/api/health"),
  listSessions: (cursor?: string) =>
    dataOf<ListSessionsResponse>("GET", "/api/sessions" + (cursor ? `?cursor=${enc(cursor)}` : "")),
  getSession: (id: string) => dataOf<SessionDetail>("GET", `/api/sessions/${enc(id)}`),
  sync: () => dataOf<SyncResponse>("POST", "/api/sync", {}),
  getSyncSettings: () => dataOf<SyncSettingsView>("GET", "/api/settings/sync"),
  saveSyncSettings: (settings: SyncSettings) => dataOf<SyncSettingsView>("PUT", "/api/settings/sync", settings),
  seed: () => dataOf<unknown>("POST", "/api/dev/seed", {}),
  devLogin: (identity: string) => dataOf<MeResponse>("POST", "/auth/dev-login", { identity }),
  logout: () => dataOf<unknown>("POST", "/auth/logout", {}),
  saveReview: (id: string, req: ReviewRequest) =>
    dataOf<SessionBundle>("PATCH", `/api/sessions/${enc(id)}/review`, req),
  /** Reopen a COMPLETED session as a new revision (requires re-approval). */
  amendSession: (id: string, req: { expectedRevision: number; reason: string }) =>
    dataOf<SessionBundle>("POST", `/api/sessions/${encodeURIComponent(id)}/amend`, req),
  /** Approved revisions that amendments replaced (audit trail). */
  listRevisions: (id: string) => dataOf<SupersededRevision[]>("GET", `/api/sessions/${encodeURIComponent(id)}/revisions`),
  /** DEV ONLY: reset a synthetic session; the next sync re-processes it. */
  devResetSession: (id: string) =>
    dataOf<{ reset: boolean; sessionId: string }>("POST", `/api/dev/reset-session/${encodeURIComponent(id)}`, {}),
  approve: (id: string, req: ApprovalRequest): Promise<{ status: number; data: ApproveResponse }> =>
    request<ApproveResponse>("POST", `/api/sessions/${enc(id)}/approve`, req),

  // ---------------------------------------------------------------- v2
  listFiles: (cursor?: string) =>
    dataOf<ListFilesResponse>("GET", "/api/files" + (cursor ? `?cursor=${enc(cursor)}` : "")),
  /** URL of a session PDF (download by default; `inline: true` for in-browser preview). Not a fetch. */
  fileUrl: (sessionId: string, kind: FileKind, opts?: { inline?: boolean }): string =>
    `/api/sessions/${enc(sessionId)}/files/${enc(kind)}${opts?.inline ? "?inline=1" : ""}`,
  listDeliveries: (sessionId: string) => dataOf<FileDelivery[]>("GET", `/api/sessions/${enc(sessionId)}/deliveries`),
  uploadToDrive: (sessionId: string, req: DriveUploadRequest = {}) =>
    dataOf<FileDelivery>("POST", `/api/sessions/${enc(sessionId)}/deliveries/drive`, req),
  createEmailDraft: (sessionId: string, req: EmailDraftRequest) =>
    dataOf<FileDelivery>("POST", `/api/sessions/${enc(sessionId)}/deliveries/email-draft`, req),
  listConnections: () => dataOf<Connection[]>("GET", "/api/connections"),
  startConnection: (provider: ConnectionProvider, returnTo?: string) =>
    dataOf<StartConnectionResponse>(
      "POST",
      `/api/connections/${enc(provider)}/start`,
      returnTo !== undefined ? { returnTo } : {},
    ),
  disconnect: (provider: ConnectionProvider) =>
    dataOf<{ disconnected: true }>("DELETE", `/api/connections/${enc(provider)}`),
  getSettings: () => dataOf<SettingsBundle>("GET", "/api/settings"),
  saveStorageSettings: (s: StorageSettings) => dataOf<SettingsBundle>("PUT", "/api/settings/storage", s),
  saveEmailSettings: (s: EmailSettings) => dataOf<SettingsBundle>("PUT", "/api/settings/email", s),
  saveAiSettings: (s: AiSettings) => dataOf<SettingsBundle>("PUT", "/api/settings/ai", s),

  // ---------------------------------------------------------------- v3
  listClients: (opts?: { search?: string; includeInactive?: boolean }) =>
    dataOf<ClientSummary[]>(
      "GET",
      "/api/clients" +
        query({ search: opts?.search?.trim() || undefined, includeInactive: opts?.includeInactive ? "1" : undefined }),
    ),
  getClient: (ref: string) => dataOf<ClientSummary>("GET", `/api/clients/${enc(ref)}`),
  saveClient: (input: ClientInput) => dataOf<ClientRecord>("PUT", `/api/clients/${enc(input.clientRef)}`, input),
  listTemplates: (kind?: FileKind) => dataOf<DocumentTemplate[]>("GET", "/api/templates" + query({ kind })),
  createTemplate: (input: TemplateInput) => dataOf<DocumentTemplate>("POST", "/api/templates", input),
  updateTemplate: (id: string, input: TemplateInput) =>
    dataOf<DocumentTemplate>("PUT", `/api/templates/${enc(id)}`, input),
  deleteTemplate: (id: string) => dataOf<{ deleted: true }>("DELETE", `/api/templates/${enc(id)}`),
  setDefaultTemplate: (kind: FileKind, templateId: string | null) =>
    dataOf<{ kind: FileKind; templateId: string | null }>("PUT", `/api/templates/default/${enc(kind)}`, { templateId }),
  previewTemplate: (req: PreviewTemplateRequest) => dataOf<DocModel>("POST", "/api/templates/preview", req),
  getDocument: (sessionId: string, kind: FileKind, templateId?: string) =>
    dataOf<DocModel>("GET", `/api/sessions/${enc(sessionId)}/documents/${enc(kind)}` + query({ templateId })),
  listRuns: (opts?: { status?: RunSummary["status"]; sessionId?: string; cursor?: string }) =>
    dataOf<ListRunsResponse>(
      "GET",
      "/api/runs" + query({ status: opts?.status, sessionId: opts?.sessionId, cursor: opts?.cursor }),
    ),
  getRun: (runId: string) => dataOf<RunDetail>("GET", `/api/runs/${enc(runId)}`),

  // ---------------------------------------------------------------- band capture (Record visit)
  /** Which transcriber a new visit would use now (null = capture unavailable, see reason). */
  captureStatus: () => dataOf<CaptureStatus>("GET", "/api/visits/capture-status"),
  /** Creates the visit (201) and returns the absolute stream URL (with ?token=) for the WebSocket. */
  startVisit: (req: StartVisitRequest) => dataOf<StartVisitResponse>("POST", "/api/visits", req),
  getVisit: (id: string) => dataOf<VisitDetail>("GET", `/api/visits/${enc(id)}`),
  /** Call after the stream sent "done" (or closed): hands the visit to processing. */
  stopVisit: (id: string) => dataOf<StopVisitResponse>("POST", `/api/visits/${enc(id)}/stop`, {}),

  // ---------------------------------------------------------------- paired devices (Settings → Devices)
  listDevices: () => dataOf<PairedDevice[]>("GET", "/api/devices"),
  /** The key and pairing link are returned ONCE; the server keeps only a hash. */
  pairDevice: (name: string) => dataOf<PairDeviceResponse>("POST", "/api/devices", { name }),
  revokeDevice: (id: string) => dataOf<{ revoked: true }>("DELETE", `/api/devices/${enc(id)}`),

  // ---------------------------------------------------------------- notifications (approval hand-off)
  listNotifications: (opts?: { unread?: boolean; limit?: number }) =>
    dataOf<ListNotificationsResponse>(
      "GET",
      "/api/notifications" + query({ unread: opts?.unread ? "1" : undefined, limit: opts?.limit ? String(opts.limit) : undefined }),
    ),
  markNotificationRead: (id: string) => dataOf<{ read: true }>("POST", `/api/notifications/${enc(id)}/read`, {}),
  markAllNotificationsRead: () => dataOf<{ updated: number }>("POST", "/api/notifications/read-all", {}),
  getNotificationSettings: () => dataOf<NotificationSettingsView>("GET", "/api/settings/notifications"),
  saveNotificationSettings: (s: NotificationSettings) =>
    dataOf<NotificationSettingsView>("PUT", "/api/settings/notifications", s),
  sendTestNotification: () => dataOf<TestNotificationResult>("POST", "/api/settings/notifications/test", {}),
};

/**
 * Review-link client (no cookie: the token in the URL is the credential). Same shapes as the
 * session routes, so the Review page runs on it unchanged (see ReviewSource in pages/Review.tsx).
 */
export function reviewLinkApi(token: string) {
  const base = `/api/review-link/${enc(token)}`;
  return {
    getSession: (_id: string) => dataOf<SessionDetail>("GET", base),
    saveReview: (_id: string, req: ReviewRequest) => dataOf<SessionBundle>("PATCH", `${base}/review`, req),
    approve: (_id: string, req: ApprovalRequest) => request<ApproveResponse>("POST", `${base}/approve`, req),
    getDocument: (kind: FileKind, templateId?: string) => dataOf<DocModel>("GET", `${base}/documents/${enc(kind)}` + query({ templateId })),
  };
}

/** Builds `?a=1&b=2` from defined, non-empty values ("" when none). */
function query(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
    .map(([k, v]) => `${enc(k)}=${enc(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export function exportUrl(id: string, format: "json" | "html"): string {
  return `/api/sessions/${enc(id)}/export?format=${format}`;
}
