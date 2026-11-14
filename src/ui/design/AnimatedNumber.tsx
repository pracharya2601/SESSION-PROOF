import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { cx } from "./cx";

export type NumberFormat = "cents" | "integer" | "minutes" | ((n: number) => string);

export interface AnimatedNumberProps {
  value: number;
  /** "cents" → $1,234.56 from integer cents; "minutes" → "1h 05m"; "integer" → 1,234; or a custom formatter. */
  format?: NumberFormat;
  /** Seconds. Default 0.9. */
  duration?: number;
  className?: string;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatNumber(n: number, format: NumberFormat = "integer"): string {
  if (typeof format === "function") return format(n);
  if (format === "cents") return usd.format(Math.round(n) / 100);
  if (format === "minutes") {
    const m = Math.round(n);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  }
  return int.format(Math.round(n));
}

/**
 * Counts from the previous value to `value` (ease-out), writing straight to the DOM (no re-renders).
 * Screen readers get the final value only. Reduced motion → jumps instantly.
 */
export function AnimatedNumber({ value, format = "integer", duration = 0.9, className }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const reduce = useReducedMotion();
  const final = formatNumber(value, format);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce || !Number.isFinite(value)) {
      el.textContent = formatNumber(value, format);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = formatNumber(v, format);
      },
    });
    from.current = value;
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce, duration]);

  return (
    <span className={cx("ds-num", className)}>
      <span className="sr-only">{final}</span>
      <span ref={ref} aria-hidden="true">
        {reduce ? final : formatNumber(0, format)}
      </span>
    </span>
  );
}
