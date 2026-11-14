import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { cx } from "./cx";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions (buttons). Wraps under the title on small screens. */
  actions?: ReactNode;
  /** Small label above the title. */
  eyebrow?: ReactNode;
  /** Renders a "Back" button before the title. */
  onBack?: () => void;
  backLabel?: string;
  className?: string;
}

/** Page title block. Renders the page's <h1>. */
export function PageHeader({ title, subtitle, actions, eyebrow, onBack, backLabel = "Back", className }: PageHeaderProps) {
  const reduce = useReducedMotion();
  return (
    <header className={cx("ds-pagehead", className)}>
      <motion.div
        className="ds-pagehead-text"
        initial={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        {onBack && (
          <button type="button" className="ds-back" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" /> {backLabel}
          </button>
        )}
        {eyebrow && <div className="ds-eyebrow">{eyebrow}</div>}
        <h1 className="ds-pagehead-title">{title}</h1>
        {subtitle && <p className="ds-pagehead-sub">{subtitle}</p>}
      </motion.div>
      {actions && <div className="ds-pagehead-actions">{actions}</div>}
    </header>
  );
}
