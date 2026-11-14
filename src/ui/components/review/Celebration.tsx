import { useMemo } from "react";
import { motion } from "framer-motion";
import { useMotionOK } from "./motion";

const COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#60a5fa"];

/**
 * Decorative confetti burst + ring pulse for the completion moment.
 * Purely visual (aria-hidden); renders nothing under prefers-reduced-motion.
 */
export function Celebration(props: { burstKey: number }) {
  const ok = useMotionOK();
  const pieces = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => {
        const angle = (i / 36) * Math.PI * 2 + Math.random() * 0.3;
        const dist = 120 + Math.random() * 160;
        return {
          id: i,
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist - 60,
          rot: Math.random() * 720 - 360,
          color: COLORS[i % COLORS.length]!,
          w: 6 + Math.random() * 6,
          h: 8 + Math.random() * 8,
          delay: Math.random() * 0.12,
          round: i % 3 === 0,
        };
      }),
    // regenerate per burst
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.burstKey],
  );
  if (!ok || props.burstKey === 0) return null;
  return (
    <div className="rv-celebrate" aria-hidden="true" key={props.burstKey}>
      <motion.span
        className="rv-celebrate-ring"
        initial={{ scale: 0.2, opacity: 0.9 }}
        animate={{ scale: 3.2, opacity: 0 }}
        transition={{ duration: 1.1, ease: "easeOut" }}
      />
      <motion.span
        className="rv-celebrate-ring rv-celebrate-ring-2"
        initial={{ scale: 0.2, opacity: 0.7 }}
        animate={{ scale: 2.4, opacity: 0 }}
        transition={{ duration: 1.3, ease: "easeOut", delay: 0.15 }}
      />
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          className="rv-confetti"
          style={{ background: p.color, width: p.w, height: p.h, borderRadius: p.round ? "50%" : 2 }}
          initial={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 0.4 }}
          animate={{ x: p.x, y: [0, p.y, p.y + 140], rotate: p.rot, opacity: [1, 1, 0], scale: 1 }}
          transition={{ duration: 1.6, delay: p.delay, ease: [0.16, 0.84, 0.44, 1] }}
        />
      ))}
    </div>
  );
}
