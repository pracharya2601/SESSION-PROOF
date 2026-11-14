import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertOctagon, ArrowLeft, CheckCircle2, ChevronDown, History, Info, Loader2, RefreshCw } from "lucide-react";
import type { ReviewEdits, SessionBundle, SessionDetail } from "../../contracts";
import { api, ApiClientError } from "../api";
import { Button, Skeleton, StatusPill } from "../design";
import { SessionHeader } from "../components/review/SessionHeader";
import { DocumentSections } from "../components/review/DocumentSections";
import { EvidencePanel } from "../components/review/EvidencePanel";
import { PlanCoverage } from "../components/review/PlanCoverage";
import { ChecksPanel } from "../components/review/ChecksPanel";
import { TimePanel } from "../components/review/TimePanel";
import { BillingPanel } from "../components/review/BillingPanel";
import {
  CorrectionForm,
  MAX_PARTICIPANT_CHOICES,
  validateMinutes,
  type CorrectionValues,
  type DirectedValue,
} from "../components/review/CorrectionForm";
import { RunTimeline } from "../components/runs/RunTimeline";
import { ApprovalRecordPanel } from "../components/review/ApprovalRecordPanel";
import { ApproveButton } from "../components/review/ApproveButton";
import { FilesCard } from "../components/review/FilesCard";
import { AmendBanner, AmendCard } from "../components/review/AmendCard";
import { Celebration } from "../components/review/Celebration";
import { RevisionBadge } from "../components/review/RevisionBadge";
import { Section } from "../components/review/Section";
import { formatCents } from "../components/review/format";
import { rvItem, rvItemReduced, rvSpring, rvStagger, useMotionOK } from "../components/review/motion";
import "../components/review/review.css";

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
function latestAttestation(bundle: SessionBundle | null, field: "participant_direction" | "participant_choices"): string | null {
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

function initialValues(bundle: SessionBundle | null): CorrectionValues {
  // Never prefill from the schedule: only an existing provider-confirmed value.
  const c = bundle?.documents.timeSummary.confirmedMinutes ?? null;
  return {
    progress: "",
    minutes: c !== null ? String(c) : "",
    directed: attestedDirected(bundle),
    choices: latestAttestation(bundle, "participant_choices") ?? "",
  };
}

function blockerLines(d: SessionDetail | null): string[] | undefined {
  const issues = d?.bundle?.checks.issues.filter((i) => i.blocking) ?? [];
  return issues.length > 0 ? issues.map((i) => `${i.field}: ${i.message}`) : undefined;
}

export default function Review(props: { sessionId: string; onBack: () => void }) {
  const { sessionId } = props;
  const motionOK = useMotionOK();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<CorrectionValues>({ progress: "", minutes: "", directed: "unset", choices: "" });
  const [historyOpen, setHistoryOpen] = useState(true);
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
      const d = await api.getSession(sessionId);
      if (!mounted.current) return null;
      setDetail(d);
      setLoadError(null);
      return d;
    } catch (e) {
      if (mounted.current) setLoadError(toUiError(e));
      return null;
    }
  }, [sessionId]);

  const pollUntilCompleted = useCallback(async () => {
    const token = ++pollToken.current;
    setFinalizing(true);
    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!mounted.current || token !== pollToken.current) return;
      let d: SessionDetail | null = null;
      try {
        d = await api.getSession(sessionId);
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
  }, [sessionId]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    setError(null);
    api
      .getSession(sessionId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setValues(initialValues(d.bundle));
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
  }, [sessionId, pollUntilCompleted]);

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
  const dirty =
    progressChanged || minutesChanged || minutesCleared || directedChanged || directedCleared || choicesChanged || choicesCleared;

  function buildEdits(): ReviewEdits | null {
    const edits: {
      confirmedMinutes?: number;
      progressConfirmation?: string;
      participantDirected?: boolean;
      participantChoices?: string;
    } = {};
    if (minutesChanged && !validateMinutes(values.minutes)) edits.confirmedMinutes = Number(minutesTrim);
    if (progressChanged) edits.progressConfirmation = progressTrim;
    if (directedChanged) edits.participantDirected = directedValue === "yes";
    if (choicesChanged && choicesTrim.length <= MAX_PARTICIPANT_CHOICES) edits.participantChoices = choicesTrim;
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
      const next = await api.saveReview(sessionId, { expectedRevision: bundle.bundleRevision, edits });
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

  async function onApprove() {
    if (!bundle || approving) return;
    // Approve exactly the displayed (saved) revision.
    const rev = bundle.bundleRevision;
    const idempotencyKey = getOrCreateIdemKey(idemCache.current, sessionId, rev);
    setApproving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.approve(sessionId, { expectedRevision: rev, idempotencyKey });
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
  else if (!bundle.checks.canApprove) approveReason = "Blocking documentation checks must be fixed before approval.";
  const canApprove = approveReason === null && !approving;

  const itemV = motionOK ? rvItem : rvItemReduced;

  const historySection = (
    <Section
      label="History"
      title="History"
      icon={<History size={18} />}
      className="rv-history"
      aside={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={historyOpen ? "Collapse history" : "Expand history"}
          aria-expanded={historyOpen}
          aria-controls="rv-history-body"
          onClick={() => setHistoryOpen((o) => !o)}
          icon={
            <motion.span style={{ display: "inline-flex" }} animate={{ rotate: historyOpen ? 180 : 0 }}>
              <ChevronDown size={16} />
            </motion.span>
          }
        />
      }
    >
      <AnimatePresence initial={false}>
        {historyOpen && (
          <motion.div
            id="rv-history-body"
            key="history"
            style={{ overflow: "hidden" }}
            initial={motionOK ? { height: 0, opacity: 0 } : { opacity: 0 }}
            animate={motionOK ? { height: "auto", opacity: 1 } : { opacity: 1 }}
            exit={motionOK ? { height: 0, opacity: 0 } : { opacity: 0 }}
            transition={{ duration: motionOK ? 0.28 : 0.1 }}
          >
            <div style={{ paddingTop: "var(--sp-3, 12px)" }}>
              <RunTimeline sessionId={sessionId} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );

  return (
    <motion.div className="rv-page" variants={rvStagger} initial="hidden" animate="show">
      <SessionHeader
        appointment={detail.appointment}
        session={detail.session}
        revision={revision}
        provenance={bundle?.provenance ?? null}
        serviceDescription={bundle?.config.plan.serviceDescription}
        onBack={props.onBack}
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
        <Section label="No bundle" className="rv-empty">
          <p>No review bundle is available for this session yet.</p>
          <div>
            <Button icon={<RefreshCw size={16} />} onClick={() => void fetchDetail()}>
              Refresh
            </Button>
          </div>
        </Section>
      ) : null}
      {!bundle && historySection}
      {!bundle ? null : (
        <div className="rv-grid">
          <motion.div className="rv-main" variants={rvStagger}>
            <DocumentSections sections={bundle.documents.sections} onEvidence={onEvidence} activeEvidence={highlight} />
            <PlanCoverage entries={bundle.documents.planCoverage} />
            <EvidencePanel evidence={bundle.evidence} timezone={tz} highlightId={highlight} focusTick={focusTick} />
            {historySection}
          </motion.div>

          <motion.aside className="rv-rail" variants={rvStagger} aria-label="Review summary and actions">
            <motion.section
              className={`ds-card ds-pad-md rv-card rv-status-card${completed ? " is-complete" : ""}`}
              aria-label="Status"
              variants={itemV}
            >
              <Celebration burstKey={celebrate} />
              <div className="rv-status-row">
                <StatusPill status={detail.session.status} />
                {revision !== null && <RevisionBadge revision={revision} />}
              </div>
              <AnimatePresence mode="wait" initial={false}>
                {completed ? (
                  <motion.div
                    key="done"
                    className="rv-done"
                    initial={motionOK ? { opacity: 0, scale: 0.9 } : { opacity: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={rvSpring}
                  >
                    <svg className="rv-done-check" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
                      <motion.circle
                        cx="22"
                        cy="22"
                        r="19"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        initial={motionOK ? { pathLength: 0 } : false}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                      />
                      <motion.path
                        d="M13 22.5l6 6 12-13"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={motionOK ? { pathLength: 0 } : false}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 0.45, delay: 0.45, ease: "easeOut" }}
                      />
                    </svg>
                    <div>
                      <p className="rv-done-title">Session completed</p>
                      <p className="rv-muted rv-small">
                        Revision {detail.approval?.bundleRevision ?? detail.session.currentBundleRevision} is final. Files are ready.
                      </p>
                    </div>
                  </motion.div>
                ) : finalizing || status === "APPROVED" ? (
                  <motion.p key="fin" className="rv-muted rv-small" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    Approval recorded — generating final documents…
                  </motion.p>
                ) : editable ? (
                  <motion.p key="todo" className="rv-muted rv-small" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    Review the documents, confirm the time, save, then approve.
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </motion.section>

            <AmendBanner detail={detail} />
            {completed && <FilesCard sessionId={sessionId} revision={detail.approval?.bundleRevision ?? revision} />}

            <TimePanel time={bundle.documents.timeSummary} />
            <BillingPanel billing={bundle.billing} revision={bundle.bundleRevision} />
            <ChecksPanel checks={bundle.checks} revision={bundle.bundleRevision} />
            {editable && (
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
              />
            )}
            {editable && (
              <motion.section className="ds-card ds-pad-md rv-card rv-approve" aria-label="Approve" variants={itemV}>
                <ApproveButton
                  revision={bundle.bundleRevision}
                  pending={approving}
                  disabled={!canApprove}
                  describedBy={approveReason ? "rv-approve-reason" : undefined}
                  onClick={() => void onApprove()}
                />
                {approveReason && (
                  <p id="rv-approve-reason" className="rv-muted rv-small rv-approve-reason">
                    {approveReason}
                  </p>
                )}
              </motion.section>
            )}
            {detail.approval && <ApprovalRecordPanel approval={detail.approval} timezone={tz} completed={completed} />}
            <AmendCard
              detail={detail}
              onChanged={async () => {
                const d = await fetchDetail();
                if (d) setValues(initialValues(d.bundle));
              }}
            />
          </motion.aside>
        </div>
      )}
    </motion.div>
  );
}
