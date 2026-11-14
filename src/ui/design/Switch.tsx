import { useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import { cx } from "./cx";
import { springy } from "./motion";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (clicking it toggles). Omit and pass aria-label for icon-only usage. */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

/** role="switch" toggle. Space / Enter toggle (native button semantics). */
export function Switch({ checked, onChange, label, description, disabled, id, className, ...aria }: SwitchProps) {
  const auto = useId();
  const sid = id ?? `sw${auto}`;
  const descId = description ? `${sid}-desc` : undefined;
  const btn = (
    <button
      type="button"
      id={sid}
      role="switch"
      aria-checked={checked}
      aria-label={aria["aria-label"]}
      aria-describedby={descId}
      disabled={disabled}
      className={cx("ds-switch", checked && "ds-switch-on")}
      onClick={() => onChange(!checked)}
    >
      <motion.span className="ds-switch-thumb" layout transition={springy} />
    </button>
  );
  if (!label && !description) return <span className={className}>{btn}</span>;
  return (
    <div className={cx("ds-switch-row", disabled && "ds-disabled", className)}>
      <span className="ds-switch-text">
        {label && (
          <label htmlFor={sid} className="ds-switch-label">
            {label}
          </label>
        )}
        {description && (
          <span id={descId} className="ds-switch-desc">
            {description}
          </span>
        )}
      </span>
      {btn}
    </div>
  );
}
