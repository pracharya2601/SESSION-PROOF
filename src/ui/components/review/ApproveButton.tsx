import { AnimatePresence, motion } from "framer-motion";
import { BadgeCheck } from "lucide-react";
import { rvSpring, useMotionOK } from "./motion";

/** Approve CTA: shimmer when ready, a circular progress ring while the request is pending. */
export function ApproveButton(props: {
  revision: number;
  pending: boolean;
  disabled: boolean;
  describedBy?: string;
  onClick: () => void;
}) {
  const ok = useMotionOK();
  const ready = !props.disabled && !props.pending;
  return (
    <motion.button
      type="button"
      className={`rv-approve-btn${ready ? " is-ready" : ""}${props.pending ? " is-pending" : ""}`}
      disabled={props.disabled || props.pending}
      aria-busy={props.pending || undefined}
      aria-describedby={props.describedBy}
      onClick={props.onClick}
      whileHover={ready && ok ? { y: -2, scale: 1.01 } : undefined}
      whileTap={ready && ok ? { scale: 0.97 } : undefined}
      transition={rvSpring}
    >
      <span className="rv-approve-ico" aria-hidden="true">
        <AnimatePresence mode="wait" initial={false}>
          {props.pending ? (
            <motion.svg
              key="ring"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, rotate: ok ? 360 : 0 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ rotate: { repeat: Infinity, duration: 1.1, ease: "linear" }, default: rvSpring }}
            >
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <motion.circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                initial={{ pathLength: 0.1 }}
                animate={ok ? { pathLength: [0.1, 0.75, 0.1] } : { pathLength: 0.3 }}
                transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
              />
            </motion.svg>
          ) : (
            <motion.span
              key="icon"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={rvSpring}
              style={{ display: "inline-flex" }}
            >
              <BadgeCheck size={22} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className="rv-approve-label">{props.pending ? "Approving…" : `Approve revision ${props.revision}`}</span>
    </motion.button>
  );
}
