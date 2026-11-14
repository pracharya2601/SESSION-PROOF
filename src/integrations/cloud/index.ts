/**
 * Cloud storage + mail-draft adapters (Google Drive/Gmail, OneDrive/Outlook).
 * Drafts only — nothing here ever sends mail.
 */
import type { ConnectionProvider } from "../../contracts/v2";
import { GmailAdapter, GoogleDriveAdapter } from "./google";
import type { CloudAdapterOptions } from "./http";
import { OneDriveAdapter, OutlookAdapter } from "./microsoft";
import type { CloudStorageAdapter, MailAdapter } from "./types";

export type { CloudStorageAdapter, MailAdapter } from "./types";
export { CloudApiError, CloudInputError, type CloudAdapterOptions, type CloudErrorCode } from "./http";
export { GmailAdapter, GoogleDriveAdapter, escapeDriveQuery } from "./google";
export { OneDriveAdapter, OutlookAdapter } from "./microsoft";
export { buildMime } from "./mime";

export function storageAdapterFor(
  provider: ConnectionProvider,
  accessToken: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  opts?: CloudAdapterOptions,
): CloudStorageAdapter {
  return provider === "google"
    ? new GoogleDriveAdapter(accessToken, fetchImpl, opts)
    : new OneDriveAdapter(accessToken, fetchImpl, opts);
}

export function mailAdapterFor(
  provider: ConnectionProvider,
  accessToken: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  opts?: CloudAdapterOptions,
): MailAdapter {
  return provider === "google"
    ? new GmailAdapter(accessToken, fetchImpl, opts)
    : new OutlookAdapter(accessToken, fetchImpl, opts);
}
