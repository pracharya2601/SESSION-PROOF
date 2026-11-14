/** Frozen v2 ports (docs/interfaces-v2.md). */
export interface CloudStorageAdapter {
  ensureFolder(path: string): Promise<{ folderId: string; webUrl: string | null }>;
  uploadFile(
    folderId: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ fileId: string; webUrl: string | null }>;
}

export interface MailAdapter {
  createDraft(d: {
    to: string[];
    cc: string[];
    subject: string;
    bodyText: string;
    attachments: { filename: string; contentType: string; bytes: Uint8Array }[];
  }): Promise<{ draftId: string; webUrl: string | null }>;
}
