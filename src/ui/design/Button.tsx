import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import { cx } from "./cx";
import { springy } from "./motion";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type NativeButton = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration" | "onDrag" | "onDragStart" | "onDragEnd" | "onDragEnter" | "onDragLeave" | "onDragOver" | "onDrop"
>;

export interface ButtonProps extends NativeButton {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  /** Leading icon (e.g. `<RefreshCw size={16} />`). Replaced by the spinner while loading. */
  icon?: ReactNode;
  /** Trailing icon. */
  iconRight?: ReactNode;
  /** Stretch to container width. */
  block?: boolean;
  /** Square icon-only button; pass `aria-label`. */
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, iconRight, block, iconOnly, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  const isDisabled = disabled || loading;
  return (
    <motion.button
      ref={ref}
      type={type}
      className={cx("ds-btn", `ds-btn-${variant}`, `ds-btn-${size}`, block && "ds-btn-block", iconOnly && "ds-btn-icon", className)}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      whileHover={isDisabled || reduce ? undefined : { y: -1 }}
      whileTap={isDisabled || reduce ? undefined : { scale: 0.96 }}
      transition={springy}
      {...(rest as HTMLMotionProps<"button">)}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon ? <span className="ds-btn-ico" aria-hidden="true">{icon}</span> : null}
      {children != null && <span className="ds-btn-label">{children}</span>}
      {iconRight && <span className="ds-btn-ico" aria-hidden="true">{iconRight}</span>}
    </motion.button>
  );
});
