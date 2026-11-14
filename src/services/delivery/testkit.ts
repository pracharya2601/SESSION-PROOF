/** Test helpers (Agent V7): in-memory v2 fake repository for delivery tests. */
import {
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  type ApprovalRecord,
  type ConnectionProvider,
  type EmailSettings,
  type FileDelivery,
  type FinalBundle,
  type SessionRecord,
  type StorageSettings,
  type StoredConnection,
} from "../../contracts";
import type { Repository } from "../../db/repository";
import type { Env } from "../../env";
import { makeBundle, NOW, PROVIDER, SESSION } from "../approval/testkit";
import type { DeliveryDeps } from "./index";

export { NOW, PROVIDER, SESSION };
export const OTHER_PROVIDER = "prov-2";

export function completedFinal(rev = 2): FinalBundle {
  const b = makeBundle({ bundleRevision: rev });
  return {
    sessionId: SESSION,
    bundleRevision: rev,
    approvalId: `approval-${SESSION}-r${rev}`,
    finalizedAt: "2026-11-13T14:55:00.000Z",
    bundle: {
      ...b,
      billing: { ...b.billing, confirmedMinutes: 90, amountCents: 11250, isEstimate: false },
      documents: { ...b.documents, timeSummary: { ...b.documents.timeSummary, confirmedMinutes: 90 } },
    },
  };
}

export class DeliveryFakeRepo {
  sessions = new Map<string, SessionRecord>();
  finals = new Map<string, FinalBundle>();
  approvals = new Map<string, ApprovalRecord>();
  storage = new Map<string, StorageSettings>();
  email = new Map<string, EmailSettings>();
  connections = new Map<string, StoredConnection>();
  fileDeliveries = new Map<string, FileDelivery>();
  pending = new Map<string, Record<string, unknown>>();
  enqueueCalls = 0;

  constructor(opts: { completed?: boolean } = {}) {
    const completed = opts.completed ?? true;
    this.sessions.set(SESSION, {
      id: SESSION,
      providerId: PROVIDER,
      appointmentId: "appt-1",
      occurrenceId: "occ-1",
      status: completed ? "COMPLETED" : "NEEDS_REVIEW",
      processingRevision: 1,
      currentBundleRevision: 2,
      workflowId: null,
      statusReason: null,
      createdAt: "2026-11-13T14:00:00.000Z",
      updatedAt: "2026-11-13T14:55:00.000Z",
    });
    if (completed) {
      const final = completedFinal();
      this.finals.set(SESSION, final);
      this.approvals.set(SESSION, {
        id: final.approvalId,
        sessionId: SESSION,
        bundleRevision: 2,
        approverProviderId: PROVIDER,
        approvedAt: "2026-11-13T14:50:00.000Z",
        idempotencyKey: "key-00000001",
        requestFingerprint: "fp",
        finalizationStatus: "finalized",
      });
    }
  }

  connect(provider: ConnectionProvider, providerId = PROVIDER) {
    this.connections.set(`${providerId}:${provider}`, {
      providerId,
      provider,
      accountEmail: "p@example.test",
      scopes: [],
      encryptedTokens: "x",
      accessTokenExpiresAt: null,
      status: "connected",
      lastError: null,
      connectedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }

  async getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async getSessionForProvider(providerId: string, id: string) {
    const s = this.sessions.get(id);
    return s && s.providerId === providerId ? s : null;
  }
  async getFinalBundle(id: string) {
    return this.finals.get(id) ?? null;
  }
  async getApprovalForSession(id: string) {
    return this.approvals.get(id) ?? null;
  }
  async getProviderIdentity(providerId: string) {
    return providerId === PROVIDER ? "p@example.test" : null;
  }
  async getStorageSettings(providerId: string) {
    return this.storage.get(providerId) ?? DEFAULT_STORAGE_SETTINGS;
  }
  async getEmailSettings(providerId: string) {
    return this.email.get(providerId) ?? DEFAULT_EMAIL_SETTINGS;
  }
  async getConnection(providerId: string, provider: ConnectionProvider) {
    return this.connections.get(`${providerId}:${provider}`) ?? null;
  }
  async createFileDelivery(d: FileDelivery) {
    this.fileDeliveries.set(d.id, { ...d });
  }
  async updateFileDelivery(id: string, patch: Partial<FileDelivery>, now: Date) {
    const d = this.fileDeliveries.get(id);
    if (d) this.fileDeliveries.set(id, { ...d, ...patch, updatedAt: now.toISOString() });
  }
  async getFileDelivery(id: string) {
    return this.fileDeliveries.get(id) ?? null;
  }
  async listFileDeliveries(sessionId: string) {
    return [...this.fileDeliveries.values()].filter((d) => d.sessionId === sessionId);
  }
  async listCompletedForProvider(providerId: string, _limit: number, _cursor: string | null) {
    const items: { session: SessionRecord; final: FinalBundle; approval: ApprovalRecord }[] = [];
    for (const s of this.sessions.values()) {
      const final = this.finals.get(s.id);
      const approval = this.approvals.get(s.id);
      if (s.providerId === providerId && s.status === "COMPLETED" && final && approval) items.push({ session: s, final, approval });
    }
    return { items, nextCursor: null };
  }
  async enqueuePendingDelivery(d: { deliveryKey: string } & Record<string, unknown>) {
    this.enqueueCalls++;
    if (!this.pending.has(d.deliveryKey)) this.pending.set(d.deliveryKey, d);
  }
}

export function makeDeliveryDeps(repo = new DeliveryFakeRepo()): { deps: DeliveryDeps; repo: DeliveryFakeRepo } {
  const deps: DeliveryDeps = {
    repo: repo as unknown as Repository,
    env: {} as Env,
    clock: { now: () => NOW },
  };
  return { deps, repo };
}
