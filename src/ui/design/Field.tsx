import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cx } from "./cx";

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control (linked via aria-describedby). */
  hint?: ReactNode;
  /** Error text; also marks the child control aria-invalid. */
  error?: ReactNode;
  required?: boolean;
  /** Optional explicit id for the control; otherwise generated. */
  id?: string;
  className?: string;
  /** A single control element (Input / Textarea / Select / native). It receives id, aria-describedby, aria-invalid. */
  children: ReactElement;
}

export function Field({ label, hint, error, required, id, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? (children.props as { id?: string }).id ?? `f${auto}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: controlId,
        "aria-describedby": describedBy,
        ...(error ? { invalid: true, "aria-invalid": true } : {}),
        ...(required ? { required: true } : {}),
      })
    : children;
  return (
    <div className={cx("ds-field", error ? "ds-field-error" : undefined, className)}>
      <label className="ds-field-label" htmlFor={controlId}>
        {label}
        {required && <span className="ds-field-req" aria-hidden="true"> *</span>}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="ds-field-hint">
          {hint}
        </p>
      )}
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            key="err"
            id={errorId}
            className="ds-field-err"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
