/** Controlled disclosure section for the review page (button + region, keyboard-native). */
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function Accordion(props: {
  id: string;
  title: string;
  icon?: ReactNode;
  /** Small count shown in the header (e.g. blockers). */
  badge?: { text: string; tone: "danger" | "warn" | "ok" | "neutral" } | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  const btn = `rva-btn-${props.id}`;
  const panel = `rva-panel-${props.id}`;
  return (
    <section className={`rva${props.open ? " is-open" : ""}`} id={`rva-${props.id}`}>
      <h3 className="rva-h">
        <button
          type="button"
          id={btn}
          className="rva-btn"
          aria-expanded={props.open}
          aria-controls={panel}
          onClick={() => props.onToggle(!props.open)}
        >
          {props.icon && (
            <span className="rva-icon" aria-hidden="true">
              {props.icon}
            </span>
          )}
          <span className="rva-title">{props.title}</span>
          {props.badge && <span className={`rvc-tag rvc-tag-${props.badge.tone}`}>{props.badge.text}</span>}
          <ChevronDown size={16} className="rva-chev" aria-hidden="true" />
        </button>
      </h3>
      {props.open && (
        <div id={panel} role="region" aria-labelledby={btn} className="rva-panel">
          {props.children}
        </div>
      )}
    </section>
  );
}
