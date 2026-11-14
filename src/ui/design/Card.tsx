import { forwardRef, useRef, type HTMLAttributes } from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import { cx } from "./cx";
import { softSpring } from "./motion";

type NativeDiv = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration" | "onDrag" | "onDragStart" | "onDragEnd"
>;

export interface CardProps extends NativeDiv {
  /** Lifts on hover / presses on tap and shows a pointer-tracking highlight. */
  interactive?: boolean;
  /** Adds an animated gradient border glow (use for hero / highlighted cards). */
  glow?: boolean;
  /** Padding preset. Default "md". */
  padding?: "none" | "sm" | "md" | "lg";
  /** Render as a different element (section, article, li…). */
  as?: "div" | "section" | "article" | "li" | "aside";
  /** Pass-through framer-motion props (variants, layout, layoutId…). */
  motionProps?: HTMLMotionProps<"div">;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, glow, padding = "md", as = "div", className, motionProps, onPointerMove, children, ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  const Comp = motion[as] as typeof motion.div;
  // Pointer highlight: at most one rect read + style write per frame (pointermove fires far
  // more often than frames, and each getBoundingClientRect after a style write forces layout).
  const pending = useRef<{ el: HTMLElement; x: number; y: number } | null>(null);
  const frame = useRef(0);
  return (
    <Comp
      ref={ref}
      className={cx("ds-card", `ds-pad-${padding}`, interactive && "ds-card-interactive", glow && "ds-card-glow", className)}
      whileHover={interactive && !reduce ? { y: -3 } : undefined}
      whileTap={interactive && !reduce ? { scale: 0.99 } : undefined}
      transition={softSpring}
      onPointerMove={(e) => {
        if (interactive && !reduce) {
          pending.current = { el: e.currentTarget, x: e.clientX, y: e.clientY };
          if (!frame.current) {
            frame.current = window.requestAnimationFrame(() => {
              frame.current = 0;
              const p = pending.current;
              if (!p) return;
              const r = p.el.getBoundingClientRect();
              p.el.style.setProperty("--mx", `${p.x - r.left}px`);
              p.el.style.setProperty("--my", `${p.y - r.top}px`);
            });
          }
        }
        onPointerMove?.(e);
      }}
      {...(rest as HTMLMotionProps<"div">)}
      {...motionProps}
    >
      {children}
    </Comp>
  );
});
