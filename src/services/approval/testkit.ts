/** Test helpers (Agent 16): in-memory fake repository + stub assembler. */
import type {
  ApprovalRecord,
  AssembleBundleFn,
  FinalBundle,
  SessionBundle,
  SessionRecord,
} from "../../contracts";
import type { ApprovalWrite, Repository } from "../../db/repository";
import type { ApiDeps } from "../../api/deps";

export const PROVIDER = "prov-1";
export const SESSION = "sess_1";
export const NOW = new Date("2026-11-13T15:00:00.000Z");

export function makeBundle(over: Partial<SessionBundle> = {}): SessionBundle {
  const base: SessionBundle = {
    sessionId: SESSION,
    bundleRevision: 1,
    processingRevision: 1,
    appointment: {
      id: "appt-1",
      occurrenceId: "occ-1",
      providerId: PROVIDER,
      clientRef: "client-A",
      startAt: "2026-11-13T13:00:00.000Z",
      endAt: "2026-11-13T14:30:00.000Z",
      timezone: "America/New_York",
      serviceCode: "SVC1",
      planVersion: "p1",
      ruleVersion: "r1",
      rateVersion: "rate1",
      canceled: false,
    },
    config: {
      plan: { planVersion: "p1", serviceCode: "SVC1", serviceDescription: "Skills training", goals: [{ goalId: "g1", objective: "Plan tasks" }] },
      rules: { ruleVersion: "r1", serviceCode: "SVC1", required: ["confirmed_duration"], allowProviderProgressAttestation: true },
      rate: { rateVersion: "rate1", currency: "USD", hourlyRateCents: 7500, maxMinutes: 240 },
    },
    evidence: [
      {
        id: "ev-1",
        sourceId: "src-1",
        sourceMode: "fixture",
        observedFrom: "2026-11-13T13:02:00.000Z",
        observedTo: "2026-11-13T14:20:00.000Z",
        speaker: null,
        excerpt: "Participant said <script>alert(1)</script> during planning",
        retrievedAt: "2026-11-13T14:40:00.000Z",
      },
    ],
    evidenceWindow: { from: "2026-11-13T13:02:00.000Z", to: "2026-11-13T14:20:00.000Z" },
    extractedFacts: { activities: [], observations: [], goals: [], progress: [], followUps: [], missingInformation: [] },
    facts: { activities: [], observations: [], goals: [], progress: [], followUps: [], missingInformation: [] },
    attestations: [],
    documents: {
      sections: [
        {
          key: "session_note",
          title: "Session note",
          lines: [{ text: "Worked on <script>alert(1)</script> planning", claimIds: ["c1"], evidenceIds: ["ev-1"], attestationIds: [], origin: "extracted" }],
        },
      ],
      planCoverage: [{ goalId: "g1", objective: "Plan tasks", status: "addressed", claimIds: ["c1"] }],
      timeSummary: {
        scheduledFrom: "2026-11-13T13:00:00.000Z",
        scheduledTo: "2026-11-13T14:30:00.000Z",
        scheduledMinutes: 90,
        evidenceWindowFrom: "2026-11-13T13:02:00.000Z",
        evidenceWindowTo: "2026-11-13T14:20:00.000Z",
        evidenceWindowMinutes: 78,
        confirmedMinutes: null,
        timezone: "America/New_York",
      },
    },
    checks: { ruleVersion: "r1", issues: [{ code: "MISSING_DURATION", field: "confirmed_duration", message: "Confirm duration", blocking: true }], canApprove: false },
    billing: {
      currency: "USD",
      hourlyRateCents: 7500,
      scheduledMinutes: 90,
      confirmedMinutes: null,
      amountCents: null,
      estimateAmountCents: 11250,
      isEstimate: true,
      rateVersion: "rate1",
      rounding: "half_up_to_cent",
      breakdown: "estimate",
    },
    provenance: {
      evidenceMode: "fixture",
      extractionMode: "fixture",
      runtimeMode: "local",
      schemaVersion: "1",
      promptVersion: "v1",
      model: null,
      evidenceCompleteness: "complete",
      evidenceWarnings: [],
    },
    createdAt: "2026-11-13T14:45:00.000Z",
  };
  return { ...base, ...over };
}

/** Stub assembler: derives confirmedMinutes/amount from the latest duration attestation. */
export const stubAssemble: AssembleBundleFn = (input) => {
  const dur = [...input.attestations].reverse().find((a) => a.field === "duration");
  const minutes = dur ? Number(dur.text) : null;
  const amount = minutes === null ? null : Math.round((input.config.rate.hourlyRateCents * minutes) / 60);
  const base = makeBundle();
  return {
    ...base,
    sessionId: input.sessionId,
    bundleRevision: input.bundleRevision,
    processingRevision: input.processingRevision,
    appointment: input.appointment,
    config: input.config,
    evidence: input.evidence,
    evidenceWindow: input.evidenceWindow,
    extractedFacts: input.facts,
    attestations: input.attestations,
    provenance: input.provenance,
    createdAt: input.createdAt,
    checks: minutes === null ? base.checks : { ruleVersion: "r1", issues: [], canApprove: true },
    billing: { ...base.billing, confirmedMinutes: minutes, amountCents: amount, isEstimate: minutes === null },
    documents: { ...base.documents, timeSummary: { ...base.documents.timeSummary, confirmedMinutes: minutes } },
  };
};

export class FakeRepo {
  sessions = new Map<string, SessionRecord>();
  bundles = new Map<string, SessionBundle>();
  approvals: ApprovalRecord[] = [];
  finals = new Map<string, FinalBundle>();
  persistCalls = 0;
  deliveries: Record<string, unknown>[] = [];

  constructor() {
    this.sessions.set(SESSION, {
      id: SESSION,
      providerId: PROVIDER,
      appointmentId: "appt-1",
      occurrenceId: "occ-1",
      status: "NEEDS_REVIEW",
      processingRevision: 1,
      currentBundleRevision: 1,
      workflowId: null,
      statusReason: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    this.bundles.set(`${SESSION}:1`, makeBundle());
  }

  async getSessionForProvider(providerId: string, sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s && s.providerId === providerId ? { ...s } : null;
  }
  async getBundle(sessionId: string, rev: number) {
    return this.bundles.get(`${sessionId}:${rev}`) ?? null;
  }
  async getCurrentBundle(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s ? (this.bundles.get(`${sessionId}:${s.currentBundleRevision}`) ?? null) : null;
  }
  async saveReviewRevision(sessionId: string, expected: number, bundle: SessionBundle) {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false as const, reason: "not_found" as const };
    if (s.status !== "NEEDS_REVIEW") return { ok: false as const, reason: "invalid_state" as const };
    if (s.currentBundleRevision !== expected) return { ok: false as const, reason: "stale_revision" as const };
    this.bundles.set(`${sessionId}:${bundle.bundleRevision}`, bundle);
    s.currentBundleRevision = bundle.bundleRevision;
    return { ok: true as const, value: bundle };
  }
  async persistApproval(w: ApprovalWrite) {
    this.persistCalls++;
    const s = this.sessions.get(w.approval.sessionId);
    if (!s) return { ok: false as const, reason: "not_found" as const };
    const byKey = this.approvals.find((a) => a.idempotencyKey === w.approval.idempotencyKey);
    if (byKey) {
      return byKey.requestFingerprint === w.approval.requestFingerprint
        ? { ok: true as const, value: { approval: byKey, replayed: true } }
        : { ok: false as const, reason: "conflict" as const };
    }
    if (s.status !== "NEEDS_REVIEW") return { ok: false as const, reason: "invalid_state" as const };
    if (s.currentBundleRevision !== w.expectedBundleRevision) return { ok: false as const, reason: "stale_revision" as const };
    this.approvals.push(w.approval);
    this.deliveries.push(w.notificationPayload);
    s.status = "APPROVED";
    return { ok: true as const, value: { approval: w.approval, replayed: false } };
  }
  async getApprovalForSession(sessionId: string) {
    return this.approvals.find((a) => a.sessionId === sessionId) ?? null;
  }
  async getApprovalByKey(key: string) {
    return this.approvals.find((a) => a.idempotencyKey === key) ?? null;
  }
  async getFinalBundle(sessionId: string) {
    return this.finals.get(sessionId) ?? null;
  }
  /** Simulates the workflow's finalization step. */
  finalize(sessionId: string) {
    const a = this.approvals.find((x) => x.sessionId === sessionId)!;
    a.finalizationStatus = "finalized";
    const s = this.sessions.get(sessionId)!;
    s.status = "COMPLETED";
    const final: FinalBundle = {
      sessionId,
      bundleRevision: a.bundleRevision,
      approvalId: a.id,
      finalizedAt: NOW.toISOString(),
      bundle: this.bundles.get(`${sessionId}:${a.bundleRevision}`)!,
    };
    this.finals.set(sessionId, final);
    return final;
  }
}

export function makeDeps(repo = new FakeRepo(), notify?: ApiDeps["notifyApproval"]) {
  const notified: ApprovalRecord[] = [];
  const deps = {
    repo: repo as unknown as Repository,
    clock: { now: () => NOW },
    env: {} as ApiDeps["env"],
    assemble: stubAssemble,
    discover: async () => ({ examined: 0, created: 0, enqueued: 0, skipped: 0 }),
    dispatch: async () => ({ attempted: 0, succeeded: 0, failed: 0, exhausted: 0 }),
    notifyApproval:
      notify ??
      (async (a: ApprovalRecord) => {
        notified.push(a);
      }),
  } satisfies ApiDeps;
  return { deps, repo, notified };
}
