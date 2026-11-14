/**
 * Microsoft Graph: OneDrive (Files.ReadWrite) + Outlook drafts
 * (Mail.ReadWrite). POST /me/messages creates a draft; /send is never called.
 */
import {
  assertContentType,
  assertFilename,
  bytesToBase64,
  CloudApiError,
  type CloudAdapterOptions,
  CloudHttp,
  CloudInputError,
  type DraftInput,
  splitPath,
  validateDraft,
} from "./http";
import type { CloudStorageAdapter, MailAdapter } from "./types";

export const GRAPH = "https://graph.microsoft.com/v1.0";
/** Simple PUT upload limit; above this an upload session is used. */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Upload-session chunk: must be a multiple of 320 KiB. */
export const UPLOAD_CHUNK = 320 * 1024 * 12; // 3.75 MiB
/** Inline attachments on POST /me/messages must be < 3 MB each (request ≤ 4 MB). */
const OUTLOOK_INLINE_MAX = 3 * 1024 * 1024;

/** Characters OneDrive rejects in item names. */
const ONEDRIVE_INVALID = /["*:<>?/\\|]/;

function assertOneDriveName(what: string, name: string): void {
  if (ONEDRIVE_INVALID.test(name)) throw new CloudInputError(`${what} contains characters OneDrive does not allow`);
  if (/[. ]$/.test(name)) throw new CloudInputError(`${what} may not end with a dot or space`);
}

const encodePath = (segs: string[]) => segs.map(encodeURIComponent).join("/");

interface DriveItem {
  id: string;
  webUrl?: string;
}

export class OneDriveAdapter implements CloudStorageAdapter {
  private readonly http: CloudHttp;

  constructor(accessToken: string, fetchImpl: typeof fetch = fetch, opts: CloudAdapterOptions = {}) {
    this.http = new CloudHttp("OneDrive", accessToken, fetchImpl, opts);
  }

  private async getByPath(segs: string[]): Promise<DriveItem | null> {
    const res = await this.http.request(`${GRAPH}/me/drive/root:/${encodePath(segs)}`, { method: "GET", allow: [404] });
    if (res.status === 404) return null;
    return (await res.json()) as DriveItem;
  }

  async ensureFolder(path: string): Promise<{ folderId: string; webUrl: string | null }> {
    const segs = splitPath(path);
    for (const s of segs) assertOneDriveName("Folder name", s);
    if (segs.length === 0) {
      const root = await this.http.json<DriveItem>(`${GRAPH}/me/drive/root`, { method: "GET" });
      return { folderId: root.id, webUrl: root.webUrl ?? null };
    }
    const full = await this.getByPath(segs);
    if (full) return { folderId: full.id, webUrl: full.webUrl ?? null };

    // Walk from the top; once one segment is missing, every deeper one is too.
    let parent: DriveItem | null = null;
    let missing = false;
    for (let i = 0; i < segs.length; i++) {
      const prefix = segs.slice(0, i + 1);
      let item: DriveItem | null = missing ? null : await this.getByPath(prefix);
      if (!item) {
        missing = true;
        const url: string = parent
          ? `${GRAPH}/me/drive/items/${encodeURIComponent(parent.id)}/children`
          : `${GRAPH}/me/drive/root/children`;
        const res = await this.http.request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: segs[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
          allow: [409],
        });
        if (res.status === 409) {
          // Lost a race with a concurrent create: use the winner's folder.
          item = await this.getByPath(prefix);
          if (!item) throw new CloudApiError(409, "provider", "OneDrive: folder create conflict could not be resolved", true);
        } else {
          item = (await res.json()) as DriveItem;
        }
      }
      parent = item;
    }
    return { folderId: parent!.id, webUrl: parent!.webUrl ?? null };
  }

  async uploadFile(
    folderId: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ fileId: string; webUrl: string | null }> {
    assertFilename(name);
    assertOneDriveName("File name", name);
    assertContentType(contentType);
    const itemPath = `${GRAPH}/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:`;
    if (bytes.length <= SIMPLE_UPLOAD_MAX) {
      const item = await this.http.json<DriveItem>(`${itemPath}/content?@microsoft.graph.conflictBehavior=replace`, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
      });
      return { fileId: item.id, webUrl: item.webUrl ?? null };
    }
    const session = await this.http.json<{ uploadUrl: string }>(`${itemPath}/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace", name } }),
    });
    let item: DriveItem | null = null;
    for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK) {
      const chunk = bytes.subarray(start, Math.min(start + UPLOAD_CHUNK, bytes.length));
      const end = start + chunk.length - 1;
      // uploadUrl is pre-authenticated; Graph rejects an Authorization header on it.
      const res = await this.http.request(session.uploadUrl, {
        method: "PUT",
        noAuth: true,
        headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
        body: chunk,
      });
      if (res.status === 200 || res.status === 201) item = (await res.json()) as DriveItem;
    }
    if (!item) throw new CloudApiError(502, "provider", "OneDrive: upload session finished without an item", true);
    return { fileId: item.id, webUrl: item.webUrl ?? null };
  }
}

export class OutlookAdapter implements MailAdapter {
  private readonly http: CloudHttp;

  constructor(accessToken: string, fetchImpl: typeof fetch = fetch, opts: CloudAdapterOptions = {}) {
    this.http = new CloudHttp("Outlook", accessToken, fetchImpl, opts);
  }

  async createDraft(d: DraftInput): Promise<{ draftId: string; webUrl: string | null }> {
    validateDraft(d);
    const total = d.attachments.reduce((n, a) => n + a.bytes.length, 0);
    if (total >= OUTLOOK_INLINE_MAX) {
      throw new CloudApiError(413, "quota", "Outlook: attachments total 3 MB or more (inline attachment limit)", false);
    }
    const recipients = (xs: string[]) => xs.map((address) => ({ emailAddress: { address } }));
    const msg = await this.http.json<{ id: string; webLink?: string }>(`${GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: d.subject,
        body: { contentType: "Text", content: d.bodyText },
        toRecipients: recipients(d.to),
        ccRecipients: recipients(d.cc),
        attachments: d.attachments.map((a) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.filename,
          contentType: a.contentType,
          contentBytes: bytesToBase64(a.bytes),
        })),
      }),
    });
    return { draftId: msg.id, webUrl: msg.webLink ?? null };
  }
}
