import { useId } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Cpu, Hourglass, X } from "lucide-react";
import { RUN_STATUS_LABELS, type RunStatus } from "./model";

/** Animated run status glyph: pulsing ring (running), amber hourglass, green check, red cross. */
export function RunStatusIcon(props: { status: RunStatus; size?: number; label?: boolean }) {
  const size = props.size ?? 28;
  const reduce = useReducedMotion();
  const icon = Math.round(size * 0.5);
  return (
    <span className="rn-status-wrap">
      <span
        className={`rn-status rn-status-${props.status}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={RUN_STATUS_LABELS[props.status]}
      >
        {props.status === "running" && (
          <>
            <span className="rn-pulse" aria-hidden="true" />
            <span className="rn-pulse rn-pulse-2" aria-hidden="true" />
            <span className="rn-core" aria-hidden="true" />
          </>
        )}
        {props.status === "waiting" && (
          <motion.span
            aria-hidden="true"
            className="rn-ico"
            animate={reduce ? undefined : { rotate: [0, 0, 180, 180] }}
            transition={reduce ? undefined : { duration: 2.4, repeat: Infinity, times: [0, 0.4, 0.6, 1], ease: "easeInOut" }}
          >
            <Hourglass size={icon} />
          </motion.span>
        )}
        {props.status === "succeeded" && (
          <motion.span
            aria-hidden="true"
            className="rn-ico"
            initial={reduce ? false : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
          >
            <Check size={icon} strokeWidth={3} />
          </motion.span>
        )}
        {props.status === "failed" && (
          <motion.span
            aria-hidden="true"
            className="rn-ico"
            initial={reduce ? false : { scale: 0.4, rotate: -45, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
          >
            <X size={icon} strokeWidth={3} />
          </motion.span>
        )}
      </span>
      {props.label && <span className={`rn-status-text rn-tone-${props.status}`}>{RUN_STATUS_LABELS[props.status]}</span>}
    </span>
  );
}

export function ModelChip(props: { provider: string | null; model: string | null }) {
  if (!props.provider && !props.model) return null;
  return (
    <span className="rn-chip rn-chip-ai" title="AI provider and model">
      <Cpu size={12} aria-hidden="true" />
      {props.provider && <span>{props.provider}</span>}
      {props.provider && props.model && <span className="rn-chip-sep" aria-hidden="true">·</span>}
      {props.model && <span className="mono">{props.model}</span>}
    </span>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Animated segmented control (radio group semantics, gliding thumb). */
export function Segmented<T extends string>(props: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  "aria-label": string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div className="rn-seg" role="radiogroup" aria-label={props["aria-label"]}>
      {props.options.map((o, i) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`rn-seg-btn${on ? " is-on" : ""}`}
            onClick={() => props.onChange(o.value)}
            onKeyDown={(e) => {
              let j = -1;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % props.options.length;
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + props.options.length) % props.options.length;
              else if (e.key === "Home") j = 0;
              else if (e.key === "End") j = props.options.length - 1;
              if (j < 0) return;
              e.preventDefault();
              const opt = props.options[j];
              if (opt) props.onChange(opt.value);
              const parent = e.currentTarget.parentElement;
              const btn = parent?.querySelectorAll<HTMLButtonElement>("button")[j];
              btn?.focus();
            }}
          >
            {on && (
              <motion.span
                layoutId={`rn-seg-thumb-${id}`}
                className="rn-seg-thumb"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                aria-hidden="true"
              />
            )}
            <span className="rn-seg-label">{o.label}</span>
            {o.count !== undefined && o.count > 0 && <span className="rn-seg-count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
