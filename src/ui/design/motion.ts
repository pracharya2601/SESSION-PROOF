import type { Transition, Variants } from "framer-motion";

/** Springy transition for hover/press/layout micro-interactions. */
export const springy: Transition = { type: "spring", stiffness: 420, damping: 30, mass: 0.7 };
/** Softer spring for larger surfaces (cards, dialogs). */
export const softSpring: Transition = { type: "spring", stiffness: 260, damping: 28 };

/** Fade + rise. Use as `variants={fadeUp} initial="hidden" animate="show"` (or inside a `stagger` parent). */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { type: "spring", stiffness: 300, damping: 30 } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.15 } },
};

/** Parent variants that stagger children using `fadeUp` (or any variants with hidden/show). */
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

/** Route-level transition for <motion.div variants={pageTransition} initial="initial" animate="enter" exit="exit">. */
export const pageTransition: Variants = {
  initial: { opacity: 0, y: 14, scale: 0.995, filter: "blur(6px)" },
  enter: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { type: "spring", stiffness: 260, damping: 30, mass: 0.8 },
  },
  exit: { opacity: 0, y: -8, filter: "blur(4px)", transition: { duration: 0.16, ease: "easeIn" } },
};

/** Reduced-motion equivalents: opacity only. */
export const fadeOnly: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.15 } },
};

/** Hover/tap props for interactive surfaces: `<motion.button {...pressable}>`. */
export const pressable = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.97 },
  transition: springy,
} as const;
