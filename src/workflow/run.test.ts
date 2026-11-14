import { describe, expect, it } from "vitest";
import {
  approvalId as approvalIdFor,
  EvidenceUnavailableError,
  ExtractionRejectedError,
  SessionBundle,
} from "../contracts";
import type {
  Appointment,
  ApprovalRecord,
  AssembleBundleFn,
  EvidenceItem,
  EvidenceResult,
  EvidenceSource,
  Extractor,
  FinalBundle,
  MatchEvidenceFn,
  MatchResult,
  SessionRecord,
  SessionStatus,
  WorkflowParams,
} from "../contracts";
import type { ClientRecord, ClientSnapshot, RunRecorder } from "../contracts";
import type { ConditionalResult, Repository } from "../db/repository";
import {
  demoAppointment,
  demoConfig,
  demoEvidence,
  demoFacts,
  FIXTURE_CLOCK_NOW,
  fixtureClock,
} from "../../fixtures/scenario";
import { runSessionWorkflow, type StepLike, type WorkflowDeps } from "./run";

const SESSION_ID = "sess_test_001";

// ------------------------------------------------------------------ fake step
type WaitScript = { payload: unknown; before?: () => void } | "timeout";

class FakeStep implements StepLike {
  names: string[] = [];
  executed: string[] = [];
  private memo = new Map<string, unknown>();
  constructor(public waits: WaitScript[] = [], public onWait?: (name: string) => void) {}

  async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.names.push(name);
    if (this.memo.has(name)) return structuredClone(this.memo.get(name)) as T;
    const v = await fn();
    // Like the runtime: results must be serializable; keep them small.
    const json = JSON.stringify(v ?? null);
    expect(json.length).toBeLessThan(400);
    expect(json).not.toMatch(/excerpt|transcript|documents/);
    this.memo.set(name, structuredClone(v));
    this.executed.push(name);
    return v;
  }

  async waitForEvent<T>(name: string, _opts: { type: string; timeout: string | number }): Promise<{ payload: T }> {
    this.names.push(name);
    expect(_opts.type).toBe("provider-approved");
    if (this.memo.has(name)) {
      const m = this.memo.get(name) as { timeout: true } | { payload: T };
      if ("timeout" in m) throw new Error("timed out");
      return m;
    }
    this.onWait?.(name);
    const next = this.waits.shift();
    if (next === undefined) throw new Error(`unscripted wait ${name}`);
    this.executed.push(name);
    if (next === "timeout") {
      this.memo.set(name, { timeout: true });
      throw new Error("WorkflowTimeoutError");
    }
    next.before?.();
    this.memo.set(name, { payload: next.payload });
    return { payload: next.payload as T };
  }
}

// ------------------------------------------------------------------ fake repo
class FakeRepo {
  session: SessionRecord;
  appointments: Appointment[] = [demoAppointment];
  evidenceWrites = 0;
  drafts = new Map<number, SessionBundle>();
  draftWrites = 0;
  approval: ApprovalRecord | null = null;
  final: FinalBundle | null = null;
  finalizeCalls = 0;
  transitions: string[] = [];

  constructor(status: SessionStatus = "QUEUED", processingRevision = 1) {
    this.session = {
      id: SESSION_ID,
      providerId: demoAppointment.providerId,
      appointmentId: demoAppointment.id,
      occurrenceId: demoAppointment.occurrenceId,
      status,
      processingRevision,
      currentBundleRevision: 0,
      workflowId: null,
      statusReason: null,
      createdAt: FIXTURE_CLOCK_NOW,
      updatedAt: FIXTURE_CLOCK_NOW,
    };
  }

  async getSession(id: string) {
    return id === SESSION_ID ? structuredClone(this.session) : null;
  }
  async getAppointment(id: string) {
    return this.appointments.find((a) => a.id === id) ?? null;
  }
  async getServiceConfig() {
    return demoConfig;
  }
  async listProviderAppointmentsOverlapping(providerId: string, from: string, to: string) {
    return this.appointments.filter((a) => a.providerId === providerId && a.startAt < to && a.endAt > from);
  }
  async transitionSession(id: string, from: SessionStatus[], to: SessionStatus, reason: string | null): Promise<ConditionalResult<SessionRecord>> {
    if (id !== SESSION_ID) return { ok: false, reason: "not_found" };
    if (!from.includes(this.session.status)) return { ok: false, reason: "invalid_state" };
    this.session.status = to;
    this.session.statusReason = reason;
    this.transitions.push(to);
    return { ok: true, value: structuredClone(this.session) };
  }
  async replaceEvidence() {
    this.evidenceWrites++;
  }
  async saveDraft(bundle: SessionBundle): Promise<ConditionalResult<SessionBundle>> {
    const existing = this.drafts.get(bundle.bundleRevision);
    if (existing) return { ok: true, value: existing };
    if (this.session.processingRevision !== bundle.processingRevision) return { ok: false, reason: "stale_revision" };
    if (this.session.status !== "PROCESSING") return { ok: false, reason: "invalid_state" };
    SessionBundle.parse(bundle);
    this.drafts.set(bundle.bundleRevision, bundle);
    this.draftWrites++;
    this.session.status = "NEEDS_REVIEW";
    this.session.currentBundleRevision = bundle.bundleRevision;
    this.transitions.push("NEEDS_REVIEW");
    return { ok: true, value: bundle };
  }
  async getApprovalForSession() {
    return this.approval;
  }
  /** Simulates the approval service's atomic persistApproval. */
  approve() {
    const rev = this.session.currentBundleRevision;
    this.approval = {
      id: approvalIdFor(SESSION_ID, rev),
      sessionId: SESSION_ID,
      bundleRevision: rev,
      approverProviderId: demoAppointment.providerId,
      approvedAt: FIXTURE_CLOCK_NOW,
      idempotencyKey: "demo-session-approval-request-001",
      requestFingerprint: "fp",
      finalizationStatus: "pending",
    };
    this.session.status = "APPROVED";
    return this.approval;
  }
  async finalizeApproved(sessionId: string, approvalId: string, bundleRevision: number): Promise<ConditionalResult<FinalBundle>> {
    this.finalizeCalls++;
    if (this.final) return { ok: true, value: this.final };
    if (!this.approval || this.approval.id !== approvalId || this.approval.bundleRevision !== bundleRevision) {
      return { ok: false, reason: "invalid_state" };
    }
    const bundle = this.drafts.get(bundleRevision)!;
    this.final = { sessionId, bundleRevision, approvalId, finalizedAt: FIXTURE_CLOCK_NOW, bundle };
    this.approval = { ...this.approval, finalizationStatus: "finalized" };
    this.session.status = "COMPLETED";
    this.transitions.push("COMPLETED");
    return { ok: true, value: this.final };
  }
  async getFinalBundle() {
    return this.final;
  }
  async getBundle(_sessionId: string, rev: number) {
    return this.drafts.get(rev) ?? null;
  }
  snapshots = new Map<number, ClientSnapshot>();
  async getClientSnapshot(_sessionId: string, rev: number) {
    return this.snapshots.get(rev) ?? null;
  }
  async saveClientSnapshot(_sessionId: string, rev: number, snap: ClientSnapshot) {
    if (!this.snapshots.has(rev)) this.snapshots.set(rev, snap);
  }
}

// ------------------------------------------------------------------ stubs
const okEvidence: EvidenceResult = { items: demoEvidence, completeness: "complete", unavailableSourceIds: [], warnings: [] };

function evidenceSource(result: EvidenceResult | Error): EvidenceSource & { calls: number } {
  return {
    mode: "fixture",
    calls: 0,
    async retrieveEvidence() {
      this.calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function extractor(fail?: Error): Extractor & { calls: number } {
  return {
    mode: "fixture",
    calls: 0,
    async extractFacts() {
      this.calls++;
      if (fail) throw fail;
      return { facts: demoFacts, mode: "fixture", model: null, promptVersion: "p1" };
    },
  };
}

const stubMatch: MatchEvidenceFn = (appointment, evidence, competing) => {
  const window = { from: appointment.startAt, to: appointment.endAt };
  const base: Omit<MatchResult, "outcome" | "evidence" | "evidenceWindow"> = {
    competingAppointmentIds: competing.map((a) => a.id),
    window,
    reasons: [],
    warnings: [],
  };
  if (competing.length > 0) return { ...base, outcome: "ambiguous", evidence: [], evidenceWindow: null };
  if (evidence.items.length === 0) return { ...base, outcome: "no_evidence", evidence: [], evidenceWindow: null };
  const items: EvidenceItem[] = evidence.items;
  return {
    ...base,
    outcome: "matched",
    evidence: items,
    evidenceWindow: { from: items[0]!.observedFrom!, to: items[items.length - 1]!.observedTo! },
  };
};

const stubAssemble: AssembleBundleFn = (input) => ({
  sessionId: input.sessionId,
  bundleRevision: input.bundleRevision,
  processingRevision: input.processingRevision,
  appointment: input.appointment,
  config: input.config,
  evidence: input.evidence,
  evidenceWindow: input.evidenceWindow,
  extractedFacts: input.facts,
  facts: input.facts,
  attestations: input.attestations,
  documents: {
    sections: [],
    planCoverage: [],
    timeSummary: {
      scheduledFrom: input.appointment.startAt,
      scheduledTo: input.appointment.endAt,
      scheduledMinutes: 60,
      evidenceWindowFrom: input.evidenceWindow?.from ?? null,
      evidenceWindowTo: input.evidenceWindow?.to ?? null,
      evidenceWindowMinutes: null,
      confirmedMinutes: null,
      timezone: input.appointment.timezone,
    },
  },
  checks: { ruleVersion: input.config.rules.ruleVersion, issues: [], canApprove: false },
  billing: {
    currency: "USD",
    hourlyRateCents: 7500,
    scheduledMinutes: 60,
    confirmedMinutes: null,
    amountCents: null,
    estimateAmountCents: 7500,
    isEstimate: true,
    rateVersion: input.config.rate.rateVersion,
    rounding: "half_up_to_cent",
    breakdown: "estimate",
  },
  provenance: input.provenance,
  createdAt: input.createdAt,
});

function setup(opts: { evidence?: EvidenceResult | Error; extractFail?: Error; status?: SessionStatus; rev?: number } = {}) {
  const repo = new FakeRepo(opts.status ?? "QUEUED", opts.rev ?? 1);
  const ev = evidenceSource(opts.evidence ?? okEvidence);
  const ex = extractor(opts.extractFail);
  const deps: WorkflowDeps = {
    repo: repo as unknown as Repository,
    evidence: ev,
    extractor: ex,
    match: stubMatch,
    assemble: stubAssemble,
    clock: fixtureClock,
    runtimeMode: "local",
    approvalTimeout: "1 minute",
  };
  return { repo, ev, ex, deps };
}

const params = (rev = 1): WorkflowParams => ({ schemaVersion: "1", sessionId: SESSION_ID, processingRevision: rev });
const eventFor = (rev: number) => ({ approvalId: approvalIdFor(SESSION_ID, rev), sessionId: SESSION_ID, bundleRevision: rev });

// ------------------------------------------------------------------ tests
describe("runSessionWorkflow", () => {
  it("drafts to NEEDS_REVIEW, and finalizes without waiting when approval exists before the wait", async () => {
    const { repo, deps } = setup();
    const step = new FakeStep([], () => {
      throw new Error("must not wait");
    });
    // Approve as soon as the draft is saved (before the first approval check).
    const origSave = repo.saveDraft.bind(repo);
    repo.saveDraft = async (b) => {
      const r = await origSave(b);
      repo.approve();
      return r;
    };
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("completed");
    expect(repo.transitions).toEqual(["PROCESSING", "NEEDS_REVIEW", "COMPLETED"]);
    expect(step.names).toEqual(["load session r1", "mark processing", "prepare draft r1", "check approval #0", "finalize r1"]);
    const draft = repo.drafts.get(1)!;
    expect(draft.provenance).toMatchObject({ evidenceMode: "fixture", extractionMode: "fixture", runtimeMode: "local", schemaVersion: "1", promptVersion: "p1", model: null, evidenceCompleteness: "complete" });
    expect(repo.final?.bundleRevision).toBe(1);
  });

  it("completes once when approval arrives via event", async () => {
    const { repo, deps } = setup();
    const step = new FakeStep([{ payload: eventFor(1), before: () => repo.approve() }]);
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("completed");
    expect(step.names).toEqual([
      "load session r1",
      "mark processing",
      "prepare draft r1",
      "check approval #0",
      "await provider approval #0",
      "check approval #1",
      "finalize r1",
    ]);
    expect(repo.finalizeCalls).toBe(1);
    expect(repo.session.status).toBe("COMPLETED");
  });

  it("ignores a spurious/duplicate event without durable approval, then completes on the real one", async () => {
    const { repo, deps } = setup();
    const step = new FakeStep([
      { payload: { approvalId: "approval-x-r9", sessionId: SESSION_ID, bundleRevision: 9 } }, // wrong revision, no approval
      { payload: { bogus: true } },
      { payload: { approvalId: approvalIdFor(SESSION_ID, 1), sessionId: SESSION_ID, bundleRevision: 1 }, before: () => repo.approve() },
    ]);
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("completed");
    expect(repo.finalizeCalls).toBe(1);
    expect(step.names.filter((n) => n.startsWith("await"))).toHaveLength(3);
  });

  it("duplicate approval events after completion are harmless (finalize once, replay idempotent)", async () => {
    const { repo, deps } = setup();
    const step = new FakeStep([{ payload: { approvalId: approvalIdFor(SESSION_ID, 1), sessionId: SESSION_ID, bundleRevision: 1 }, before: () => repo.approve() }]);
    expect((await runSessionWorkflow(deps, params(), step)).outcome).toBe("completed");
    // A second run of the same instance (e.g. replay after a duplicate sendEvent) re-uses memoized steps.
    expect((await runSessionWorkflow(deps, params(), step)).outcome).toBe("completed");
    expect(repo.finalizeCalls).toBe(1);
    expect(repo.draftWrites).toBe(1);
  });

  it("timeout leaves NEEDS_REVIEW unapproved", async () => {
    const { repo, deps } = setup();
    const step = new FakeStep(["timeout"]);
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("approval_timeout");
    expect(repo.session.status).toBe("NEEDS_REVIEW");
    expect(repo.approval).toBeNull();
    expect(repo.finalizeCalls).toBe(0);
    expect(step.names.slice(-2)).toEqual(["await provider approval #0", "check approval after timeout #0"]);
  });

  it("approval persisted around the wait boundary (event lost) is recovered after timeout", async () => {
    const { repo, deps } = setup();
    const step = new FakeStep(["timeout"], () => repo.approve());
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("completed");
    expect(repo.final?.bundleRevision).toBe(1);
  });

  it("upstream evidence error -> FAILED with safe reason", async () => {
    const { repo, deps, ex } = setup({ evidence: new EvidenceUnavailableError("401 token secret-xyz", "auth", false) });
    const res = await runSessionWorkflow(deps, params(), new FakeStep());
    expect(res.outcome).toBe("failed");
    expect(repo.session.status).toBe("FAILED");
    expect(repo.session.statusReason).toBe("Evidence source unavailable (auth).");
    expect(repo.session.statusReason).not.toContain("secret");
    expect(ex.calls).toBe(0);
  });

  it("empty evidence -> NO_EVIDENCE", async () => {
    const { repo, deps } = setup({ evidence: { ...okEvidence, items: [] } });
    const res = await runSessionWorkflow(deps, params(), new FakeStep());
    expect(res.outcome).toBe("no_evidence");
    expect(repo.session.status).toBe("NO_EVIDENCE");
    expect(repo.draftWrites).toBe(0);
  });

  it("competing overlapping appointment -> AMBIGUOUS_MATCH", async () => {
    const { repo, deps, ex } = setup();
    repo.appointments.push({ ...demoAppointment, id: "appointment_other", occurrenceId: "occ_other", startAt: "2026-11-13T18:30:00.000Z", endAt: "2026-11-13T19:30:00.000Z" });
    const res = await runSessionWorkflow(deps, params(), new FakeStep());
    expect(res.outcome).toBe("ambiguous_match");
    expect(repo.session.status).toBe("AMBIGUOUS_MATCH");
    expect(ex.calls).toBe(0);
    expect(repo.evidenceWrites).toBe(0);
  });

  it("extraction rejected -> INCOMPLETE", async () => {
    const { repo, deps } = setup({ extractFail: new ExtractionRejectedError("bad", "unknown_evidence") });
    const res = await runSessionWorkflow(deps, params(), new FakeStep());
    expect(res.outcome).toBe("incomplete");
    expect(repo.session.status).toBe("INCOMPLETE");
    expect(repo.session.statusReason).toBe("Extraction rejected (unknown_evidence).");
    expect(repo.draftWrites).toBe(0);
  });

  it("stale processing revision stops without writes", async () => {
    const { repo, deps, ev } = setup({ rev: 2 });
    const step = new FakeStep();
    const res = await runSessionWorkflow(deps, params(1), step);
    expect(res.outcome).toBe("stale");
    expect(step.names).toEqual(["load session r1"]);
    expect(repo.transitions).toEqual([]);
    expect(ev.calls).toBe(0);
  });

  it("replay of the whole run with memoized steps does not double-write", async () => {
    const { repo, deps, ev, ex } = setup();
    const step = new FakeStep(["timeout"]);
    await runSessionWorkflow(deps, params(), step);
    const executedFirst = [...step.executed];
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("approval_timeout");
    expect(step.executed).toEqual(executedFirst);
    expect(ev.calls).toBe(1);
    expect(ex.calls).toBe(1);
    expect(repo.draftWrites).toBe(1);
    expect(repo.evidenceWrites).toBe(1);
    expect(repo.transitions).toEqual(["PROCESSING", "NEEDS_REVIEW"]);
  });

  it("retry of prepare after draft already saved (step not memoized) is treated as done", async () => {
    const { repo, deps, ev } = setup();
    await runSessionWorkflow(deps, params(), new FakeStep(["timeout"]));
    // Fresh step cache simulates a crash before step results were persisted.
    const res = await runSessionWorkflow(deps, params(), new FakeStep(["timeout"]));
    expect(res.outcome).toBe("approval_timeout");
    expect(repo.draftWrites).toBe(1);
    expect(ev.calls).toBe(1);
    expect(repo.session.currentBundleRevision).toBe(1);
  });

  it("re-processing uses next bundle revision and only finalizes the current approved revision", async () => {
    const { repo, deps } = setup({ rev: 2 });
    repo.session.currentBundleRevision = 3;
    const step = new FakeStep([{ payload: { approvalId: approvalIdFor(SESSION_ID, 4), sessionId: SESSION_ID, bundleRevision: 4 }, before: () => repo.approve() }]);
    const res = await runSessionWorkflow(deps, params(2), step);
    expect(res.outcome).toBe("completed");
    expect(repo.final?.bundleRevision).toBe(4);
    expect(step.names).toContain("finalize r4");
  });
});


// ------------------------------------------------------------------ v3 run history + client pricing
type Rec = Parameters<RunRecorder["record"]>[0];
function fakeRecorder() {
  const events: Rec[] = [];
  const ids = new Set<string>();
  return {
    events,
    async record(e: Rec) {
      const id = `${e.runId}:${e.stage}:${e.status}${e.idSuffix ? ":" + e.idSuffix : ""}`;
      if (ids.has(id)) return;
      ids.add(id);
      events.push(e);
    },
  };
}
const stages = (events: Rec[]) => events.map((e) => `${e.stage}:${e.status}`);

const PLANTED_NAME = "Zebediah Quackenbush";
const client: ClientRecord = {
  clientRef: demoAppointment.clientRef,
  displayName: PLANTED_NAME,
  preferredName: "Zeb",
  hourlyRateCents: 9100,
  fundingSource: "Waiver",
  authorizationNumber: "AUTH-777",
  fiscalIntermediary: null,
  authorizedHours: 40,
  caseManager: "Case Manager Person",
  customFields: [],
  templates: { session_note: null, invoice: null, approval_record: null },
  notes: "secret notes",
  active: true,
  providerId: demoAppointment.providerId,
  rateVersion: 3,
  createdAt: FIXTURE_CLOCK_NOW,
  updatedAt: FIXTURE_CLOCK_NOW,
};

function liveExtractor(): Extractor {
  return {
    mode: "live",
    async extractFacts() {
      return {
        facts: demoFacts,
        mode: "live",
        model: "gpt-4.1",
        promptVersion: "p2",
        aiProvider: "openai",
        privacy: { scrubbed: true, findings: { NAME: 2, EMAIL: 1 } },
      } as Awaited<ReturnType<Extractor["extractFacts"]>>;
    },
  };
}

describe("runSessionWorkflow v3 history", () => {
  it("normal path records the ordered stage list, freezes the client rate and snapshots the client", async () => {
    const { repo, deps } = setup();
    const rec = fakeRecorder();
    deps.recorder = rec;
    deps.extractor = liveExtractor();
    deps.resolveClient = async (a) => (a.clientRef === client.clientRef ? client : null);
    const step = new FakeStep([{ payload: eventFor(1), before: () => repo.approve() }]);
    const res = await runSessionWorkflow(deps, params(), step);
    expect(res.outcome).toBe("completed");
    // Step names unchanged by instrumentation.
    expect(step.names).toEqual([
      "load session r1",
      "mark processing",
      "prepare draft r1",
      "check approval #0",
      "await provider approval #0",
      "check approval #1",
      "finalize r1",
    ]);
    expect(stages(rec.events)).toEqual([
      "workflow_started:started",
      "load:succeeded",
      "evidence:started",
      "evidence:succeeded",
      "match:succeeded",
      "extraction:started",
      "privacy:succeeded",
      "extraction:succeeded",
      "assemble:succeeded",
      "draft_saved:succeeded",
      "approval_wait:waiting",
      "approved:succeeded",
      "client_snapshot:succeeded",
      "finalize:succeeded",
      "files:succeeded",
      "completed:succeeded",
    ]);
    const runId = "wf-sess_test_001-r1";
    expect(rec.events.every((e) => e.runId === runId && e.runKind === "processing" && e.providerId === demoAppointment.providerId)).toBe(true);
    const by = (stage: string, status = "succeeded") => rec.events.find((e) => e.stage === stage && e.status === status)!;
    expect(by("extraction").meta).toMatchObject({ aiProvider: "openai", model: "gpt-4.1", mode: "live", promptVersion: "p2" });
    expect(by("privacy").meta).toMatchObject({ scrubbed: true, findings: 3 });
    expect(by("evidence").meta).toMatchObject({ items: demoEvidence.length, completeness: "complete" });
    expect(by("match").meta).toMatchObject({ outcome: "matched", competing: 0 });
    expect(by("assemble").meta).toMatchObject({ bundleRevision: 1, rateVersion: `client:${client.clientRef}:v3`, canApprove: false, blocking: 0 });
    expect(by("workflow_started", "started").meta).toMatchObject({ clientRef: client.clientRef });

    // Client rate frozen into the draft bundle.
    const draft = repo.drafts.get(1)!;
    expect(draft.config.rate).toMatchObject({ hourlyRateCents: 9100, rateVersion: `client:${client.clientRef}:v3` });
    // Snapshot saved with the bundle's frozen rate.
    expect(repo.snapshots.get(1)).toMatchObject({ clientRef: client.clientRef, effectiveHourlyRateCents: 9100 });

    // No PII / excerpts / tokens anywhere in recorded events.
    const json = JSON.stringify(rec.events);
    for (const planted of [PLANTED_NAME, "Zeb", "AUTH-777", "Case Manager Person", "secret notes", ...demoEvidence.map((e) => e.excerpt)]) {
      expect(json).not.toContain(planted);
    }
  });

  it("replay does not duplicate events; snapshot is idempotent", async () => {
    const { repo, deps } = setup();
    const rec = fakeRecorder();
    const raw: Rec[] = [];
    deps.recorder = { record: async (e) => { raw.push(e); await rec.record(e); } };
    deps.resolveClient = async () => client;
    const step = new FakeStep([{ payload: eventFor(1), before: () => repo.approve() }]);
    await runSessionWorkflow(deps, params(), step);
    const n = raw.length;
    await runSessionWorkflow(deps, params(), step);
    // load step is memoized too, so a replay emits nothing new.
    expect(raw.length).toBe(n);
    expect(repo.snapshots.size).toBe(1);
  });

  it("no client -> agency rate, snapshot skipped", async () => {
    const { repo, deps } = setup();
    const rec = fakeRecorder();
    deps.recorder = rec;
    deps.resolveClient = async () => null;
    const step = new FakeStep([{ payload: eventFor(1), before: () => repo.approve() }]);
    await runSessionWorkflow(deps, params(), step);
    expect(repo.drafts.get(1)!.config.rate).toEqual(demoConfig.rate);
    expect(stages(rec.events)).toContain("client_snapshot:skipped");
    expect(repo.snapshots.size).toBe(0);
  });

  it("failure paths emit stage failure + failed with a safe reason", async () => {
    const cases: { opts: Parameters<typeof setup>[0]; stage: string; detail: string; status: string; reason: string; prep?: (r: FakeRepo) => void }[] = [
      {
        opts: { evidence: new EvidenceUnavailableError("401 token secret-xyz", "auth", false) },
        stage: "evidence",
        detail: "auth",
        status: "FAILED",
        reason: "Evidence source unavailable (auth).",
      },
      { opts: { evidence: { ...okEvidence, items: [] } }, stage: "evidence", detail: "", status: "NO_EVIDENCE", reason: "No evidence found for the appointment window." },
      {
        opts: {},
        stage: "match",
        detail: "ambiguous",
        status: "AMBIGUOUS_MATCH",
        reason: "Evidence could match more than one appointment.",
        prep: (r) => r.appointments.push({ ...demoAppointment, id: "appointment_other", occurrenceId: "occ_other" }),
      },
      {
        opts: { extractFail: new ExtractionRejectedError("model said: Zebediah Quackenbush", "schema") },
        stage: "extraction",
        detail: "schema",
        status: "INCOMPLETE",
        reason: "Extraction rejected (schema).",
      },
    ];
    for (const c of cases) {
      const { repo, deps } = setup(c.opts);
      c.prep?.(repo);
      const rec = fakeRecorder();
      deps.recorder = rec;
      await runSessionWorkflow(deps, params(), new FakeStep());
      const last = rec.events[rec.events.length - 1]!;
      expect(last).toMatchObject({ stage: "failed", status: "failed", detail: c.reason, meta: { status: c.status } });
      if (c.detail) expect(rec.events.find((e) => e.stage === c.stage && e.status === "failed")?.detail).toBe(c.detail);
      const json = JSON.stringify(rec.events);
      expect(json).not.toContain("secret-xyz");
      expect(json).not.toContain(PLANTED_NAME);
      expect(stages(rec.events)).not.toContain("draft_saved:succeeded");
    }
  });

  it("timeout records an info approval_wait; a throwing recorder never fails the run", async () => {
    const { deps } = setup();
    const rec = fakeRecorder();
    deps.recorder = rec;
    await runSessionWorkflow(deps, params(), new FakeStep(["timeout"]));
    expect(rec.events.find((e) => e.stage === "approval_wait" && e.status === "info")?.detail).toBe("approval_timeout");

    const s2 = setup();
    s2.deps.recorder = { record: async () => { throw new Error("boom"); } };
    const step = new FakeStep([{ payload: eventFor(1), before: () => s2.repo.approve() }]);
    expect((await runSessionWorkflow(s2.deps, params(), step)).outcome).toBe("completed");
  });
});
