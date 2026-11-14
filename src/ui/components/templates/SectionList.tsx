import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Reorder, useDragControls, useReducedMotion } from "framer-motion";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { TemplateSection } from "../../../contracts";
import { Switch } from "../../design";
import { SECTION_LABELS } from "./shared";

function Row({
  section,
  index,
  count,
  disabled,
  onToggle,
  onMove,
}: {
  section: TemplateSection;
  index: number;
  count: number;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
  onMove: (delta: number) => void;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const label = SECTION_LABELS[section.key] ?? section.key;
  const handleRef = useRef<HTMLButtonElement>(null);

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      onMove(-1);
    } else if (e.key === "ArrowDown" && index < count - 1) {
      e.preventDefault();
      onMove(1);
    }
  }

  return (
    <Reorder.Item
      value={section}
      dragListener={false}
      dragControls={controls}
      className={section.enabled ? "tp-sec" : "tp-sec tp-sec-off"}
      whileDrag={reduce ? undefined : { scale: 1.025, boxShadow: "0 14px 32px -12px rgba(0,0,0,.55)", zIndex: 2 }}
      layout={reduce ? undefined : "position"}
    >
      <button
        ref={handleRef}
        type="button"
        className="tp-grip"
        aria-label={`Reorder ${label}. Position ${index + 1} of ${count}. Use arrow up and down to move.`}
        disabled={disabled}
        onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
          if (disabled) return;
          e.preventDefault();
          controls.start(e);
        }}
        onKeyDown={onKey}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <span className="tp-sec-num" aria-hidden="true">
        {index + 1}
      </span>
      <span className="tp-sec-label">{label}</span>
      <span className="tp-sec-moves">
        <button type="button" className="tp-mini" aria-label={`Move ${label} up`} disabled={disabled || index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tp-mini"
          aria-label={`Move ${label} down`}
          disabled={disabled || index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={13} aria-hidden="true" />
        </button>
      </span>
      <Switch checked={section.enabled} onChange={onToggle} disabled={disabled} aria-label={`Show ${label}`} />
    </Reorder.Item>
  );
}

/** Drag-to-reorder (framer Reorder) + keyboard move + per-section toggle. */
export function SectionList({
  sections,
  onChange,
  disabled,
}: {
  sections: TemplateSection[];
  onChange: (s: TemplateSection[]) => void;
  disabled?: boolean;
}) {
  const [announce, setAnnounce] = useState("");
  const enabled = sections.filter((s) => s.enabled).length;

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= sections.length) return;
    const next = sections.slice();
    const [it] = next.splice(i, 1);
    next.splice(j, 0, it!);
    onChange(next);
    setAnnounce(`${SECTION_LABELS[it!.key] ?? it!.key} moved to position ${j + 1} of ${sections.length}.`);
    // keep focus on the moved row's handle
    window.requestAnimationFrame(() => {
      const handles = document.querySelectorAll<HTMLButtonElement>(".tp-sections .tp-grip");
      handles[j]?.focus();
    });
  }

  return (
    <div className="tp-sections-wrap">
      <p className="tp-help">
        {enabled} of {sections.length} sections shown. Drag the handle (or focus it and use ↑ ↓) to change the order.
      </p>
      <Reorder.Group axis="y" values={sections} onReorder={(v) => !disabled && onChange(v)} className="tp-sections">
        {sections.map((s, i) => (
          <Row
            key={s.key}
            section={s}
            index={i}
            count={sections.length}
            disabled={disabled}
            onToggle={(on) => onChange(sections.map((x) => (x.key === s.key ? { ...x, enabled: on } : x)))}
            onMove={(d) => move(i, d)}
          />
        ))}
      </Reorder.Group>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
