import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Check, RotateCcw } from "lucide-react";
import { Button } from "../../design";
import { ApiClientError } from "../../api";

/** Server validation messages (400/422) are shown inline; others too, with the code for support. */
export function inlineError(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiClientError) {
    if (err.status === 400 || err.status === 422) return err.message;
    return `${err.message}${err.correlationId ? ` (ref ${err.correlationId})` : ""}`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  error: unknown;
  invalid?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  label?: string;
}

/** Floating save bar that slides up while a tab has unsaved changes. */
export function SaveBar({ dirty, saving, error, invalid, onSave, onDiscard, label = "Save changes" }: SaveBarProps) {
  const reduce = useReducedMotion();
  const msg = inlineError(error);
  return (
    <div className="u2-savebar-slot">
      <AnimatePresence initial={false}>
        {msg && (
          <motion.div
            key="err"
            className="u2-inline-error"
            role="alert"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <AlertCircle size={16} aria-hidden="true" />
            <span>{msg}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {dirty && (
          <motion.div
            key="bar"
            className="u2-savebar"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <span className="u2-savebar-dot" aria-hidden="true" />
            <span className="u2-savebar-text">Unsaved changes</span>
            <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
            <Button variant="primary" size="sm" icon={<Check size={14} />} loading={saving} disabled={invalid} onClick={onSave}>
              {label}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
