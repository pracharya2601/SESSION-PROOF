import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { springy } from "../../design";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Inline style for the label (e.g. a font preview). */
  hint?: ReactNode;
}

/** Radio-group segmented control: roving tabindex, ←/→/Home/End, gliding thumb. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  "aria-label": label,
  disabled,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  "aria-label"?: string;
  disabled?: boolean;
  id?: string;
}) {
  const reduce = useReducedMotion();
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const cur = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const o = options[next];
    if (o) {
      onChange(o.value);
      refs.current[next]?.focus();
    }
  }

  return (
    <div id={id} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className="tp-seg" onKeyDown={onKey}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            className={on ? "tp-seg-opt on" : "tp-seg-opt"}
            onClick={() => onChange(o.value)}
          >
            {on && (
              <motion.span
                className="tp-seg-thumb"
                layoutId={`${base}-thumb`}
                transition={reduce ? { duration: 0 } : springy}
                aria-hidden="true"
              />
            )}
            <span className="tp-seg-label">{o.label}</span>
            {o.hint && <span className="tp-seg-hint">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
