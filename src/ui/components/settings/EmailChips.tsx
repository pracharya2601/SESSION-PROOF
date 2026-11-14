import { useId, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Mail, X } from "lucide-react";
import { springy } from "../../design";
import { isEmail } from "./shared";

export interface EmailChipsProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Visible label (rendered by this component so the input gets the id). */
  label: string;
  placeholder?: string;
  max?: number;
  hint?: string;
  /** External (server) error. */
  error?: string | null;
  required?: boolean;
}

/** Email chip input: Enter / comma / space / blur commits; Backspace on empty removes the last chip. */
export function EmailChips({ value, onChange, label, placeholder, max = 10, hint, error, required }: EmailChipsProps) {
  const id = useId();
  const reduce = useReducedMotion();
  const [text, setText] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  function commit(raw: string): boolean {
    const parts = raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return true;
    const bad = parts.filter((p) => !isEmail(p));
    const good = parts.filter((p) => isEmail(p) && !value.includes(p));
    const room = Math.max(0, max - value.length);
    if (good.length) onChange([...value, ...good.slice(0, room)]);
    if (bad.length) {
      setLocalErr(`"${bad[0]}" isn't a valid email address.`);
      setText(bad.join(", "));
      return false;
    }
    if (good.length > room) setLocalErr(`At most ${max} addresses.`);
    else setLocalErr(null);
    setText("");
    return true;
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === " " && text.trim())) {
      if (text.trim()) {
        e.preventDefault();
        commit(text);
      } else if (e.key !== "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  const err = localErr ?? error ?? null;
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;

  return (
    <div className="u2-chips-field">
      <label className="ds-field-label" htmlFor={id}>
        {label}
        {required && <span className="ds-field-req" aria-hidden="true"> *</span>}
      </label>
      <div className={"u2-chips" + (err ? " u2-chips-invalid" : "")} onClick={() => document.getElementById(id)?.focus()}>
        <AnimatePresence initial={false}>
          {value.map((addr) => (
            <motion.span
              key={addr}
              layout={!reduce}
              className="u2-chip"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
              transition={springy}
            >
              <Mail size={12} aria-hidden="true" />
              {addr}
              <button
                type="button"
                className="u2-chip-x"
                aria-label={`Remove ${addr}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== addr));
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          id={id}
          className="u2-chips-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          multiple
          value={text}
          placeholder={value.length ? "" : (placeholder ?? "name@example.com")}
          disabled={value.length >= max}
          aria-invalid={err ? true : undefined}
          aria-describedby={[hint ? hintId : "", err ? errId : ""].filter(Boolean).join(" ") || undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (localErr) setLocalErr(null);
          }}
          onKeyDown={onKey}
          onBlur={() => commit(text)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (/[\s,;]/.test(t)) {
              e.preventDefault();
              commit(text + " " + t);
            }
          }}
        />
      </div>
      {hint && (
        <p id={hintId} className="ds-field-hint">
          {hint}
        </p>
      )}
      <AnimatePresence initial={false}>
        {err && (
          <motion.p
            key="err"
            id={errId}
            className="ds-field-err"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            {err}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
