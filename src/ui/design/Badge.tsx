import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "fixture";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: ReactNode;
  /** Small coloured dot before the label. */
  dot?: boolean;
}

export function Badge({ tone = "neutral", icon, dot, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("ds-badge", `ds-tone-${tone}`, className)} {...rest}>
      {dot && <span className="ds-badge-dot" aria-hidden="true" />}
      {icon && <span className="ds-badge-ico" aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}
