import { cx } from "./cx";

/** Inline spinner (CSS animation; static ring under prefers-reduced-motion). Decorative unless `label` is set. */
export function Spinner({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      className={cx("ds-spinner", className)}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
