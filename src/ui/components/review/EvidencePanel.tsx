import { useEffect, useRef } from "react";
import type { EvidenceItem } from "../../../contracts";
import { formatInstant } from "./format";

export function EvidencePanel(props: { evidence: EvidenceItem[]; timezone: string; highlightId: string | null; focusTick: number }) {
  const refs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (!props.highlightId) return;
    const el = refs.current.get(props.highlightId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
    }
  }, [props.highlightId, props.focusTick]);

  return (
    <section className="card rv-evidence" aria-label="Evidence">
      <h2>Evidence</h2>
      {props.evidence.length === 0 ? (
        <p className="muted">No evidence items.</p>
      ) : (
        <ul className="rv-ev-list">
          {props.evidence.map((e) => (
            <li
              key={e.id}
              tabIndex={-1}
              ref={(el) => {
                if (el) refs.current.set(e.id, el);
                else refs.current.delete(e.id);
              }}
              className={`rv-ev-item${props.highlightId === e.id ? " rv-ev-active" : ""}`}
            >
              <div className="rv-ev-meta">
                <code>{e.id}</code>
                <span>{e.speaker ?? <em className="muted">speaker not recorded</em>}</span>
                <span>
                  {e.observedFrom ? (
                    formatInstant(e.observedFrom, props.timezone, false)
                  ) : (
                    <em className="muted">time not recorded</em>
                  )}
                </span>
                <span className="badge rv-mode">{e.sourceMode}</span>
              </div>
              <blockquote className="rv-excerpt">{e.excerpt}</blockquote>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
