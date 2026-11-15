import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { ApiClientError } from "../../api";
import { Button, Dialog, ErrorNotice } from "../../design";
import "./recordings.css";

export interface ConfirmDeleteProps {
  open: boolean;
  onClose: () => void;
  /** e.g. "Delete recording?" */
  title: string;
  /** Item summary rows shown at the top. */
  summary: { label: string; value: ReactNode }[];
  /** What happens (bullets). */
  notes: ReactNode[];
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  /** Offered when the server answers 409 ARCHIVE_ONLY. */
  onArchiveInstead?: () => Promise<void>;
}

/** Permanent delete confirmation (design-system Dialog) with the item summary. */
export function ConfirmDelete({ open, onClose, title, summary, notes, confirmLabel = "Delete permanently", onConfirm, onArchiveInstead }: ConfirmDeleteProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const archiveOnly = error instanceof ApiClientError && error.code === "ARCHIVE_ONLY";

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setBusy(false);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(e);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description="This cannot be undone."
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          {archiveOnly && onArchiveInstead ? (
            <Button variant="primary" loading={busy} onClick={() => void run(onArchiveInstead)}>
              Archive instead
            </Button>
          ) : (
            <Button variant="danger" icon={<Trash2 size={14} />} loading={busy} onClick={() => void run(onConfirm)}>
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <dl className="rc-summary">
        {summary.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      <ul className="rc-notes">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      {error !== null && (
        <div style={{ marginTop: "var(--sp-4)" }}>
          <ErrorNotice error={error} title={archiveOnly ? "Archive only" : "Could not delete"} />
        </div>
      )}
    </Dialog>
  );
}
