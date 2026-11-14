/**
 * Google Drive v3 (scope drive.file — the app only sees files/folders it
 * created) + Gmail drafts (scope gmail.compose). Never sends mail.
 */
import {
  assertContentType,
  assertFilename,
  bytesToBase64Url,
  CloudApiError,
  type CloudAdapterOptions,
  CloudHttp,
  type DraftInput,
  splitPath,
  validateDraft,
} from "./http";
import { buildMime } from "./mime";
import type { CloudStorageAdapter, MailAdapter } from "./types";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Gmail's message size cap is 35 MB, attachments 25 MB; base64 adds ~37%. */
const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Escape a value for a Drive `q` string literal: backslash, then single quote. */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

interface DriveFile {
  id: string;
  webViewLink?: string;
}

export class GoogleDriveAdapter implements CloudStorageAdapter {
  private readonly http: CloudHttp;
  private readonly boundary: () => string;

  constructor(accessToken: string, fetchImpl: typeof fetch = fetch, opts: CloudAdapterOptions = {}) {
    this.http = new CloudHttp("Google Drive", accessToken, fetchImpl, opts);
    this.boundary = opts.boundary ?? (() => `fa_${crypto.randomUUID().replace(/-/g, "")}`);
  }

  private async findOne(q: string): Promise<DriveFile | null> {
    const params = new URLSearchParams({ q, fields: "files(id,webViewLink)" });
    const r = await this.http.json<{ files?: DriveFile[] }>(`${DRIVE_API}/files?${params}`, { method: "GET" });
    return r.files?.[0] ?? null;
  }

  async ensureFolder(path: string): Promise<{ folderId: string; webUrl: string | null }> {
    const segs = splitPath(path);
    let parent = "root";
    let webUrl: string | null = "https://drive.google.com/drive/my-drive";
    for (const name of segs) {
      const q =
        `name='${escapeDriveQuery(name)}' and mimeType='${FOLDER_MIME}' and ` +
        `'${escapeDriveQuery(parent)}' in parents and trashed=false`;
      let folder = await this.findOne(q);
      if (!folder) {
        folder = await this.http.json<DriveFile>(`${DRIVE_API}/files?fields=id,webViewLink`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
        });
      }
      parent = folder.id;
      webUrl = folder.webViewLink ?? null;
    }
    return { folderId: parent, webUrl };
  }

  async uploadFile(
    folderId: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ fileId: string; webUrl: string | null }> {
    assertFilename(name);
    assertContentType(contentType);
    const existing = await this.findOne(
      `name='${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents and ` +
        `mimeType!='${FOLDER_MIME}' and trashed=false`,
    );
    // Update in place (same id) so re-uploads of a revision don't duplicate.
    const metadata = existing ? { name, mimeType: contentType } : { name, parents: [folderId], mimeType: contentType };
    const boundary = this.boundary();
    const body = multipartRelated(boundary, metadata, bytes, contentType);
    const url = existing
      ? `${DRIVE_UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,webViewLink`
      : `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`;
    const f = await this.http.json<DriveFile>(url, {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return { fileId: f.id, webUrl: f.webViewLink ?? null };
  }
}

export function multipartRelated(
  boundary: string,
  metadata: Record<string, unknown>,
  bytes: Uint8Array,
  contentType: string,
): Uint8Array {
  const te = new TextEncoder();
  const head = te.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = te.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

export class GmailAdapter implements MailAdapter {
  private readonly http: CloudHttp;

  constructor(
    accessToken: string,
    fetchImpl: typeof fetch = fetch,
    private readonly opts: CloudAdapterOptions = {},
  ) {
    this.http = new CloudHttp("Gmail", accessToken, fetchImpl, opts);
  }

  /**
   * Creates a draft only. webUrl is best-effort: Gmail has no documented
   * deep link to a draft; `#drafts?compose=<messageId>` opens it in the
   * compose window for account /u/0 in practice, and falls back to the
   * Drafts list otherwise.
   */
  async createDraft(d: DraftInput): Promise<{ draftId: string; webUrl: string | null }> {
    validateDraft(d);
    const total = d.attachments.reduce((n, a) => n + a.bytes.length, 0);
    if (total > GMAIL_MAX_ATTACHMENT_BYTES) {
      throw new CloudApiError(413, "quota", "Gmail: attachments exceed the 25 MB limit", false);
    }
    const mime = buildMime(d, {
      now: this.opts.now?.(),
      messageId: this.opts.messageId?.(),
      boundary: this.opts.boundary?.(),
    });
    const raw = bytesToBase64Url(new TextEncoder().encode(mime));
    const r = await this.http.json<{ id: string; message?: { id?: string } }>(`${GMAIL_API}/users/me/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ message: { raw } }),
    });
    const msgId = r.message?.id;
    return {
      draftId: r.id,
      webUrl: msgId
        ? `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(msgId)}`
        : "https://mail.google.com/mail/u/0/#drafts",
    };
  }
}
