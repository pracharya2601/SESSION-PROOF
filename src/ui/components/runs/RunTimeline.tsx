import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ExternalLink, History } from "lucide-react";
import type { RunDetail, RunSummary } from "../../../contracts";
import { api } from "../../api";
import { ErrorNotice, Skeleton } from "../../design";
import { EventTimeline } from "./EventTimeline";
import { PipelineGraph } from "./PipelineGraph";
import { ModelChip, RunStatusIcon } from "./RunBits";
import { formatDuration, isActive, kindLabel, relativeTime, runElapsed, runHref, stageLabel, useNow, usePoll } from "./model";
import "./runs.css";

function byStartDesc(a: RunSummary, b: RunSummary): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0;
}

/** Compact per-session run history: every run for the session, latest expanded. */
export function RunTimeline(props: { sessionId: string }) {
  const { sessionId } = props;
  const reduce = useReducedMotion();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const [detailErr, setDetailErr] = useState<Record<string, unknown>>({});
  const mounted = useRef(true);
  const userPicked = useRef(false);
  const openRef = useRef<string | null>(null);
  openRef.current = open;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadDetail = useCallback(async (runId: string) => {
    try {
      const d = await api.getRun(runId);
      if (!mounted.current) return;
      setDetails((m) => ({ ...m, [runId]: d }));
      setDetailErr((m) => {
        const { [runId]: _drop, ...rest } = m;
        return rest;
      });
    } catch (e) {
      if (mounted.current) setDetailErr((m) => ({ ...m, [runId]: e }));
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const res = await api.listRuns({ sessionId });
      if (!mounted.current) return;
      const sorted = [...res.runs].sort(byStartDesc);
      setRuns(sorted);
      setError(null);
      const target = userPicked.current ? openRef.current : sorted[0]?.runId ?? null;
      if (!userPicked.current) setOpen(target);
      if (target) await loadDetail(target);
    } catch (e) {
      if (mounted.current) setError(e);
    }
  }, [sessionId, loadDetail]);

  useEffect(() => {
    setRuns(null);
    setDetails({});
    userPicked.current = false;
    void loadRuns();
  }, [loadRuns]);

  const anyActive = !!runs?.some(isActive);
  usePoll(loadRuns, anyActive, 3000, 200);
  const now = useNow(anyActive);

  function toggle(runId: string) {
    userPicked.current = true;
    const next = open === runId ? null : runId;
    setOpen(next);
    if (next && !details[next]) void loadDetail(next);
  }

  if (error && !runs) return <ErrorNotice error={error} onRetry={() => void loadRuns()} />;
  if (!runs) {
    return (
      <div aria-busy="true" className="stack-sm">
        <Skeleton height={44} radius={12} />
        <Skeleton height={44} radius={12} />
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="rn-empty-inline muted small">
        <History size={14} aria-hidden="true" /> No agent runs recorded for this session yet.
      </p>
    );
  }

  return (
    <ul className="rn-st-list">
      {runs.map((r) => {
        const isOpen = open === r.runId;
        const d = details[r.runId];
        const panelId = `rn-st-${r.runId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        return (
          <li key={r.runId} className={`rn-st-item${isOpen ? " is-open" : ""}`}>
            <button type="button" className="rn-st-head" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(r.runId)}>
              <RunStatusIcon status={r.status} size={24} />
              <span className="rn-st-main">
                <span className="rn-st-title">
                  {kindLabel(r.runKind)} <span className="muted">· {stageLabel(r.currentStage)}</span>
                </span>
                <span className="rn-st-sub tiny muted">
                  {relativeTime(r.startedAt, now)} · {formatDuration(runElapsed(r, now))} · {r.eventCount} events
                </span>
              </span>
              <motion.span className="rn-st-chev" animate={{ rotate: isOpen ? 180 : 0 }} aria-hidden="true">
                <ChevronDown size={16} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panelId}
                  className="rn-st-panel"
                  initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: reduce ? 0.1 : 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="rn-st-panel-inner">
                    {d ? (
                      <>
                        <PipelineGraph detail={d} compact />
                        <div className="row-between rn-st-actions">
                          <ModelChip provider={d.summary.aiProvider} model={d.summary.model} />
                          <a className="ds-btn ds-btn-ghost ds-btn-sm" href={runHref(r.runId)}>
                            Open run <ExternalLink size={13} aria-hidden="true" />
                          </a>
                        </div>
                        <EventTimeline events={d.events} newestFirst limit={8} compact />
                        {d.events.length > 8 && (
                          <a className="tiny rn-link" href={runHref(r.runId)}>
                            View all {d.events.length} events
                          </a>
                        )}
                      </>
                    ) : detailErr[r.runId] ? (
                      <ErrorNotice error={detailErr[r.runId]} onRetry={() => void loadDetail(r.runId)} />
                    ) : (
                      <Skeleton lines={3} />
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </li>
        );
      })}
    </ul>
  );
}
