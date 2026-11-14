import { useId } from "react";
import { motion, useReducedMotion } from "framer-motion";

/** Brand mark: gradient tile with an animated stroke. */
export function Logo({ size = 30 }: { size?: number }) {
  const reduce = useReducedMotion();
  const gid = `vxg${useId().replace(/:/g, "")}`;
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8d7dff" />
            <stop offset="0.55" stopColor="#5b8cff" />
            <stop offset="1" stopColor="#2fc6e8" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${gid})`} />
        <motion.path
          d="M9 10.5 L16 22 L23 10.5"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        />
      </svg>
    </span>
  );
}
