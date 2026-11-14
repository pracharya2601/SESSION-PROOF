import { AnimatePresence, motion } from "framer-motion";
import { GitCommitHorizontal } from "lucide-react";
import { useMotionOK } from "./motion";

/** Revision badge that flips (3D) when the server returns a new revision. */
export function RevisionBadge(props: { revision: number }) {
  const ok = useMotionOK();
  return (
    <span className="rv-rev">
      <GitCommitHorizontal size={14} aria-hidden="true" />
      <span className="rv-rev-flip">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={props.revision}
            className="rv-rev-num"
            initial={ok ? { rotateX: -90, opacity: 0, y: 6 } : { opacity: 0 }}
            animate={{ rotateX: 0, opacity: 1, y: 0 }}
            exit={ok ? { rotateX: 90, opacity: 0, y: -6 } : { opacity: 0 }}
            transition={ok ? { type: "spring", stiffness: 300, damping: 22 } : { duration: 0.1 }}
          >
            Revision {props.revision}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}
