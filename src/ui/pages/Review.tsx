import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewEdits, SessionBundle, SessionDetail } from "../../contracts";
import { api, ApiClientError } from "../api";
import { SessionHeader } from "../components/review/SessionHeader";
import { DocumentSections } from "../components/review/DocumentSections";
import { EvidencePanel } from "../components/review/EvidencePanel";
import { PlanCoverage } from "../components/review/PlanCoverage";
import { ChecksPanel } from "../components/review/ChecksPanel";
import { TimePanel } from "../components/review/TimePanel";
import { BillingPanel } from "../components/review/BillingPanel";
import { CorrectionForm, validateMinutes, type CorrectionValues } from "../components/review/CorrectionForm";
import { ApprovalRecordPanel } from "../components/review/ApprovalRecordPanel";
import { formatCents } from "../components/review/format";
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

function initialValues(bundle: SessionBundle | null): CorrectionValues {
  // Never prefill from the schedule: only an existing provider-confirmed value.
  const c = bundle?.documents.timeSummary.confirmedMinutes ?? null;
  return { progress: "", minutes: c !== null ? String(c) : "" };
}

export default function Review(props: { sessionId: string; onBack: () => void }) {
  const { sessionId } = props;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<CorrectionValues>({ progress: "", minutes: "" });
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
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
  const dirty = progressChanged || minutesChanged || minutesCleared;

  function buildEdits(): ReviewEdits | null {
    const edits: { confirmedMinutes?: number; progressConfirmation?: string } = {};
    if (minutesChanged && !validateMinutes(values.minutes)) edits.confirmedMinutes = Number(minutesTrim);
    if (progressChanged) edits.progressConfirmation = progressTrim;
    return edits.confirmedMinutes !== undefined || edits.progressConfirmation !== undefined ? (edits as ReviewEdits) : null;
  }

  async function handleConflict() {
    setError({ message: "This record changed elsewhere — reloaded. Please re-review." });
    setNotice(null);
    await fetchDetail();
  }

  async function onSave() {
    if (!bundle || saving) return;
    const edits = buildEdits();
    if (!edits) {
      setError({ message: "Nothing to save. A confirmed duration cannot be removed, only changed." });
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
        if (d && d.session.status === "COMPLETED") setNotice(`Completed — revision ${res.data.approval.bundleRevision} finalized.`);
        else void pollUntilCompleted();
      }
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiClientError && e.status === 409) await handleConflict();
      else if (e instanceof ApiClientError && e.status === 422) {
        const ue = toUiError(e);
        setError({ ...ue, message: `Approval blocked: ${ue.message}` });
        await fetchDetail();
      } else setError(toUiError(e));
    } finally {
      if (mounted.current) setApproving(false);
    }
  }

  // ----- render
  if (loading && !detail) {
    return (
      <div className="rv-page">
        <p className="muted" role="status">Loading session…</p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="rv-page">
        <button type="button" className="btn" onClick={props.onBack}>
          ← Back to sessions
        </button>
        <div className="error-box" role="alert">
          {loadError?.message ?? "Session could not be loaded."}
          {loadError?.correlationId && <div className="muted">Reference: {loadError.correlationId}</div>}
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

  return (
    <div className="rv-page">
      <div className="row">
        <button type="button" className="btn" onClick={props.onBack}>
          ← Back to sessions
        </button>
      </div>

      <SessionHeader
        appointment={detail.appointment}
        session={detail.session}
        revision={revision}
        provenance={bundle?.provenance ?? null}
        serviceDescription={bundle?.config.plan.serviceDescription}
      />

      <div aria-live="polite">
        {notice && <div className={`rv-banner ${completed ? "rv-banner-ok" : "rv-banner-info"}`}>{notice}</div>}
        {finalizing && !notice && <div className="rv-banner rv-banner-info">Approved — finalizing…</div>}
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error.message}
          {error.details && error.details.length > 0 && (
            <ul className="rv-err-details">
              {error.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {error.correlationId && <div className="muted">Reference: {error.correlationId}</div>}
        </div>
      )}
      {loadError && detail && (
        <div className="error-box" role="alert">
          Refresh failed: {loadError.message}
          {loadError.correlationId && <span className="muted"> (Reference: {loadError.correlationId})</span>}
        </div>
      )}

      {!bundle ? (
        <div className="card">
          <p>No review bundle is available for this session yet.</p>
          <button type="button" className="btn" onClick={() => void fetchDetail()}>
            Refresh
          </button>
        </div>
      ) : (
        <div className="rv-grid">
          <div className="rv-col">
            <DocumentSections
              sections={bundle.documents.sections}
              onEvidence={(id) => {
                setHighlight(id);
                setFocusTick((t) => t + 1);
              }}
            />
            <PlanCoverage entries={bundle.documents.planCoverage} />
            <ChecksPanel checks={bundle.checks} />
          </div>
          <div className="rv-col">
            <TimePanel time={bundle.documents.timeSummary} />
            <BillingPanel billing={bundle.billing} />
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
              />
            )}
            {editable && (
              <section className="card rv-approve" aria-label="Approve">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canApprove}
                  aria-describedby={approveReason ? "rv-approve-reason" : undefined}
                  onClick={() => void onApprove()}
                >
                  {approving ? "Approving…" : `Approve revision ${bundle.bundleRevision}`}
                </button>
                {approveReason && (
                  <p id="rv-approve-reason" className="muted rv-approve-reason">
                    {approveReason}
                  </p>
                )}
              </section>
            )}
            {detail.approval && (
              <ApprovalRecordPanel approval={detail.approval} timezone={tz} completed={completed} />
            )}
            <EvidencePanel evidence={bundle.evidence} timezone={tz} highlightId={highlight} focusTick={focusTick} />
          </div>
        </div>
      )}
    </div>
  );
}
