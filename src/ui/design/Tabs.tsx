import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cx } from "./cx";
import { springy } from "./motion";

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Small count / badge after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label": string;
  /** Use the same idBase on <TabPanel> to link tab ↔ panel. */
  idBase?: string;
  className?: string;
  size?: "sm" | "md";
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

/** WAI-ARIA tabs: roving tabindex, ←/→/Home/End, automatic activation, gliding indicator. */
export function Tabs<T extends string>({ items, value, onChange, idBase, className, size = "md", ...aria }: TabsProps<T>) {
  const auto = useId();
  const base = idBase ?? `tabs${auto}`;
  const reduce = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const enabled = items.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
    const cur = enabled.indexOf(items.findIndex((t) => t.id === value));
    let next = -1;
    if (e.key === "ArrowRight") next = enabled[(cur + 1) % enabled.length] ?? -1;
    else if (e.key === "ArrowLeft") next = enabled[(cur - 1 + enabled.length) % enabled.length] ?? -1;
    else if (e.key === "Home") next = enabled[0] ?? -1;
    else if (e.key === "End") next = enabled[enabled.length - 1] ?? -1;
    if (next < 0) return;
    e.preventDefault();
    const item = items[next];
    if (item) {
      onChange(item.id);
      refs.current[next]?.focus();
    }
  }

  return (
    <div role="tablist" aria-label={aria["aria-label"]} className={cx("ds-tabs", `ds-tabs-${size}`, className)} onKeyDown={onKey}>
      {items.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(base, t.id)}
            aria-selected={selected}
            aria-controls={panelId(base, t.id)}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className={cx("ds-tab", selected && "ds-tab-on")}
            onClick={() => onChange(t.id)}
          >
            {selected && (
              <motion.span
                className="ds-tab-indicator"
                layoutId={`${base}-ind`}
                transition={reduce ? { duration: 0 } : springy}
                aria-hidden="true"
              />
            )}
            {t.icon && <span className="ds-tab-ico" aria-hidden="true">{t.icon}</span>}
            <span className="ds-tab-label">{t.label}</span>
            {t.badge != null && <span className="ds-tab-badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, id, active, children, className }: { idBase: string; id: string; active: boolean; children: ReactNode; className?: string }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={panelId(idBase, id)} aria-labelledby={tabId(idBase, id)} tabIndex={0} className={cx("ds-tabpanel", className)}>
      {children}
    </div>
  );
}
