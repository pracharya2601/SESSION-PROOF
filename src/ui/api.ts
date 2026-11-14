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
} from "../contracts";

/** GET /api/me — shape kept loose; the server derives identity. */
export interface MeResponse {
  providerId: string;
  identity?: string;
  email?: string;
  displayName?: string;
  authMode?: "dev" | "access";
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
};

export function exportUrl(id: string, format: "json" | "html"): string {
  return `/api/sessions/${enc(id)}/export?format=${format}`;
}
