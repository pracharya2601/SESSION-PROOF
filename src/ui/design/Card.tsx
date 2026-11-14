import { forwardRef, type HTMLAttributes } from "react";
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
  return (
    <Comp
      ref={ref}
      className={cx("ds-card", `ds-pad-${padding}`, interactive && "ds-card-interactive", glow && "ds-card-glow", className)}
      whileHover={interactive && !reduce ? { y: -3 } : undefined}
      whileTap={interactive && !reduce ? { scale: 0.99 } : undefined}
      transition={softSpring}
      onPointerMove={(e) => {
        if (interactive) {
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
          e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
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
