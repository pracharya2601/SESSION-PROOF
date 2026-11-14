/**
 * Amend + revision history + dev reset for the Review page.
 *
 * - COMPLETED: "Amend this session" reopens it as a new revision (reason required).
 *   The approved revision is kept as an audit record and the new one must be re-approved.
 * - NEEDS_REVIEW after an amendment: a banner explains what's happening.
 * - Lists previously approved revisions replaced by amendments.
 * - Dev runtime only: "Reset demo session" returns the synthetic session to a fresh draft.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FilePenLine, History, RotateCcw } from "lucide-react";
import type { SessionDetail, SupersededRevision } from "../../../contracts";
import { api, ApiClientError } from "../../api";
import { Button, Dialog, Field, Textarea, useToast } from "../../design";
import { formatCents } from "./format";

function errText(e: unknown): string {
  if (e instanceof ApiClientError) return `${e.message}${e.correlationId ? ` (ref ${e.correlationId})` : ""}`;
  return "Something went wrong. Please try again.";
}

function when(iso: string, tz: string): string {
  return new Date(iso).toLocaleString(undefined, { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
}

export function AmendBanner(props: { detail: SessionDetail }) {
  const { detail } = props;
  const amendment = detail.bundle?.attestations.slice().reverse().find((a) => a.field === "amendment_reason");
  if (!amendment || detail.session.status !== "NEEDS_REVIEW") return null;
  return (
    <motion.div
      className="ds-card ds-pad-md rv-card"
      role="status"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ borderColor: "var(--warning, #d97706)", display: "flex", gap: 12, alignItems: "flex-start" }}
    >
      <FilePenLine size={20} aria-hidden style={{ flex: "none", color: "var(--warning, #d97706)", marginTop: 2 }} />
      <div>
        <p style={{ margin: 0, fontWeight: 600 }}>Amending an approved session</p>
        <p className="rv-muted rv-small" style={{ margin: "4px 0 0" }}>
          Reason: “{amendment.text}”. Make your changes, save, then approve again. The previously approved revision is kept
          in the audit history; its files are replaced when this revision is approved.
        </p>
      </div>
    </motion.div>
  );
}

export function AmendCard(props: { detail: SessionDetail; onChanged: () => Promise<unknown> }) {
  const { detail, onChanged } = props;
  const toast = useToast();
  const sessionId = detail.session.id;
  const tz = detail.appointment.timezone;
  const completed = detail.session.status === "COMPLETED";
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<SupersededRevision[]>([]);
  const [devMode, setDevMode] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    let live = true;
    api.listRevisions(sessionId).then((r) => live && setRevisions(r)).catch(() => undefined);
    api
      .health()
      .then((h) => live && setDevMode(h.authMode === "dev" && h.runtimeMode === "local"))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sessionId, detail.session.currentBundleRevision, detail.session.status]);

  async function submitAmend() {
    const r = reason.trim();
    if (r.length < 3) {
      setErr("Please give a short reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const b = await api.amendSession(sessionId, { expectedRevision: detail.session.currentBundleRevision, reason: r });
      setOpen(false);
      setReason("");
      toast.success("Session reopened", `Now editing revision ${b.bundleRevision}. Approve again when you're done.`);
      await onChanged();
    } catch (e) {
      setErr(errText(e));
      if (e instanceof ApiClientError && e.status === 409) await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    setBusy(true);
    try {
      await api.devResetSession(sessionId);
      await api.sync();
      setResetOpen(false);
      toast.success("Demo session reset", "Re-processing now — it will be back in “Needs review” in a few seconds.");
      // Give the queue + workflow a moment, then reload.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const d = await api.getSession(sessionId).catch(() => null);
        if (d && d.session.status === "NEEDS_REVIEW") break;
      }
      await onChanged();
    } catch (e) {
      toast.error("Reset failed", errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!completed && revisions.length === 0 && !devMode) return null;

  return (
    <section className="ds-card ds-pad-md rv-card" aria-label="Amend and revision history">
      {completed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Need to change something?</p>
          <p className="rv-muted rv-small" style={{ margin: 0 }}>
            Approved revisions are locked. Amending reopens this session as a new revision that you edit and approve again —
            the current approval stays in the audit history.
          </p>
          <div>
            <Button variant="secondary" icon={<FilePenLine size={16} />} onClick={() => setOpen(true)}>
              Amend this session
            </Button>
          </div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {revisions.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} style={{ marginTop: completed ? 16 : 0 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <History size={16} aria-hidden /> Earlier approved revisions
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {revisions.map((r) => (
                <li key={r.bundleRevision} className="rv-small" style={{ borderLeft: "2px solid var(--border, #333)", paddingLeft: 10 }}>
                  <strong>Revision {r.bundleRevision}</strong> · {r.amountCents != null ? formatCents(r.amountCents) : "no amount"} · approved{" "}
                  {when(r.finalizedAt, tz)}
                  <br />
                  <span className="rv-muted">
                    Replaced by r{r.supersededByRevision} on {when(r.supersededAt, tz)} — “{r.reason}”
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {devMode && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px dashed var(--border, #333)" }}>
          <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => setResetOpen(true)}>
            Reset demo session (dev)
          </Button>
        </div>
      )}

      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Amend this session"
        description={`Revision ${detail.session.currentBundleRevision} stays in the audit history. A new revision opens for editing and must be approved again.`}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void submitAmend()}>
              Reopen for editing
            </Button>
          </>
        }
      >
        <Field label="Reason for the amendment" hint="Shown on the amended documents and kept in the audit trail." error={err ?? undefined} required>
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Visit actually ran 75 minutes" />
        </Field>
      </Dialog>

      <Dialog
        open={resetOpen}
        onClose={() => !busy && setResetOpen(false)}
        title="Reset demo session?"
        description="Dev only. Deletes this synthetic session's drafts, approvals, files and history, then re-processes it from scratch."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void submitReset()}>
              Reset
            </Button>
          </>
        }
      >
        <p className="rv-muted rv-small" style={{ margin: 0 }}>
          Use this to try the review → approve flow again with the demo data.
        </p>
      </Dialog>
    </section>
  );
}
