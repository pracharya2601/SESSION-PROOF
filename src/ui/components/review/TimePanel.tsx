import { AnimatePresence, motion } from "framer-motion";
import { Clock } from "lucide-react";
import type { TimeSummary } from "../../../contracts";
import { formatInstant } from "./format";
import { Section } from "./Section";
import { rvSpring, useMotionOK } from "./motion";

export function TimePanel(props: { time: TimeSummary }) {
  const t = props.time;
  const ok = useMotionOK();
  return (
    <Section label="Time summary" title="Time" icon={<Clock size={18} />} className="rv-time">
      <div className="rv-time-grid">
        <div className="rv-stat">
          <span className="rv-stat-label">Scheduled</span>
          <span className="rv-stat-value">{t.scheduledMinutes} min</span>
          <span className="rv-muted rv-small">
            {formatInstant(t.scheduledFrom, t.timezone)} – {formatInstant(t.scheduledTo, t.timezone, false)}
          </span>
        </div>
        <div className="rv-stat">
          <span className="rv-stat-label">
            Evidence window <span className="rv-muted">(informational only)</span>
          </span>
          {t.evidenceWindowFrom && t.evidenceWindowTo ? (
            <>
              <span className="rv-stat-value">{t.evidenceWindowMinutes ?? "—"} min</span>
              <span className="rv-muted rv-small">
                {formatInstant(t.evidenceWindowFrom, t.timezone, false)} – {formatInstant(t.evidenceWindowTo, t.timezone, false)}
              </span>
            </>
          ) : (
            <span className="rv-muted">No evidence window</span>
          )}
        </div>
        <div className={`rv-stat rv-stat-confirmed${t.confirmedMinutes !== null ? " is-set" : ""}`}>
          <span className="rv-stat-label">Confirmed duration (provider)</span>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={t.confirmedMinutes ?? "none"}
              className="rv-stat-value"
              initial={ok ? { opacity: 0, y: 10, filter: "blur(4px)" } : false}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={ok ? { opacity: 0, y: -10 } : undefined}
              transition={rvSpring}
            >
              {t.confirmedMinutes !== null ? `${t.confirmedMinutes} min` : <strong className="rv-warn">Not confirmed</strong>}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}
