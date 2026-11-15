/**
 * DemoDriveSource: mimics Google Drive for the SYNTHETIC demo caseload. Each client has a
 * folder of plain-text documents (fixtures/schedule/drive.ts); the context is PARSED from
 * those documents (src/schedule/drive-parse.ts), not copied from a structured fixture, so
 * the same code path works when the text comes from real Drive exports.
 */
import type { DriveClientContext, DriveDocument, DriveSource } from "../contracts";
import { DriveClientContext as DriveClientContextSchema } from "../contracts";
import { DEMO_DRIVE_FOLDERS, type DemoDriveFolder } from "../../fixtures/schedule/drive";
import { SCHEDULE_PROVIDER_ID } from "../../fixtures/schedule/caseload";
import { parseAuthorization, parseGoals, parseServiceCode } from "./drive-parse";

function newest(docs: DriveDocument[], kind: DriveDocument["kind"]): DriveDocument | undefined {
  return docs.filter((d) => d.kind === kind).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
}

/** Builds a DriveClientContext from a folder's documents. Null when there is no usable plan. */
export function contextFromDocuments(clientRef: string, folder: string, documents: DriveDocument[]): DriveClientContext | null {
  const plan = newest(documents, "service_plan");
  if (!plan) return null;
  const goals = parseGoals(plan.text);
  const authDoc = newest(documents, "authorization");
  const serviceCode = parseServiceCode(plan.text) ?? (authDoc ? parseServiceCode(authDoc.text) : null);
  if (goals.length === 0 || !serviceCode) return null;
  const ctx: DriveClientContext = {
    clientRef,
    folder,
    goals,
    serviceCode,
    authorization: authDoc ? parseAuthorization(authDoc.text) : null,
    documents: [...documents].sort((a, b) => a.kind.localeCompare(b.kind) || b.modifiedAt.localeCompare(a.modifiedAt)),
  };
  return DriveClientContextSchema.parse(ctx);
}

export class DemoDriveSource implements DriveSource {
  readonly kind = "demo" as const;
  private readonly folders: readonly DemoDriveFolder[];

  constructor(opts: { folders?: readonly DemoDriveFolder[] } = {}) {
    this.folders = opts.folders ?? DEMO_DRIVE_FOLDERS;
  }

  async getClientContext(providerId: string, clientRef: string): Promise<DriveClientContext | null> {
    if (providerId !== SCHEDULE_PROVIDER_ID) return null;
    const f = this.folders.find((x) => x.clientRef === clientRef);
    return f ? contextFromDocuments(f.clientRef, f.folder, structuredClone(f.documents)) : null;
  }
}
