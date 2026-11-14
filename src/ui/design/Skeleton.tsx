import type { CSSProperties } from "react";
import { cx } from "./cx";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  /** Render N text lines (last one shorter). */
  lines?: number;
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Shimmering placeholder (shimmer disabled under reduced motion). Decorative: wrap regions with aria-busy. */
export function Skeleton({ width, height = 14, radius, lines, circle, className, style }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span className={cx("ds-skel-lines", className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="ds-skel" style={{ height, width: i === lines - 1 ? "62%" : "100%", borderRadius: radius }} />
        ))}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx("ds-skel", className)}
      style={{ width: width ?? "100%", height: circle ? width : height, borderRadius: circle ? "999px" : radius, ...style }}
    />
  );
}
