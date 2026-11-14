import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

export interface CelebrationProps {
  /** Burst plays each time this value changes to a new truthy value (e.g. the session id when it becomes COMPLETED). */
  trigger: string | number | boolean | null | undefined;
  /** Particle count. Default 18. */
  count?: number;
}

const COLORS = ["var(--accent)", "var(--accent-2)", "var(--success)", "var(--warning)", "#f472b6"];

/**
 * Tasteful radial burst (absolute-positioned; put inside a `position: relative` parent).
 * Decorative (aria-hidden). Reduced motion → a single soft glow fade.
 */
export function Celebration({ trigger, count = 18 }: CelebrationProps) {
  const reduce = useReducedMotion();
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (trigger) setRun((r) => r + 1);
  }, [trigger]);
  const parts = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 + (run % 2) * 0.3;
        const d = 46 + ((i * 37) % 40);
        return { x: Math.cos(a) * d, y: Math.sin(a) * d, c: COLORS[i % COLORS.length]!, s: 4 + (i % 3) * 2, r: (i * 47) % 360 };
      }),
    [count, run],
  );
  return (
    <span className="ds-burst" aria-hidden="true">
      <AnimatePresence>
        {run > 0 && (
          <motion.span key={run} className="ds-burst-inner" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.span
              className="ds-burst-ring"
              initial={{ scale: 0.2, opacity: 0.7 }}
              animate={{ scale: reduce ? 1 : 2.6, opacity: 0 }}
              transition={{ duration: reduce ? 0.6 : 0.9, ease: "easeOut" }}
            />
            {!reduce &&
              parts.map((p, i) => (
                <motion.span
                  key={i}
                  className="ds-burst-dot"
                  style={{ background: p.c, width: p.s, height: p.s * (i % 2 ? 1 : 2.2) }}
                  initial={{ x: 0, y: 0, opacity: 1, scale: 0.6, rotate: p.r }}
                  animate={{ x: p.x, y: p.y + 12, opacity: 0, scale: 1, rotate: p.r + 180 }}
                  transition={{ duration: 0.95, ease: [0.16, 1, 0.3, 1], delay: (i % 4) * 0.02 }}
                />
              ))}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
