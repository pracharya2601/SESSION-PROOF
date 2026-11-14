/**
 * v2 file deliveries (Agent V7): Drive/OneDrive uploads and email DRAFTS
 * (never sent) of the three PDF artifacts of a COMPLETED session.
 */
import {
  FILE_KINDS,
  type ApprovalRecord,
  type ConnectionProvider,
  type DriveUploadRequest,
  type EmailDraftRequest,
  type FileDelivery,
  type FileKind,
  type FinalBundle,
  type SessionRecord,
} from "../../contracts";
import type { ApiDeps, Actor } from "../../api/deps";
import { buildDocModel, renderDocModelPdf } from "../../documents/index";
import { ConnectionError, getValidAccessToken } from "../../connections/index";
import { CloudApiError, mailAdapterFor, storageAdapterFor } from "../../integrations/cloud/index";
import { log } from "../../security/index";
import { ServiceError } from "../approval/index";
import { safeRecord } from "../../history/index";
import { loadDocModelInputForSession } from "../documents/index";

export type DeliveryDeps = Pick<ApiDeps, "repo" | "env" | "clock" | "fetch" | "recorder">;

const PDF = "application/pdf";

// ------------------------------------------------------------------ templates
const PLACEHOLDER = /\{(clientRef|serviceDate|serviceCode|amount|revision|providerIdentity)\}/g;

/**
 * Replaces the known placeholders; unknown `{...}` are left as-is.
 * Values have CR/LF stripped (safe for subjects / header-ish contexts).
 */
export function renderTemplate(tpl: string, vars: Partial<Record<string, string | number | null | undefined>>): string {
  return tpl.replace(PLACEHOLDER, (whole, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return whole;
    return String(v).replace(/[\r\n]+/g, " ");
  });
}

function stripLineBreaks(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function serviceDate(final: FinalBundle): string {
  const a = final.bundle.appointment;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: a.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(a.startAt),
    );
  } catch {
    return a.startAt.slice(0, 10);
  }
}

function formatAmount(cents: number | null): string {
  return cents === null ? "pending" : `$${(cents / 100).toFixed(2)}`;
}

export function templateVars(final: FinalBundle, providerIdentity: string | null): Record<string, string> {
  const a = final.bundle.appointment;
  return {
    clientRef: a.clientRef,
    serviceDate: serviceDate(final),
    serviceCode: a.serviceCode,
    amount: formatAmount(final.bundle.billing.amountCents),
    revision: String(final.bundle.bundleRevision),
    providerIdentity: providerIdentity ?? "",
  };
}

/** Folder path rendering: values cannot inject path separators or invalid characters. */
function renderFolderPath(tpl: string, vars: Record<string, string>): string {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) safe[k] = v.replace(/[\\/:*?"<>|\r\n]+/g, "-");
  return renderTemplate(tpl, safe)
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .join("/");
}

// ------------------------------------------------------------------ loader
export interface CompletedContext {
  session: SessionRecord;
  final: FinalBundle;
  approval: ApprovalRecord;
  providerIdentity: string | null;
}

async function loadCompletedForProvider(deps: DeliveryDeps, providerId: string, sessionId: string): Promise<CompletedContext> {
  const session = await deps.repo.getSessionForProvider(providerId, sessionId);
  if (!session) throw new ServiceError(404, "NOT_FOUND", "Session not found", false);
  return loadCompleted(deps, session);
}

async function loadCompleted(deps: DeliveryDeps, session: SessionRecord): Promise<CompletedContext> {
  const notFinal = () => new ServiceError(409, "NOT_FINALIZED", "Session has not been completed yet", true);
  if (session.status !== "COMPLETED") throw notFinal();
  const final = await deps.repo.getFinalBundle(session.id);
  if (!final) throw notFinal();
  const approval = await deps.repo.getApprovalForSession(session.id);
  if (!approval) throw notFinal();
  const providerIdentity = await deps.repo.getProviderIdentity(session.providerId);
  return { session, final, approval, providerIdentity };
}

/** Shared scoped loader for the files/deliveries routes. */
export function loadCompletedForActor(deps: DeliveryDeps, actor: Actor, sessionId: string): Promise<CompletedContext> {
  return loadCompletedForProvider(deps, actor.providerId, sessionId);
}

/** v3: one DocModel per kind (resolved template + client snapshot) → PDF. */
async function renderPdfFor(deps: DeliveryDeps, ctx: CompletedContext, kind: FileKind): Promise<{ name: string; bytes: Uint8Array }> {
  const model = buildDocModel(kind, await loadDocModelInputForSession(deps, ctx.session, kind));
  return { name: model.filename, bytes: await renderDocModelPdf(model) };
}

// ------------------------------------------------------------------ helpers
async function accessToken(deps: DeliveryDeps, providerId: string, provider: ConnectionProvider): Promise<string> {
  try {
    return await getValidAccessToken(deps, providerId, provider);
  } catch (err) {
    if (err instanceof ConnectionError) {
      const code = String(err.code);
      if (code === "not_connected" || code === "reauth_required" || code === "not_configured") {
        throw new ServiceError(409, "CONNECTION_REQUIRED", `Connection required (${code}) for ${provider}`, false, { reason: code });
      }
      throw new ServiceError(502, "PROVIDER_ERROR", `Connection error (${code})`, true);
    }
    throw err;
  }
}

function safeCloudMessage(err: CloudApiError): string {
  return `Provider error ${err.status} (${String(err.code).slice(0, 64)})`.slice(0, 500);
}

function newId(): string {
  return `fd_${crypto.randomUUID()}`;
}

function dedupeKinds(kinds: readonly FileKind[]): FileKind[] {
  return FILE_KINDS.filter((k) => kinds.includes(k));
}

// ------------------------------------------------------------------ drive upload
async function performDriveUpload(
  deps: DeliveryDeps,
  ctx: CompletedContext,
  delivery: FileDelivery,
  knownToken?: string,
): Promise<FileDelivery> {
  const now = () => deps.clock.now();
  const providerId = ctx.session.providerId;
  try {
    await recordDelivery(deps, delivery, "started", providerId);
    const token = knownToken ?? (await accessToken(deps, providerId, delivery.provider));
    const settings = await deps.repo.getStorageSettings(providerId);
    const rendered: { name: string; bytes: Uint8Array }[] = [];
    for (const kind of delivery.files) rendered.push(await renderPdfFor(deps, ctx, kind));
    const adapter = storageAdapterFor(delivery.provider, token, deps.fetch);
    const path = renderFolderPath(settings.folderPath, templateVars(ctx.final, ctx.providerIdentity));
    const folder = await adapter.ensureFolder(path);
    for (const f of rendered) await adapter.uploadFile(folder.folderId, f.name, f.bytes, PDF);
    const patch = { status: "done" as const, externalId: folder.folderId, webUrl: folder.webUrl, error: null };
    await deps.repo.updateFileDelivery(delivery.id, patch, now());
    log("info", "delivery.drive.done", { deliveryId: delivery.id, sessionId: delivery.sessionId, provider: delivery.provider });
    await recordDelivery(deps, delivery, "succeeded", providerId);
    return { ...delivery, ...patch, updatedAt: now().toISOString() };
  } catch (err) {
    throw await failDelivery(deps, delivery, err);
  }
}

/** Marks the delivery failed (safe message) and maps the error to a ServiceError. */
async function failDelivery(deps: DeliveryDeps, delivery: FileDelivery, err: unknown): Promise<unknown> {
  let mapped: unknown = err;
  let message: string;
  if (err instanceof CloudApiError) {
    message = safeCloudMessage(err);
    const retryable = err.retryable;
    mapped = new ServiceError(502, "PROVIDER_ERROR", message, retryable);
  } else if (err instanceof ServiceError) {
    message = err.message.slice(0, 500);
  } else {
    message = "Unexpected delivery error";
  }
  try {
    await deps.repo.updateFileDelivery(delivery.id, { status: "failed", error: message }, deps.clock.now());
  } catch {
    /* keep original error */
  }
  log("warn", "delivery.failed", { deliveryId: delivery.id, sessionId: delivery.sessionId, target: delivery.target, error: message });
  await recordDelivery(deps, delivery, "failed", null, err);
  return mapped;
}

export async function uploadToDrive(
  deps: DeliveryDeps,
  actor: Actor,
  sessionId: string,
  req: DriveUploadRequest,
): Promise<FileDelivery> {
  const ctx = await loadCompletedForProvider(deps, actor.providerId, sessionId);
  const settings = await deps.repo.getStorageSettings(actor.providerId);
  const provider = req.provider ?? settings.provider;
  if (!provider) throw new ServiceError(422, "NO_STORAGE_PROVIDER", "Choose a storage provider in Settings first", false);
  // Fail fast on a missing connection before recording a delivery.
  const token = await accessToken(deps, actor.providerId, provider);
  const now = deps.clock.now();
  const delivery: FileDelivery = {
    id: newId(),
    sessionId,
    bundleRevision: ctx.final.bundleRevision,
    target: "drive",
    provider,
    files: dedupeKinds(req.files ?? FILE_KINDS),
    status: "pending",
    externalId: null,
    webUrl: null,
    recipients: [],
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await deps.repo.createFileDelivery(delivery);
  return performDriveUpload(deps, ctx, delivery, token);
}

// ------------------------------------------------------------------ email draft
export async function createEmailDraft(
  deps: DeliveryDeps,
  actor: Actor,
  sessionId: string,
  req: EmailDraftRequest,
): Promise<FileDelivery> {
  const ctx = await loadCompletedForProvider(deps, actor.providerId, sessionId);
  const settings = await deps.repo.getEmailSettings(actor.providerId);
  const provider = req.provider ?? settings.provider;
  if (!provider) throw new ServiceError(422, "NO_EMAIL_PROVIDER", "Choose an email provider in Settings first", false);
  const token = await accessToken(deps, actor.providerId, provider);

  const vars = templateVars(ctx.final, ctx.providerIdentity);
  const subject = stripLineBreaks(req.subject ?? renderTemplate(settings.subjectTemplate, vars)).slice(0, 250);
  const bodyText = req.body ?? renderTemplate(settings.bodyTemplate, vars);
  const to = [...new Set(req.to)];
  const cc = [...new Set(req.cc ?? settings.defaultCc)].filter((a) => !to.includes(a));
  const files = dedupeKinds(req.files ?? (settings.attach.length > 0 ? settings.attach : FILE_KINDS));

  const now = deps.clock.now();
  const delivery: FileDelivery = {
    id: newId(),
    sessionId,
    bundleRevision: ctx.final.bundleRevision,
    target: "email_draft",
    provider,
    files,
    status: "pending",
    externalId: null,
    webUrl: null,
    recipients: [...to, ...cc],
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await deps.repo.createFileDelivery(delivery);
  try {
    await recordDelivery(deps, delivery, "started", actor.providerId);
    const attachments: { filename: string; contentType: string; bytes: Uint8Array }[] = [];
    for (const kind of files) {
      const pdf = await renderPdfFor(deps, ctx, kind);
      attachments.push({ filename: pdf.name, contentType: PDF, bytes: pdf.bytes });
    }
    // Draft only — the user presses Send in their own mail app.
    const draft = await mailAdapterFor(provider, token, deps.fetch).createDraft({ to, cc, subject, bodyText, attachments });
    const patch = { status: "done" as const, externalId: draft.draftId, webUrl: draft.webUrl, error: null };
    await deps.repo.updateFileDelivery(delivery.id, patch, deps.clock.now());
    log("info", "delivery.email_draft.done", { deliveryId: delivery.id, sessionId, provider });
    await recordDelivery(deps, delivery, "succeeded", actor.providerId);
    return { ...delivery, ...patch, updatedAt: deps.clock.now().toISOString() };
  } catch (err) {
    throw await failDelivery(deps, delivery, err);
  }
}

// ------------------------------------------------------------------ auto upload (jobs)
export function autoDeliveryId(sessionId: string, revision: number): string {
  return `fd_auto_${sessionId}_r${revision}`;
}

/** Completion hook: enqueue an auto drive upload when enabled + connected. Idempotent per revision. */
export async function onSessionCompleted(deps: DeliveryDeps, sessionId: string): Promise<{ enqueued: boolean; deliveryId?: string }> {
  const session = await deps.repo.getSession(sessionId);
  if (!session || session.status !== "COMPLETED") return { enqueued: false };
  const settings = await deps.repo.getStorageSettings(session.providerId);
  if (!settings.autoUploadOnComplete || !settings.provider) return { enqueued: false };
  const conn = await deps.repo.getConnection(session.providerId, settings.provider);
  if (!conn || conn.status !== "connected") return { enqueued: false };
  const final = await deps.repo.getFinalBundle(sessionId);
  if (!final) return { enqueued: false };
  const rev = final.bundleRevision;
  const id = autoDeliveryId(sessionId, rev);
  const now = deps.clock.now();
  if (!(await deps.repo.getFileDelivery(id))) {
    await deps.repo.createFileDelivery({
      id,
      sessionId,
      bundleRevision: rev,
      target: "drive",
      provider: settings.provider,
      files: [...FILE_KINDS],
      status: "pending",
      externalId: null,
      webUrl: null,
      recipients: [],
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }
  await deps.repo.enqueuePendingDelivery(
    { deliveryKey: `file_delivery:${sessionId}:${rev}`, operation: "file_delivery", sessionId, revision: rev, payload: { deliveryId: id } },
    now,
  );
  return { enqueued: true, deliveryId: id };
}

/**
 * Jobs dispatcher entry for "file_delivery". Skips done/missing deliveries.
 * Throws on retryable failures (dispatcher retries); non-retryable failures
 * are recorded on the delivery and swallowed.
 */
export async function processFileDelivery(deps: DeliveryDeps, deliveryId: string): Promise<FileDelivery | null> {
  const delivery = await deps.repo.getFileDelivery(deliveryId);
  if (!delivery) return null;
  if (delivery.status === "done") return delivery;
  if (delivery.target !== "drive") return delivery;
  const session = await deps.repo.getSession(delivery.sessionId);
  if (!session) return null;
  let ctx: CompletedContext;
  try {
    ctx = await loadCompleted(deps, session);
  } catch (err) {
    const mapped = await failDelivery(deps, delivery, err);
    if (mapped instanceof ServiceError && mapped.retryable) throw mapped;
    return null;
  }
  try {
    return await performDriveUpload(deps, ctx, delivery);
  } catch (err) {
    if (err instanceof ServiceError && !err.retryable) return { ...delivery, status: "failed", error: err.message };
    throw err;
  }
}

// ------------------------------------------------------------------ run history (v3)
/** Safe error code for history: class/code only, never messages, tokens or recipients. */
function deliveryErrorCode(err: unknown): string {
  if (err instanceof CloudApiError) return `provider_${err.status}_${String(err.code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`;
  if (err instanceof ServiceError) return err.code;
  return "unexpected";
}

/** Records a delivery transition (runId `delivery:<id>`). Never throws. */
async function recordDelivery(
  deps: DeliveryDeps,
  delivery: FileDelivery,
  status: "started" | "succeeded" | "failed",
  providerId: string | null,
  err?: unknown,
): Promise<void> {
  if (!deps.recorder) return;
  try {
    const owner = providerId ?? (await deps.repo.getSession(delivery.sessionId))?.providerId;
    if (!owner) return;
    const drive = delivery.target === "drive";
    const what = drive ? "Drive upload" : "Email draft";
    await safeRecord(deps.recorder, {
      runId: `delivery:${delivery.id}`,
      runKind: "delivery",
      sessionId: delivery.sessionId,
      providerId: owner,
      stage: drive ? "delivery_drive" : "delivery_email",
      status,
      label: status === "started" ? `${what} started` : status === "succeeded" ? `${what} done` : `${what} failed`,
      detail: status === "failed" ? deliveryErrorCode(err) : null,
      meta: { provider: delivery.provider, files: delivery.files.length, bundleRevision: delivery.bundleRevision },
    });
  } catch {
    /* history never fails a delivery */
  }
}
