import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "./cx";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the control invalid (aria-invalid + danger ring). Field sets this automatically when it has an error. */
  invalid?: boolean;
  /** Leading adornment (icon). */
  leading?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, leading, className, ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      className={cx("ds-input", leading ? "ds-input-has-leading" : undefined, className)}
      aria-invalid={invalid || rest["aria-invalid"] || undefined}
      {...rest}
    />
  );
  if (!leading) return input;
  return (
    <span className="ds-input-wrap">
      <span className="ds-input-leading" aria-hidden="true">{leading}</span>
      {input}
    </span>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, className, rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx("ds-input", "ds-textarea", className)}
      aria-invalid={invalid || rest["aria-invalid"] || undefined}
      {...rest}
    />
  );
});

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  /** Either pass `options` or `<option>` children. */
  options?: SelectOption[];
}

/** Native <select> (best a11y + mobile) with design-system styling. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, options, className, children, ...rest }, ref) {
  return (
    <span className={cx("ds-select-wrap", className)}>
      <select ref={ref} className="ds-input ds-select" aria-invalid={invalid || rest["aria-invalid"] || undefined} {...rest}>
        {options
          ? options.map((o) => (
              <option key={String(o.value)} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown className="ds-select-chev" size={16} aria-hidden="true" />
    </span>
  );
});
