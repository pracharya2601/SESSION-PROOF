import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertOctagon,
  ArrowLeft,
  CheckCircle2,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Info,
  ListChecks,
  Loader2,
  MessagesSquare,
  PencilLine,
  Receipt,
  RefreshCw,
  Target,
} from "lucide-react";
import type { ApprovalRequest, ApproveResponse, ReviewEdits, ReviewRequest, SessionBundle, SessionDetail } from "../../contracts";
import { api, ApiClientError } from "../api";
import { Button, Skeleton } from "../design";
import { DocumentSections } from "../components/review/DocumentSections";
import { EvidencePanel } from "../components/review/EvidencePanel";
import { PlanCoverage } from "../components/review/PlanCoverage";
import { ChecksPanel } from "../components/review/ChecksPanel";
import { TimePanel } from "../components/review/TimePanel";
import { BillingPanel } from "../components/review/BillingPanel";
import {
  CorrectionForm,
  MAX_ACTIVITY_SUMMARY,
  MAX_PARTICIPANT_CHOICES,
  validateMinutes,
  type CorrectionValues,
  type DirectedValue,
} from "../components/review/CorrectionForm";
import { RunTimeline } from "../components/runs/RunTimeline";
import { ApprovalRecordPanel } from "../components/review/ApprovalRecordPanel";
import { FilesCard } from "../components/review/FilesCard";
import { AmendBanner, AmendCard } from "../components/review/AmendCard";
import { Section } from "../components/review/Section";
import { ReviewSummary } from "../components/review/ReviewSummary";
import { formatCents } from "../components/review/format";
import { rvSpring, rvStagger, useMotionOK } from "../components/review/motion";
import { AssistantChat, type ApplyResult } from "../components/review-chat/AssistantChat";
import { ClaimList } from "../components/review-chat/ClaimList";
import { Accordion } from "../components/review-chat/Accordion";
import { initialOpen, refusedClaimId, sectionBlockers } from "../components/review-chat/helpers";
import "../components/review/review.css";
import "../components/review-chat/chat.css";

const POLL_MS = 2000;
const POLL_MAX = 30;

interface UiError {
  message: string;
  correlationId?: string;
  details?: string[];
}

function toUiError(e: unknown): UiError {
  if (e instanceof ApiClientError) {
    const raw = (e as unknown as { details?: unknown }).details;
    let details: string[] | undefined;
    if (Array.isArray(raw)) {
      details = raw.map((d) =>
        typeof d === "string" ? d : d && typeof d === "object" && "message" in d ? String((d as { message: unknown }).message) : JSON.stringify(d),
      );
    }
    return { message: e.message, correlationId: e.correlationId || undefined, details };
  }
  return { message: e instanceof Error ? e.message : "Unexpected error." };
}

function idemStorageKey(sessionId: string, revision: number): string {
  return `rv-idem:${sessionId}:${revision}`;
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** One idempotency key per (sessionId, revision), reused on retry. */
function getOrCreateIdemKey(cache: Map<string, string>, sessionId: string, revision: number): string {
  const k = idemStorageKey(sessionId, revision);
  const cached = cache.get(k);
  if (cached) return cached;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(k);
  } catch {
    stored = null;
  }
  const key = stored && /^[A-Za-z0-9._:-]{8,128}$/.test(stored) ? stored : newKey();
  cache.set(k, key);
  try {
    window.sessionStorage.setItem(k, key);
  } catch {
    /* storage unavailable — in-memory key still reused for this page */
  }
  return key;
}

/** Latest provider attestation text for a field (participant_direction / participant_choices). */
function latestAttestation(
  bundle: SessionBundle | null,
  field: "participant_direction" | "participant_choices" | "activity_summary",
): string | null {
  let best: { text: string; at: string } | null = null;
  for (const a of bundle?.attestations ?? []) {
    if (a.field !== field) continue;
    if (!best || a.attestedAt >= best.at) best = { text: a.text, at: a.attestedAt };
  }
  return best ? best.text : null;
}

function attestedDirected(bundle: SessionBundle | null): DirectedValue {
  const t = latestAttestation(bundle, "participant_direction")?.trim().toLowerCase() ?? "";
  if (t.startsWith("yes")) return "yes";
  if (t.startsWith("no")) return "no";
  return "unset";
}

/** Plan goal ids the provider has confirmed as addressed (goal_addressed attestations), in plan order. */
function confirmedGoals(bundle: SessionBundle | null): string[] {
  const ids = new Set((bundle?.attestations ?? []).filter((a) => a.field === "goal_addressed").map((a) => a.text.trim()));
  return (bundle?.config.plan.goals ?? []).map((g) => g.goalId).filter((id) => ids.has(id));
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));



function initialValues(bundle: SessionBundle | null): CorrectionValues {
  // Never prefill from the schedule: only an existing provider-confirmed value.
  const c = bundle?.documents.timeSummary.confirmedMinutes ?? null;
  return {
    progress: "",
    minutes: c !== null ? String(c) : "",
    directed: attestedDirected(bundle),
    choices: latestAttestation(bundle, "participant_choices") ?? "",
    goals: confirmedGoals(bundle),
    summary: latestAttestation(bundle, "activity_summary") ?? "",
  };
}

function blockerLines(d: SessionDetail | null): string[] | undefined {
  const issues = d?.bundle?.checks.issues.filter((i) => i.blocking) ?? [];
  return issues.length > 0 ? issues.map((i) => `${i.field}: ${i.message}`) : undefined;
}

/**
 * Where the review page reads and writes. Default: the cookie API. The review-link page
 * (src/ui/pages/ReviewLink.tsx) passes token-authenticated calls and `linkMode`, which hides
 * the parts that need a signed-in session (run history, amend, files, export).
 */
export interface ReviewSource {
  getSession(id: string): Promise<SessionDetail>;
  saveReview(id: string, req: ReviewRequest): Promise<SessionBundle>;
  approve(id: string, req: ApprovalRequest): Promise<{ status: number; data: ApproveResponse }>;
  linkMode?: boolean;
}

export default function Review(props: { sessionId: string; onBack: () => void; source?: ReviewSource }) {
  const { sessionId } = props;
  const src: ReviewSource = props.source ?? api;
  const linkMode = props.source?.linkMode === true;
  const motionOK = useMotionOK();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<CorrectionValues>({ progress: "", minutes: "", directed: "unset", choices: "" });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [assistantOff, setAssistantOff] = useState<string | null>(null);
  const [preferredName, setPreferredName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [celebrate, setCelebrate] = useState(0);
  const idemCache = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const pollToken = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollToken.current++;
    };
  }, []);

  const bundle = detail?.bundle ?? null;
  const revision = bundle?.bundleRevision ?? null;
  const status = detail?.session.status;

  const fetchDetail = useCallback(async (): Promise<SessionDetail | null> => {
    try {
      const d = await src.getSession(sessionId);
      if (!mounted.current) return null;
      setDetail(d);
      setLoadError(null);
      return d;
    } catch (e) {
      if (mounted.current) setLoadError(toUiError(e));
      return null;
    }
  }, [sessionId, src]);

  const pollUntilCompleted = useCallback(async () => {
    const token = ++pollToken.current;
    setFinalizing(true);
    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!mounted.current || token !== pollToken.current) return;
      let d: SessionDetail | null = null;
      try {
        d = await src.getSession(sessionId);
      } catch {
        d = null; // transient; keep polling
      }
      if (!mounted.current || token !== pollToken.current) return;
      if (d) {
        setDetail(d);
        if (d.session.status === "COMPLETED") {
          setFinalizing(false);
          setNotice(`Completed — revision ${d.approval?.bundleRevision ?? d.session.currentBundleRevision} finalized.`);
          setCelebrate((c) => c + 1);
          return;
        }
      }
    }
    if (mounted.current && token === pollToken.current) {
      setFinalizing(false);
      setNotice("Approval is recorded; finalization is still pending. Refresh later to see the completed bundle.");
    }
  }, [sessionId, src]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    setError(null);
    src
      .getSession(sessionId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setValues(initialValues(d.bundle));
        setOpen(initialOpen(d.bundle));
        setLoadError(null);
        if (d.session.status === "APPROVED") void pollUntilCompleted();
      })
      .catch((e) => {
        if (!cancelled) setLoadError(toUiError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, pollUntilCompleted, src]);

  // Preferred name, if on file (signed-in only; review links never fetch client records).
  const clientRef = detail?.appointment.clientRef;
  useEffect(() => {
    if (linkMode || !clientRef) return;
    let cancelled = false;
    api
      .getClient(clientRef)
      .then((s) => {
        if (!cancelled) setPreferredName(s.client.preferredName?.trim() || null);
      })
      .catch(() => {
        /* no client record — show the reference only */
      });
    return () => {
      cancelled = true;
    };
  }, [clientRef, linkMode]);

  const onAssistantUnavailable = useCallback((reason: string) => {
    setAssistantOff(reason);
    setOpen((o) => ({ ...o, manual: true }));
  }, []);

  // ----- form state
  const currentConfirmed = bundle?.documents.timeSummary.confirmedMinutes ?? null;
  const progressTrim = values.progress.trim();
  const minutesTrim = values.minutes.trim();
  const minutesChanged = minutesTrim !== "" && Number(minutesTrim) !== currentConfirmed;
  const progressChanged = progressTrim !== "";
  const minutesCleared = minutesTrim === "" && currentConfirmed !== null;
  const currentDirected = attestedDirected(bundle);
  const currentChoices = latestAttestation(bundle, "participant_choices");
  const directedValue = values.directed ?? currentDirected;
  const directedChanged = directedValue !== "unset" && directedValue !== currentDirected;
  const directedCleared = directedValue === "unset" && currentDirected !== "unset";
  const choicesTrim = (values.choices ?? "").trim();
  const choicesChanged = choicesTrim !== "" && choicesTrim !== (currentChoices ?? "").trim();
  const choicesCleared = choicesTrim === "" && !!currentChoices;
  const currentGoals = confirmedGoals(bundle);
  const goalsValue = values.goals ?? currentGoals;
  const goalsChanged = !sameIds(goalsValue, currentGoals);
  const currentSummary = latestAttestation(bundle, "activity_summary");
  const summaryTrim = (values.summary ?? "").trim();
  const summaryChanged = summaryTrim !== "" && summaryTrim !== (currentSummary ?? "").trim();
  const summaryCleared = summaryTrim === "" && !!currentSummary;
  const dirty =
    progressChanged ||
    minutesChanged ||
    minutesCleared ||
    directedChanged ||
    directedCleared ||
    choicesChanged ||
    choicesCleared ||
    goalsChanged ||
    summaryChanged ||
    summaryCleared;

  function buildEdits(): ReviewEdits | null {
    const edits: {
      confirmedMinutes?: number;
      progressConfirmation?: string;
      participantDirected?: boolean;
      participantChoices?: string;
      goalsAddressed?: string[];
      activitySummary?: string;
    } = {};
    if (minutesChanged && !validateMinutes(values.minutes)) edits.confirmedMinutes = Number(minutesTrim);
    if (progressChanged) edits.progressConfirmation = progressTrim;
    if (directedChanged) edits.participantDirected = directedValue === "yes";
    if (choicesChanged && choicesTrim.length <= MAX_PARTICIPANT_CHOICES) edits.participantChoices = choicesTrim;
    if (goalsChanged) edits.goalsAddressed = goalsValue;
    if (summaryChanged && summaryTrim.length <= MAX_ACTIVITY_SUMMARY) edits.activitySummary = summaryTrim;
    return Object.values(edits).some((v) => v !== undefined) ? (edits as ReviewEdits) : null;
  }

  // 409: refetch the record but keep the user's typed form values (never overwrite the form).
  async function handleConflict() {
    setError({ message: "This record changed elsewhere — reloaded. Please re-review." });
    setNotice(null);
    await fetchDetail();
  }

  async function onSave() {
    if (!bundle || saving) return;
    const edits = buildEdits();
    if (!edits) {
      setError({ message: "Nothing to save. A confirmed duration or participant direction cannot be removed, only changed." });
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await src.saveReview(sessionId, { expectedRevision: bundle.bundleRevision, edits });
      if (!mounted.current) return;
      setDetail((d) =>
        d ? { ...d, bundle: next, session: { ...d.session, currentBundleRevision: next.bundleRevision } } : d,
      );
      setValues(initialValues(next));
      const amount = next.billing.isEstimate ? next.billing.estimateAmountCents : next.billing.amountCents;
      setNotice(
        `Saved revision ${next.bundleRevision} — amount recalculated by server: ${formatCents(amount)}${next.billing.isEstimate ? " (estimate)" : ""}`,
      );
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiClientError && e.status === 409) await handleConflict();
      else setError(toUiError(e));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  /** Saves edits from the assistant or a claim's Remove… control (same PATCH review, revision-guarded). */
  async function applyEdits(edits: ReviewEdits): Promise<ApplyResult> {
    if (!bundle) return { ok: false, conflict: false, message: "Nothing to save yet." };
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await src.saveReview(sessionId, { expectedRevision: bundle.bundleRevision, edits });
      if (!mounted.current) return { ok: true, revision: next.bundleRevision };
      setDetail((d) => (d ? { ...d, bundle: next, session: { ...d.session, currentBundleRevision: next.bundleRevision } } : d));
      if (!dirty) setValues(initialValues(next));
      const amount = next.billing.isEstimate ? next.billing.estimateAmountCents : next.billing.amountCents;
      setNotice(`Saved revision ${next.bundleRevision} — amount recalculated by server: ${formatCents(amount)}${next.billing.isEstimate ? " (estimate)" : ""}`);
      return { ok: true, revision: next.bundleRevision };
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409) {
        await handleConflict();
        return { ok: false, conflict: true, message: "This record changed elsewhere — reloaded. Ask again for the latest version." };
      }
      const ue = toUiError(e);
      if (mounted.current) setError(ue);
      return { ok: false, conflict: false, message: ue.message };
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function onApprove() {
    if (!bundle || approving) return;
    // Approve exactly the displayed (saved) revision.
    const rev = bundle.bundleRevision;
    const idempotencyKey = getOrCreateIdemKey(idemCache.current, sessionId, rev);
    setApproving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await src.approve(sessionId, { expectedRevision: rev, idempotencyKey });
      if (!mounted.current) return;
      setDetail((d) => (d ? { ...d, approval: res.data.approval } : d));
      if (res.status === 202 || res.data.finalization === "pending") {
        setNotice("Approved — finalizing…");
        await fetchDetail();
        void pollUntilCompleted();
      } else {
        const d = await fetchDetail();
        if (d && d.session.status === "COMPLETED") {
          setNotice(`Completed — revision ${res.data.approval.bundleRevision} finalized.`);
          setCelebrate((c) => c + 1);
        } else void pollUntilCompleted();
      }
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiClientError && e.status === 409) await handleConflict();
      else if (e instanceof ApiClientError && e.status === 422) {
        const ue = toUiError(e);
        const d = await fetchDetail();
        setError({ ...ue, message: `Approval blocked: ${ue.message}`, details: ue.details ?? blockerLines(d) });
      } else setError(toUiError(e));
    } finally {
      if (mounted.current) setApproving(false);
    }
  }

  const onEvidence = useCallback((id: string) => {
    setOpen((o) => ({ ...o, evidence: true }));
    setHighlight(id);
    setFocusTick((t) => t + 1);
  }, []);

  // ----- render
  if (loading && !detail) {
    return (
      <div className="rv-page" aria-busy="true">
        <p className="rv-sr" role="status">
          Loading session…
        </p>
        <div className="rv-hero rv-skel-hero">
          <Skeleton width={120} height={12} />
          <Skeleton width="45%" height={30} />
          <Skeleton width="30%" height={14} />
        </div>
        <div className="rv-grid">
          <div className="rv-main">
            <div className="ds-card ds-pad-md rv-card rv-skel-card">
              <Skeleton lines={6} />
            </div>
            <div className="ds-card ds-pad-md rv-card rv-skel-card">
              <Skeleton lines={4} />
            </div>
          </div>
          <div className="rv-rail">
            <div className="ds-card ds-pad-md rv-card rv-skel-card">
              <Skeleton width="40%" height={36} />
              <Skeleton lines={2} />
            </div>
            <div className="ds-card ds-pad-md rv-card rv-skel-card">
              <Skeleton lines={3} />
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="rv-page">
        <div>
          <Button variant="ghost" size="sm" onClick={props.onBack} icon={<ArrowLeft size={16} />}>
            Back to sessions
          </Button>
        </div>
        <div className="rv-alert rv-alert-danger" role="alert">
          <AlertOctagon size={18} aria-hidden="true" />
          <div>
            {loadError?.message ?? "Session could not be loaded."}
            {loadError?.correlationId && <div className="rv-muted rv-small">Reference: {loadError.correlationId}</div>}
          </div>
        </div>
      </div>
    );
  }

  const tz = detail.appointment.timezone;
  const editable = status === "NEEDS_REVIEW" && !!bundle;
  const completed = status === "COMPLETED";

  let approveReason: string | null = null;
  if (!bundle) approveReason = "No bundle to approve yet.";
  else if (status !== "NEEDS_REVIEW") approveReason = `Approval is only available while the session needs review (current status: ${status}).`;
  else if (dirty) approveReason = "Save or discard your changes first — approval applies only to a saved revision.";
  else if (saving) approveReason = "Saving…";
  else if (bundle.checks.issues.some((i) => i.code === "BUSINESS_PROFILE_INCOMPLETE"))
    approveReason = "Complete your business profile (vendor #, address) before approving — Settings → Business profile.";
  else if (!bundle.checks.canApprove) approveReason = "Blocking documentation checks must be fixed before approval.";
  const canApprove = approveReason === null && !approving;

  const blockers = sectionBlockers(bundle);
  const toggle = (k: string) => (v: boolean) => setOpen((o) => ({ ...o, [k]: v }));
  const badge = (n: number) => (n > 0 ? { text: `${n} to fix`, tone: "danger" as const } : null);
  const chatOn = editable && !linkMode && assistantOff === null;
  const refusedCount = (bundle?.checks.issues ?? []).filter((i) => refusedClaimId(i)).length;

  const manualForm =
    editable && bundle ? (
      <Accordion id="manual" title="Edit manually" icon={<PencilLine size={16} />} open={!!open.manual} onToggle={toggle("manual")}>
        <CorrectionForm
          values={values}
          onChange={setValues}
          onSave={() => void onSave()}
          onDiscard={() => setValues(initialValues(bundle))}
          dirty={dirty}
          saving={saving}
          scheduledMinutes={bundle.documents.timeSummary.scheduledMinutes}
          currentConfirmed={currentConfirmed}
          currentDirected={currentDirected}
          currentChoices={currentChoices}
          goals={bundle.config.plan.goals}
          currentGoals={currentGoals}
          currentSummary={currentSummary}
        />
      </Accordion>
    ) : null;

  return (
    <motion.div className="rv-page" variants={rvStagger} initial="hidden" animate="show">
      <ReviewSummary
        detail={detail}
        bundle={bundle}
        preferredName={preferredName}
        onBack={props.onBack}
        editable={editable}
        completed={completed}
        finalizing={finalizing}
        approving={approving}
        canApprove={canApprove}
        approveReason={approveReason}
        onApprove={() => void onApprove()}
        celebrate={celebrate}
      />

      <div aria-live="polite" className="rv-alerts">
        <AnimatePresence initial={false}>
          {notice && (
            <motion.div
              key={"n:" + notice}
              className={`rv-alert ${completed ? "rv-alert-ok" : "rv-alert-info"}`}
              initial={motionOK ? { opacity: 0, y: -8, scale: 0.98 } : { opacity: 0 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={rvSpring}
            >
              {completed ? <CheckCircle2 size={18} aria-hidden="true" /> : <Info size={18} aria-hidden="true" />}
              <span>{notice}</span>
            </motion.div>
          )}
          {finalizing && !notice && (
            <motion.div key="finalizing" className="rv-alert rv-alert-info" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Loader2 size={18} className="ds-spin" aria-hidden="true" />
              <span>Approved — finalizing…</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            key="error"
            className="rv-alert rv-alert-danger"
            role="alert"
            initial={motionOK ? { opacity: 0, x: -12 } : { opacity: 0 }}
            animate={motionOK ? { opacity: 1, x: [-12, 6, -3, 0] } : { opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45 }}
          >
            <AlertOctagon size={18} aria-hidden="true" />
            <div>
              {error.message}
              {error.details && error.details.length > 0 && (
                <ul className="rv-err-details">
                  {error.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
              {error.correlationId && <div className="rv-muted rv-small">Reference: {error.correlationId}</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {loadError && detail && (
        <div className="rv-alert rv-alert-danger" role="alert">
          <AlertOctagon size={18} aria-hidden="true" />
          <span>
            Refresh failed: {loadError.message}
            {loadError.correlationId && <span className="rv-muted"> (Reference: {loadError.correlationId})</span>}
          </span>
        </div>
      )}

      {!bundle ? (
        <>
          <Section label="No bundle" className="rv-empty">
            <p>No review bundle is available for this session yet.</p>
            <div>
              <Button icon={<RefreshCw size={16} />} onClick={() => void fetchDetail()}>
                Refresh
              </Button>
            </div>
          </Section>
          {!linkMode && (
            <div className="rvx-acc">
              <Accordion id="runs" title="Run history" icon={<History size={16} />} open={!!open.runs} onToggle={toggle("runs")}>
                <RunTimeline sessionId={sessionId} />
              </Accordion>
            </div>
          )}
        </>
      ) : (
        <div className={`rvx-layout${chatOn ? "" : " no-chat"}`}>
          <div className="rvx-left">
            {chatOn && (
              <AssistantChat
                sessionId={sessionId}
                bundle={bundle}
                timezone={tz}
                editable={editable}
                onApply={applyEdits}
                onCite={onEvidence}
                onUnavailable={onAssistantUnavailable}
              />
            )}
            {!chatOn && editable && assistantOff && <p className="rvx-off">{assistantOff}</p>}
            {!chatOn && manualForm}
          </div>

          <div className="rvx-acc" aria-label="Session details">
            <Accordion
              id="note"
              title="Session note & documents"
              icon={<FileText size={16} />}
              badge={badge(blockers.note)}
              open={!!open.note}
              onToggle={toggle("note")}
            >
              <DocumentSections sections={bundle.documents.sections} onEvidence={onEvidence} activeEvidence={highlight} />
              <ClaimList
                bundle={bundle}
                timezone={tz}
                editable={editable}
                busy={saving}
                onCite={onEvidence}
                onSave={(edits) => applyEdits(edits)}
              />
              {refusedCount > 0 && editable && (
                <p className="rvx-hint">
                  {refusedCount} statement{refusedCount === 1 ? " was" : "s were"} refused by the rules — remove {refusedCount === 1 ? "it" : "them"} above, or ask the assistant.
                </p>
              )}
            </Accordion>
            <Accordion
              id="checklist"
              title="Checklist"
              icon={<ListChecks size={16} />}
              badge={blockers.checklist > 0 ? badge(blockers.checklist) : { text: "Ready", tone: "ok" }}
              open={!!open.checklist}
              onToggle={toggle("checklist")}
            >
              <ChecksPanel checks={bundle.checks} revision={bundle.bundleRevision} />
            </Accordion>
            <Accordion
              id="invoice"
              title="Invoice & time"
              icon={<Receipt size={16} />}
              badge={badge(blockers.invoice)}
              open={!!open.invoice}
              onToggle={toggle("invoice")}
            >
              <TimePanel time={bundle.documents.timeSummary} />
              <BillingPanel billing={bundle.billing} revision={bundle.bundleRevision} />
            </Accordion>
            <Accordion
              id="evidence"
              title="Transcript & evidence"
              icon={<MessagesSquare size={16} />}
              badge={{ text: String(bundle.evidence.length), tone: "neutral" }}
              open={!!open.evidence}
              onToggle={toggle("evidence")}
            >
              <EvidencePanel evidence={bundle.evidence} timezone={tz} highlightId={highlight} focusTick={focusTick} />
            </Accordion>
            <Accordion
              id="coverage"
              title="Plan coverage"
              icon={<Target size={16} />}
              badge={badge(blockers.coverage)}
              open={!!open.coverage}
              onToggle={toggle("coverage")}
            >
              <PlanCoverage entries={bundle.documents.planCoverage} />
            </Accordion>
            {!linkMode && (
              <Accordion id="runs" title="Run history (agent observations)" icon={<History size={16} />} open={!!open.runs} onToggle={toggle("runs")}>
                <RunTimeline sessionId={sessionId} />
              </Accordion>
            )}
            {!linkMode && (
              <Accordion id="files" title="Files" icon={<FolderOpen size={16} />} open={!!open.files} onToggle={toggle("files")}>
                {completed ? (
                  <FilesCard sessionId={sessionId} revision={detail.approval?.bundleRevision ?? revision} />
                ) : (
                  <p className="rvx-hint">Final PDFs and exports are created after approval.</p>
                )}
              </Accordion>
            )}
            {!linkMode && (
              <Accordion id="amend" title="Amend & revisions" icon={<GitBranch size={16} />} open={!!open.amend} onToggle={toggle("amend")}>
                <AmendBanner detail={detail} />
                {detail.approval && <ApprovalRecordPanel approval={detail.approval} timezone={tz} completed={completed} />}
                <AmendCard
                  detail={detail}
                  onChanged={async () => {
                    const d = await fetchDetail();
                    if (d) setValues(initialValues(d.bundle));
                  }}
                />
              </Accordion>
            )}
            {chatOn && manualForm}
          </div>
        </div>
      )}
    </motion.div>
  );
}
