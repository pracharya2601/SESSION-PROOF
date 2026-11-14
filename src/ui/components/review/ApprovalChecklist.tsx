/**
 * "What do I need to do to approve?" — shown at the top of the review rail.
 * Lists the server's blocking checks with a Fix button that jumps to the right
 * field, then Save (when there are unsaved edits), then Approve — all in one place.
 * The server stays authoritative: blockers come from bundle.checks, and they only
 * clear after Save returns a recalculated revision.
 */
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, ArrowRight, CheckCircle2, Save } from "lucide-react";
import type { SessionBundle } from "../../../contracts";
import { Button } from "../../design";
import { ApproveButton } from "./ApproveButton";

/** Where each required field is fixed in the correction form. */
const FIX_TARGET: Record<string, { id: string; action: string }> = {
  progress_statement: { id: "rv-progress", action: "Write a progress statement" },
  confirmed_duration: { id: "rv-minutes", action: "Enter the actual minutes" },
  goal_addressed: { id: "rv-goals", action: "Confirm which plan goals were addressed" },
  service_description: { id: "rv-summary", action: "Write an activity summary" },
};

export function jumpTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  // Focus first (so typing goes straight into the field), then bring it into view.
  (el as HTMLElement).focus({ preventScroll: true });
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function ApprovalChecklist(props: {
  bundle: SessionBundle;
  dirty: boolean;
  saving: boolean;
  approving: boolean;
  canApprove: boolean;
  approveReason: string | null;
  onSave: () => void;
  onApprove: () => void;
}) {
  const { bundle, dirty, saving, approving, canApprove, approveReason, onSave, onApprove } = props;
  const blocking = bundle.checks.issues.filter((i) => i.blocking);
  const ready = blocking.length === 0;

  return (
    <div className="rv-checklist" style={{ display: "grid", gap: 12, marginTop: 4 }}>
      <p className="rv-small" style={{ margin: 0, fontWeight: 600 }}>
        {ready
          ? dirty
            ? "Save your changes, then approve."
            : "Everything required is in place — approve this revision."
          : `To approve, fix ${blocking.length} required item${blocking.length === 1 ? "" : "s"}${dirty ? " and save" : ""}:`}
      </p>

      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        <AnimatePresence initial={false}>
          {blocking.map((issue) => {
            const target = FIX_TARGET[issue.field];
            return (
              <motion.li
                key={issue.code}
                layout
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, height: 0 }}
                style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
              >
                <AlertCircle size={16} aria-hidden style={{ flex: "none", marginTop: 2, color: "var(--danger, #ef4444)" }} />
                <span className="rv-small" style={{ flex: 1 }}>
                  {target?.action ?? issue.message}
                  {target && <span className="rv-muted"> — {issue.message}</span>}
                </span>
                {target && (
                  <Button size="sm" variant="secondary" iconRight={<ArrowRight size={14} />} onClick={() => jumpTo(target.id)}>
                    Fix
                  </Button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
        {ready && !dirty && (
          <li style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CheckCircle2 size={16} aria-hidden style={{ color: "var(--success, #22c55e)" }} />
            <span className="rv-small">All required documentation checks pass.</span>
          </li>
        )}
      </ol>

      {dirty && (
        <Button variant="secondary" icon={<Save size={16} />} loading={saving} onClick={onSave}>
          Save changes{ready ? "" : " to re-check"}
        </Button>
      )}

      <ApproveButton
        revision={bundle.bundleRevision}
        pending={approving}
        disabled={!canApprove}
        describedBy={approveReason ? "rv-checklist-reason" : undefined}
        onClick={onApprove}
      />
      {approveReason && !canApprove && (
        <p id="rv-checklist-reason" className="rv-muted rv-small" style={{ margin: 0 }}>
          {dirty ? "Unsaved changes aren't approvable — save first so the server recalculates." : approveReason}
        </p>
      )}
    </div>
  );
}
