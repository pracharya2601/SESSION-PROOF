import { motion, useReducedMotion } from "framer-motion";
import { Check, FileText, Receipt, ShieldCheck } from "lucide-react";
import type { FileKind } from "../../../contracts";
import { cx, springy } from "../../design";
import { FILE_KINDS, FILE_LABELS } from "./shared";

export const FILE_ICONS: Record<FileKind, typeof FileText> = {
  session_note: FileText,
  invoice: Receipt,
  approval_record: ShieldCheck,
};

/** Checkbox cards for choosing which PDFs to attach. Keeps the canonical order. */
export function FileKindChecks({
  value,
  onChange,
  legend,
  error,
}: {
  value: FileKind[];
  onChange: (next: FileKind[]) => void;
  legend: string;
  error?: string | null;
}) {
  const reduce = useReducedMotion();
  return (
    <fieldset className="u2-choice">
      <legend className="ds-field-label">{legend}</legend>
      <div className="u2-checks">
        {FILE_KINDS.map((k) => {
          const on = value.includes(k);
          const Icon = FILE_ICONS[k];
          return (
            <label key={k} className={cx("u2-check", on && "u2-check-on")}>
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => onChange(on ? value.filter((x) => x !== k) : FILE_KINDS.filter((x) => x === k || value.includes(x)))}
              />
              <span className="u2-check-box" aria-hidden="true">
                {on && (
                  <motion.span initial={reduce ? false : { scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={springy}>
                    <Check size={12} strokeWidth={3} />
                  </motion.span>
                )}
              </span>
              <Icon size={16} aria-hidden="true" />
              <span>{FILE_LABELS[k]}</span>
            </label>
          );
        })}
      </div>
      {error && <p className="ds-field-err">{error}</p>}
    </fieldset>
  );
}
