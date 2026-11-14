import { useEffect, useMemo, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Hourglass, Minus, X } from "lucide-react";
import type { RunDetail } from "../../../contracts";
import { pipelineView, type NodeState, type NodeView } from "./model";

const STATE_TEXT: Record<NodeState, string> = {
  pending: "not reached",
  done: "done",
  passed: "passed",
  active: "in progress",
  waiting: "waiting",
  failed: "failed",
  skipped: "skipped",
};

function NodeGlyph({ state }: { state: NodeState }) {
  if (state === "done" || state === "passed") return <Check size={14} strokeWidth={3} />;
  if (state === "failed") return <X size={14} strokeWidth={3} />;
  if (state === "waiting") return <Hourglass size={13} />;
  if (state === "skipped") return <Minus size={14} />;
  if (state === "active") return <span className="rn-node-spin" />;
  return <span className="rn-node-dot" />;
}

const lit = (s: NodeState) => s !== "pending";

/** Horizontal animated stage graph. Nodes light up in sequence; the active connector "flows". */
export function PipelineGraph(props: { detail: Pick<RunDetail, "summary" | "events">; compact?: boolean }) {
  const reduce = useReducedMotion();
  const nodes: NodeView[] = useMemo(() => pipelineView(props.detail), [props.detail]);
  const scroller = useRef<HTMLDivElement>(null);
  const focusIdx = useMemo(() => {
    const i = nodes.findIndex((n) => n.state === "active" || n.state === "waiting" || n.state === "failed");
    if (i >= 0) return i;
    let last = 0;
    nodes.forEach((n, j) => {
      if (lit(n.state)) last = j;
    });
    return last;
  }, [nodes]);

  // Keep the interesting node in view inside the horizontal scroller.
  useEffect(() => {
    const el = scroller.current;
    const node = el?.querySelectorAll<HTMLElement>(".rn-node")[focusIdx];
    if (!el || !node) return;
    const target = node.offsetLeft - el.clientWidth / 2 + node.offsetWidth / 2;
    el.scrollTo({ left: Math.max(0, target), behavior: reduce ? "auto" : "smooth" });
  }, [focusIdx, reduce]);

  const failed = nodes.find((n) => n.state === "failed");

  return (
    <div className={`rn-graph${props.compact ? " is-compact" : ""}`}>
      <div className="rn-graph-scroll" ref={scroller} tabIndex={0} aria-label="Run stages (scrollable)">
        <ol className="rn-graph-track">
          {nodes.map((n, i) => {
            const next = nodes[i + 1];
            const connLit = next ? lit(next.state) : false;
            const connFlow = next ? next.state === "active" : false;
            const delay = reduce ? 0 : i * 0.06;
            return (
              <li key={n.key} className={`rn-node rn-node-${n.state}`}>
                <div className="rn-node-col">
                  <motion.span
                    className="rn-node-ball"
                    initial={reduce ? false : { scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay, type: "spring", stiffness: 420, damping: 24 }}
                    aria-hidden="true"
                  >
                    {n.state === "active" && <span className="rn-node-halo" />}
                    <NodeGlyph state={n.state} />
                  </motion.span>
                  <span className="rn-node-label">
                    {n.label}
                    <span className="sr-only">: {STATE_TEXT[n.state]}</span>
                  </span>
                </div>
                {next && (
                  <span className={`rn-conn${connLit ? " is-lit" : ""}${connFlow ? " is-flow" : ""}`} aria-hidden="true">
                    <motion.span
                      className="rn-conn-fill"
                      initial={reduce ? false : { scaleX: 0 }}
                      animate={{ scaleX: connLit ? 1 : 0 }}
                      transition={{ delay: delay + 0.08, duration: reduce ? 0 : 0.35, ease: "easeOut" }}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {failed && (
        <motion.p
          className="rn-graph-fail"
          role="status"
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <X size={14} aria-hidden="true" />
          <span>
            <strong>{failed.label} failed</strong>
            {failed.note ? ` — ${failed.note}` : ""}
          </span>
        </motion.p>
      )}
    </div>
  );
}
