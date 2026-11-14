import { useEffect, useId, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";
import { Input, springy } from "../../design";
import { ACCENT_PRESETS, HEX_RE } from "./shared";

/** Accent colour: preset swatches (radio group) + native colour well + hex text input. */
export function AccentPicker({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const reduce = useReducedMotion();
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const textInvalid = !HEX_RE.test(text);
  const activeIdx = ACCENT_PRESETS.findIndex((p) => p.hex.toLowerCase() === value.toLowerCase());

  function commit(raw: string) {
    let v = raw.trim();
    if (v && !v.startsWith("#")) v = "#" + v;
    setText(v);
    if (HEX_RE.test(v)) onChange(v.toUpperCase());
  }

  function onSwatchKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const n = ACCENT_PRESETS.length;
    const cur = activeIdx < 0 ? 0 : activeIdx;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur - 1 + n) % n;
    if (next < 0) return;
    e.preventDefault();
    onChange(ACCENT_PRESETS[next]!.hex);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  }

  return (
    <div className="tp-accent">
      <div className="tp-swatches" role="radiogroup" aria-label="Accent presets" onKeyDown={onSwatchKey}>
        {ACCENT_PRESETS.map((p, i) => {
          const on = i === activeIdx;
          return (
            <motion.button
              key={p.hex}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={p.name}
              title={`${p.name} ${p.hex}`}
              tabIndex={on || (activeIdx < 0 && i === 0) ? 0 : -1}
              disabled={disabled}
              className={on ? "tp-swatch on" : "tp-swatch"}
              style={{ background: p.hex }}
              onClick={() => onChange(p.hex)}
              whileHover={disabled || reduce ? undefined : { scale: 1.12 }}
              whileTap={disabled || reduce ? undefined : { scale: 0.92 }}
              transition={springy}
            >
              {on && <Check size={13} strokeWidth={3} aria-hidden="true" />}
            </motion.button>
          );
        })}
      </div>
      <div className="tp-accent-custom">
        <label className="tp-well" style={{ background: HEX_RE.test(value) ? value : "#000" }} title="Pick a custom colour">
          <span className="sr-only">Custom accent colour</span>
          <input
            type="color"
            value={HEX_RE.test(value) ? value.toLowerCase() : "#000000"}
            disabled={disabled}
            onChange={(e) => commit(e.target.value)}
          />
        </label>
        <Input
          id={`${id}-hex`}
          aria-label="Accent hex colour"
          className="tp-hex mono"
          value={text}
          maxLength={7}
          spellCheck={false}
          disabled={disabled}
          invalid={textInvalid || !!error}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => textInvalid && setText(value)}
        />
      </div>
      {(textInvalid || error) && (
        <p className="ds-field-err" role="alert">
          {error ?? "Use a #RRGGBB colour."}
        </p>
      )}
    </div>
  );
}
