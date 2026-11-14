import type { Transition, Variants } from "framer-motion";

/** Springy transition for hover/press/layout micro-interactions. */
export const springy: Transition = { type: "spring", stiffness: 420, damping: 30, mass: 0.7 };
/** Softer spring for larger surfaces (cards, dialogs). */
export const softSpring: Transition = { type: "spring", stiffness: 260, damping: 28 };

/** Fade + rise. Use as `variants={fadeUp} initial="hidden" animate="show"` (or inside a `stagger` parent). */
export const fadeUp: Variants = {
  // No filter: blur() here. Animating a filter repaints the element every frame, and this
  // variant runs on every card of a staggered list at once.
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 30 } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.15 } },
};

/** Parent variants that stagger children using `fadeUp` (or any variants with hidden/show). */
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

/**
 * Route-level enter transition for <motion.div variants={pageTransition} initial="initial" animate="enter">.
 * Short tween, transform + opacity only (a whole-page blur filter repainted the page every frame).
 */
export const pageTransition: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
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
