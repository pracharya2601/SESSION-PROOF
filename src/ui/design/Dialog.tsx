import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cx } from "./cx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row (buttons), right-aligned. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Prevent closing via Esc / backdrop (e.g. while submitting). */
  dismissible?: boolean;
  /** Element to focus first; defaults to the first focusable inside the dialog. */
  initialFocusRef?: RefObject<HTMLElement>;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Modal dialog: portal, focus trap, Esc to close, focus restore, body scroll lock. */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", dismissible = true, initialFocusRef }: DialogProps) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => {
      const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
      target?.focus();
    }, 20);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [open, initialFocusRef]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="ds-dialog-root">
          <motion.div
            className="ds-dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => dismissible && onClose()}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={cx("ds-dialog", `ds-dialog-${size}`)}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 16 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={reduce ? { duration: 0.12 } : { type: "spring", stiffness: 380, damping: 30 }}
          >
            <div className="ds-dialog-head">
              <div>
                <h2 id={titleId} className="ds-dialog-title">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="ds-dialog-desc">
                    {description}
                  </p>
                )}
              </div>
              {dismissible && (
                <button type="button" className="ds-btn ds-btn-ghost ds-btn-sm ds-btn-icon" aria-label="Close dialog" onClick={onClose}>
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            {children != null && <div className="ds-dialog-body">{children}</div>}
            {footer && <div className="ds-dialog-foot">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
