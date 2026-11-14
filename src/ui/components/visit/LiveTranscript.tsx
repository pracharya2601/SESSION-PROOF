import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { BandSegment } from "../../../contracts";
import { Badge, fadeUp, useReducedMotion, fadeOnly } from "../../design";

function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** Final segments (speaker + local time) followed by the current interim line, greyed. */
export function LiveTranscript({ segments, interim, live }: { segments: BandSegment[]; interim: string; live: boolean }) {
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const v = reduce ? fadeOnly : fadeUp;

  // Keep the newest line in view while recording.
  useEffect(() => {
    const el = listRef.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [segments.length, interim, live]);

  if (segments.length === 0 && !interim) {
    return <p className="rv-empty">{live ? "Listening… transcript lines appear here as people speak." : "No transcript yet."}</p>;
  }
  return (
    <ol ref={listRef} className="rv-transcript" aria-live="polite" aria-relevant="additions" aria-label="Transcript">
      <AnimatePresence initial={false}>
        {segments.map((s) => (
          <motion.li key={s.id} className="rv-line" variants={v} initial="hidden" animate="show">
            <div className="rv-line-meta">
              <span className="rv-line-speaker">{s.speaker ?? "Unlabelled"}</span>
              <time dateTime={s.observedFrom}>{localTime(s.observedFrom)}</time>
              {s.sourceMode === "fixture" && (
                <Badge tone="fixture" title="Synthetic transcript from the simulated transcriber">
                  simulated
                </Badge>
              )}
            </div>
            <p className="rv-line-text">{s.text}</p>
          </motion.li>
        ))}
      </AnimatePresence>
      {interim && (
        <li className="rv-line rv-line-interim" aria-hidden="true">
          <div className="rv-line-meta">
            <span>…</span>
          </div>
          <p className="rv-line-text">{interim}</p>
        </li>
      )}
    </ol>
  );
}
