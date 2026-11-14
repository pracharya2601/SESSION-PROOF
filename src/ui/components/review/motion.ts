import { useReducedMotion, type Variants } from "framer-motion";

/** True when the user has NOT asked for reduced motion. */
export function useMotionOK(): boolean {
  return !useReducedMotion();
}

/** Staggered section reveal for the review page. Children use `rvItem`. */
export const rvStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

export const rvItem: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985, filter: "blur(6px)" },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { type: "spring", stiffness: 260, damping: 28, mass: 0.8 },
  },
};

export const rvItemReduced: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.15 } },
};

export const rvSpring = { type: "spring", stiffness: 420, damping: 32, mass: 0.7 } as const;
