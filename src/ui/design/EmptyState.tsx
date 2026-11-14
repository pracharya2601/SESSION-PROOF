import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cx } from "./cx";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons / links. */
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={cx("ds-empty", compact && "ds-empty-compact", className)}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
    >
      {icon && (
        <div className="ds-empty-icon" aria-hidden="true">
          <span className="ds-empty-halo" />
          {icon}
        </div>
      )}
      <h3 className="ds-empty-title">{title}</h3>
      {description && <p className="ds-empty-desc">{description}</p>}
      {action && <div className="ds-empty-action">{action}</div>}
    </motion.div>
  );
}
