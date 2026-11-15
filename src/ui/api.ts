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
  BusinessProfileView,
  ProviderProfileInput,
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
import type { AssistantMessage, AssistantReply, AssistantStatus } from "../assistant/types";
import type { Recording } from "../contracts";
import type {
  AcceptSuggestionRequest,
  AcceptSuggestionResponse,
  ArchiveKind,
  ArchivedItemView,
  AuditEntry,
  RecordingDetailView,
  RecordingSuggestion,
  RecordingTimelineEvent,
} from "./components/recordings/types";

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

/** Fired on window when a call fails with a network error or 5xx (shell/ServerBanner.tsx listens). */
export const SERVER_TROUBLE_EVENT = "vexo:server-trouble";
/** Fired on window when /api/health answers again after SERVER_TROUBLE_EVENT. Pages may refetch. */
export const SERVER_RECOVERED_EVENT = "vexo:server-recovered";

function reportTrouble(): void {
  try {
    window.dispatchEvent(new Event(SERVER_TROUBLE_EVENT));
  } catch {
    /* not in a browser (tests) */
  }
}

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts?: { silent?: boolean },
): Promise<{ status: number; data: T }> {
  try {
    return await doRequest<T>(method, path, body);
  } catch (err) {
    if (!opts?.silent && err instanceof ApiClientError && (err.code === "NETWORK" || err.status >= 500)) reportTrouble();
    throw err;
  }
}

async function doRequest<T>(method: Method, path: string, body?: unknown): Promise<{ status: number; data: T }> {
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
  health: (opts?: { silent?: boolean }) =>
    request<HealthResponse>("GET", "/api/health", undefined, opts).then((r) => r.data),
  /** Archived sessions are left out unless includeArchived. */
  listSessions: (cursor?: string, opts?: { includeArchived?: boolean }) =>
    dataOf<ListSessionsResponse>(
      "GET",
      "/api/sessions" + query({ cursor: cursor || undefined, includeArchived: opts?.includeArchived ? "1" : undefined }),
    ),
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
  /** Review assistant: is it configured (AI key)? Silent: a 503 here is not server trouble. */
  assistantStatus: (id: string) =>
    request<AssistantStatus>("GET", `/api/sessions/${enc(id)}/assistant`, undefined, { silent: true }).then((r) => r.data),
  /** Review assistant turn: returns a reply and PROPOSALS (never applied; apply with saveReview). */
  askAssistant: (id: string, req: { messages: AssistantMessage[]; expectedRevision: number }) =>
    request<AssistantReply>("POST", `/api/sessions/${enc(id)}/assistant`, req, { silent: true }).then((r) => r.data),

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
  getBusinessProfile: () => dataOf<BusinessProfileView>("GET", "/api/settings/business-profile"),
  saveBusinessProfile: (p: ProviderProfileInput) => dataOf<BusinessProfileView>("PUT", "/api/settings/business-profile", p),

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
  /** Archived runs (and runs of archived sessions) are left out unless includeArchived. */
  listRuns: (opts?: { status?: RunSummary["status"]; sessionId?: string; cursor?: string; includeArchived?: boolean }) =>
    dataOf<ListRunsResponse>(
      "GET",
      "/api/runs" +
        query({
          status: opts?.status,
          sessionId: opts?.sessionId,
          cursor: opts?.cursor,
          includeArchived: opts?.includeArchived ? "1" : undefined,
        }),
    ),
  getRun: (runId: string) => dataOf<RunDetail>("GET", `/api/runs/${enc(runId)}`),

  // ---------------------------------------------------------------- band capture (Record visit)
  /** Which transcriber a new visit would use now (null = capture unavailable, see reason). */
  captureStatus: () => dataOf<CaptureStatus>("GET", "/api/visits/capture-status"),
  /** Creates the visit (201): the stream URL (no token) + `streamToken` for the WebSocket subprotocol. */
  startVisit: (req: StartVisitRequest) => dataOf<StartVisitResponse>("POST", "/api/visits", req),
  getVisit: (id: string) => dataOf<VisitDetail>("GET", `/api/visits/${enc(id)}`),
  /** Call after the stream sent "done" (or closed): hands the visit to processing. */
  stopVisit: (id: string) => dataOf<StopVisitResponse>("POST", `/api/visits/${enc(id)}/stop`, {}),

  // ---------------------------------------------------------------- paired devices (Settings → Devices)
  listDevices: () => dataOf<PairedDevice[]>("GET", "/api/devices"),
  /** The key and pairing link are returned ONCE; the server keeps only a hash. */
  pairDevice: (name: string) => dataOf<PairDeviceResponse>("POST", "/api/devices", { name }),
  revokeDevice: (id: string) => dataOf<{ revoked: true }>("DELETE", `/api/devices/${enc(id)}`),

  // ---------------------------------------------------------------- recordings (client-less, partitioned)
  /** Newest first; archived recordings are listed by listArchived("recording"). */
  listRecordings: () => dataOf<Recording[]>("GET", "/api/recordings"),
  getRecording: (id: string) => dataOf<RecordingDetailView>("GET", `/api/recordings/${enc(id)}`),
  /** Calendar lanes for the detail timeline. */
  recordingEvents: (id: string) => dataOf<{ events: RecordingTimelineEvent[] }>("GET", `/api/recordings/${enc(id)}/events`),
  acceptSuggestion: (recordingId: string, suggestionId: string, req: AcceptSuggestionRequest = {}) =>
    dataOf<AcceptSuggestionResponse>("POST", `/api/recordings/${enc(recordingId)}/suggestions/${enc(suggestionId)}/accept`, req),
  rejectSuggestion: (recordingId: string, suggestionId: string) =>
    dataOf<{ suggestion: RecordingSuggestion }>("POST", `/api/recordings/${enc(recordingId)}/suggestions/${enc(suggestionId)}/reject`, {}),

  // ---------------------------------------------------------------- archive / delete (src/api/archive.ts)
  listArchived: (kind: ArchiveKind) => dataOf<{ items: ArchivedItemView[] }>("GET", "/api/archive" + query({ kind })),
  archive: (kind: ArchiveKind, id: string, reason?: string) =>
    dataOf<{ item: ArchivedItemView }>("POST", `/api/archive/${enc(kind)}/${enc(id)}`, reason ? { reason } : {}),
  unarchive: (kind: ArchiveKind, id: string) => dataOf<{ unarchived: true }>("DELETE", `/api/archive/${enc(kind)}/${enc(id)}`),
  /** 409 ARCHIVE_ONLY for approved sessions, SESSION_BUSY while processing. */
  deleteSession: (id: string) => dataOf<{ deleted: true }>("DELETE", `/api/sessions/${enc(id)}`),
  deleteRecording: (id: string) => dataOf<{ deleted: true }>("DELETE", `/api/recordings/${enc(id)}`),
  /** 409 ARCHIVE_ONLY for a processing run whose session still exists. */
  deleteRun: (runId: string) => dataOf<{ deleted: true }>("DELETE", `/api/runs/${enc(runId)}`),
  listAudit: (limit?: number) => dataOf<{ entries: AuditEntry[] }>("GET", "/api/audit" + query({ limit: limit ? String(limit) : undefined })),

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
