import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertOctagon, CheckCircle2, Info, ShieldCheck } from "lucide-react";
import type { DocumentationChecks, DocumentationIssue } from "../../../contracts";
import { Section } from "./Section";
import { SessionChecklist } from "./SessionChecklist";
import { rvSpring, useMotionOK } from "./motion";

const keyOf = (i: DocumentationIssue) => `${i.code}:${i.field}`;

/**
 * Documentation checks. When a save (new revision) clears a blocking issue, the item stays visible
 * and animates from blocking (red) to resolved (green) until the next revision.
 */
export function ChecksPanel(props: { checks: DocumentationChecks; revision: number }) {
  const ok = useMotionOK();
  const blocking = props.checks.issues.filter((i) => i.blocking);
  const info = props.checks.issues.filter((i) => !i.blocking);
  const prev = useRef<{ revision: number; blocking: DocumentationIssue[] } | null>(null);
  const [resolved, setResolved] = useState<DocumentationIssue[]>([]);

  useEffect(() => {
    const p = prev.current;
    if (p && p.revision !== props.revision) {
      const now = new Set(blocking.map(keyOf));
      setResolved(p.blocking.filter((i) => !now.has(keyOf(i))));
    }
    prev.current = { revision: props.revision, blocking };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revision, props.checks]);

  const rows: { issue: DocumentationIssue; done: boolean }[] = [
    ...blocking.map((issue) => ({ issue, done: false })),
    ...resolved.map((issue) => ({ issue, done: true })),
  ];

  const allClear = blocking.length === 0;

  return (
    <Section
      label="Documentation checks"
      title="Documentation checks"
      icon={<ShieldCheck size={18} />}
      className="rv-checks"
      aside={
        <motion.span
          key={allClear ? "clear" : "blocked"}
          initial={ok ? { scale: 0.7, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={rvSpring}
          className={`rv-chip ${allClear ? "rv-chip-ok" : "rv-chip-danger"}`}
        >
          {allClear ? "Ready" : `${blocking.length} blocking`}
        </motion.span>
      }
    >
      <p className="rv-muted rv-small">Not a compliance determination · rule version {props.checks.ruleVersion}</p>
      {rows.length === 0 && info.length === 0 && <p className="rv-ok-line">No issues found.</p>}
      {rows.length > 0 && (
        <>
          <h3 className="rv-block-h">
            {blocking.length > 0 ? `Blocking — must fix (${blocking.length})` : "Blocking issues resolved"}
          </h3>
          <ul className="rv-issues">
            <AnimatePresence initial={false}>
              {rows.map(({ issue, done }) => (
                <motion.li
                  key={keyOf(issue)}
                  layout={ok}
                  initial={ok ? { opacity: 0, x: -8 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  exit={ok ? { opacity: 0, height: 0, marginTop: 0 } : { opacity: 0 }}
                  transition={ok ? rvSpring : { duration: 0 }}
                  className={`rv-issue ${done ? "rv-issue-resolved" : "rv-issue-blocking"}`}
                >
                  <span className="rv-issue-icon" aria-hidden="true">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={done ? "ok" : "bad"}
                        initial={ok ? { scale: 0, rotate: -90 } : false}
                        animate={{ scale: 1, rotate: 0 }}
                        exit={ok ? { scale: 0, rotate: 90 } : undefined}
                        transition={rvSpring}
                        style={{ display: "inline-flex" }}
                      >
                        {done ? <CheckCircle2 size={16} /> : <AlertOctagon size={16} />}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  <span>
                    {done && <span className="rv-sr">Resolved: </span>}
                    <strong>{issue.field}</strong>: <span className={done ? "rv-strike" : undefined}>{issue.message}</span>
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </>
      )}
      {info.length > 0 && (
        <>
          <h3 className="rv-info-h">Informational ({info.length})</h3>
          <ul className="rv-issues">
            {info.map((i) => (
              <li key={keyOf(i)} className="rv-issue rv-issue-info">
                <span className="rv-issue-icon" aria-hidden="true">
                  <Info size={16} />
                </span>
                <span>
                  <strong>{i.field}</strong>: {i.message}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.checks.checklist && (
        <>
          <h3 className="rv-info-h">Session checklist</h3>
          <SessionChecklist checklist={props.checks.checklist} />
        </>
      )}
    </Section>
  );
}
