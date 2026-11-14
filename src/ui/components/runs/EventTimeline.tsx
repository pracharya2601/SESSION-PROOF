import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { RunEvent } from "../../../contracts";
import { fadeOnly, fadeUp, stagger } from "../../design";
import { absoluteTime, clockTime, humanizeKey, sortEvents, stageLabel } from "./model";

const STATUS_TEXT: Record<RunEvent["status"], string> = {
  started: "Started",
  succeeded: "Succeeded",
  failed: "Failed",
  waiting: "Waiting",
  skipped: "Skipped",
  info: "Info",
};

function metaValue(v: string | number | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  return v;
}

/** Vertical event timeline with staggered entrance; newest last (or first when `newestFirst`). */
export function EventTimeline(props: { events: RunEvent[]; newestFirst?: boolean; limit?: number; compact?: boolean }) {
  const reduce = useReducedMotion();
  const item = reduce ? fadeOnly : fadeUp;
  const events = useMemo(() => {
    const s = sortEvents(props.events);
    const ordered = props.newestFirst ? s.reverse() : s;
    return props.limit ? ordered.slice(0, props.limit) : ordered;
  }, [props.events, props.newestFirst, props.limit]);

  if (events.length === 0) return <p className="muted small">No events recorded yet.</p>;

  return (
    <motion.ol className={`rn-tl${props.compact ? " is-compact" : ""}`} variants={stagger} initial="hidden" animate="show">
        {events.map((e) => {
          const meta = Object.entries(e.meta ?? {}).filter(([, v]) => v !== null && v !== "");
          return (
            <motion.li key={e.id} className={`rn-tl-item rn-ev-${e.status}`} variants={item} layout={reduce ? undefined : "position"}>
              <span className="rn-tl-dot" aria-hidden="true" />
              <div className="rn-tl-body">
                <div className="rn-tl-head">
                  <time className="rn-tl-time mono tabular" dateTime={e.at} title={absoluteTime(e.at)}>
                    {clockTime(e.at)}
                  </time>
                  <span className="rn-chip rn-chip-stage">{stageLabel(e.stage)}</span>
                  <span className={`rn-chip rn-chip-st rn-st-${e.status}`}>{STATUS_TEXT[e.status]}</span>
                </div>
                <p className="rn-tl-label">{e.label}</p>
                {e.detail && <p className="rn-tl-detail">{e.detail}</p>}
                {meta.length > 0 && (
                  <ul className="rn-tl-meta" aria-label="Details">
                    {meta.map(([k, v]) => (
                      <li key={k} className="rn-chip rn-chip-meta">
                        <span className="rn-meta-k">{humanizeKey(k)}</span>
                        <span className="rn-meta-v mono">{metaValue(v)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.li>
          );
        })}
    </motion.ol>
  );
}
