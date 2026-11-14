import { useEffect, useRef } from "react";
import { motion, useAnimationControls } from "framer-motion";
import { Quote } from "lucide-react";
import type { EvidenceItem } from "../../../contracts";
import { formatInstant } from "./format";
import { Section } from "./Section";
import { useMotionOK } from "./motion";

function EvidenceRow(props: {
  item: EvidenceItem;
  timezone: string;
  active: boolean;
  focusTick: number;
  register: (id: string, el: HTMLLIElement | null) => void;
}) {
  const e = props.item;
  const controls = useAnimationControls();
  const ok = useMotionOK();

  useEffect(() => {
    if (!props.active || props.focusTick === 0) return;
    if (!ok) return;
    void controls.start({
      boxShadow: [
        "0 0 0 0px rgba(124, 92, 255, 0)",
        "0 0 0 6px rgba(124, 92, 255, 0.45)",
        "0 0 28px 4px rgba(124, 92, 255, 0.35)",
        "0 0 0 2px rgba(124, 92, 255, 0.55)",
      ],
      scale: [1, 1.015, 1],
      transition: { duration: 1.1, ease: "easeOut", delay: 0.25 },
    });
  }, [props.active, props.focusTick, ok, controls]);

  return (
    <motion.li
      tabIndex={-1}
      ref={(el) => props.register(e.id, el)}
      animate={controls}
      className={`rv-ev-item${props.active ? " rv-ev-active" : ""}`}
      aria-current={props.active ? "true" : undefined}
    >
      <div className="rv-ev-meta">
        <code className="rv-ev-id">{e.id}</code>
        <span>{e.speaker ?? <em className="rv-muted">speaker not recorded</em>}</span>
        <span>
          {e.observedFrom ? formatInstant(e.observedFrom, props.timezone, false) : <em className="rv-muted">time not recorded</em>}
        </span>
        <span className="rv-chip rv-mode">{e.sourceMode}</span>
      </div>
      <blockquote className="rv-excerpt">{e.excerpt}</blockquote>
    </motion.li>
  );
}

export function EvidencePanel(props: { evidence: EvidenceItem[]; timezone: string; highlightId: string | null; focusTick: number }) {
  const refs = useRef(new Map<string, HTMLLIElement>());
  const ok = useMotionOK();

  useEffect(() => {
    if (!props.highlightId) return;
    const el = refs.current.get(props.highlightId);
    if (el) {
      el.scrollIntoView({ behavior: ok ? "smooth" : "auto", block: "center" });
      el.focus({ preventScroll: true });
    }
  }, [props.highlightId, props.focusTick, ok]);

  const register = (id: string, el: HTMLLIElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };

  return (
    <Section
      label="Evidence"
      title="Evidence"
      icon={<Quote size={18} />}
      className="rv-evidence"
      aside={<span className="rv-count">{props.evidence.length}</span>}
    >
      {props.evidence.length === 0 ? (
        <p className="rv-muted">No evidence items.</p>
      ) : (
        <ul className="rv-ev-list">
          {props.evidence.map((e) => (
            <EvidenceRow
              key={e.id}
              item={e}
              timezone={props.timezone}
              active={props.highlightId === e.id}
              focusTick={props.focusTick}
              register={register}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}
