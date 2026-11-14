import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Clock, ListOrdered, Route, Workflow } from "lucide-react";
import type { RunDetail as RunDetailData } from "../../contracts";
import { api, ApiClientError } from "../api";
import { Card, EmptyState, ErrorNotice, PageHeader, Skeleton, fadeOnly, fadeUp, stagger } from "../design";
import { EventTimeline } from "../components/runs/EventTimeline";
import { PipelineGraph } from "../components/runs/PipelineGraph";
import { ModelChip, RunStatusIcon } from "../components/runs/RunBits";
import {
  absoluteTime,
  formatDuration,
  isActive,
  kindLabel,
  relativeTime,
  runElapsed,
  sessionHref,
  stageLabel,
  useNow,
  usePoll,
} from "../components/runs/model";
import "../components/runs/runs.css";

function goBack() {
  window.location.hash = "#/runs";
}

export default function RunDetail(props: { runId: string }) {
  const { runId } = props;
  const reduce = useReducedMotion();
  const [data, setData] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.getRun(runId);
      if (!mounted.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e);
    }
  }, [runId]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  const active = !!data && isActive(data.summary);
  usePoll(load, active, 3000, 300);
  const now = useNow(active || !!data);
  const item = reduce ? fadeOnly : fadeUp;

  const notFound = error instanceof ApiClientError && error.status === 404;

  if (!data) {
    return (
      <div className="rn-page">
        <PageHeader eyebrow="Agent run" title="Run" onBack={goBack} backLabel="All runs" />
        {notFound ? (
          <EmptyState icon={<Workflow size={22} />} title="Run not found" description="It may belong to another account or has not been recorded." />
        ) : error ? (
          <ErrorNotice error={error} onRetry={() => void load()} />
        ) : (
          <div className="stack" aria-busy="true">
            <Skeleton height={96} radius={16} />
            <Skeleton height={120} radius={16} />
            <Skeleton lines={5} />
          </div>
        )}
      </div>
    );
  }

  const s = data.summary;
  return (
    <motion.div className="rn-page" variants={stagger} initial="hidden" animate="show">
      <PageHeader
        eyebrow={`${kindLabel(s.runKind)} run`}
        title={s.clientRef ?? "Agent run"}
        subtitle={<span className="mono tiny rn-runid">{s.runId}</span>}
        onBack={goBack}
        backLabel="All runs"
        actions={
          <a className="ds-btn ds-btn-secondary ds-btn-sm" href={sessionHref(s.sessionId)}>
            Session review <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        }
      />

      <motion.div variants={item}>
        <Card padding="md" className={`rn-summary rn-summary-${s.status}`} glow={active}>
          <div className="rn-summary-lead">
            <RunStatusIcon status={s.status} size={40} label />
            <div className="rn-summary-stage">
              <span className="tiny muted">Current stage</span>
              <strong>{stageLabel(s.currentStage)}</strong>
            </div>
          </div>
          <dl className="rn-summary-grid">
            <div>
              <dt>Started</dt>
              <dd title={absoluteTime(s.startedAt)}>{relativeTime(s.startedAt, now)}</dd>
            </div>
            <div>
              <dt>
                <Clock size={12} aria-hidden="true" /> Duration
              </dt>
              <dd className={`mono tabular${active ? " rn-ticking" : ""}`}>{formatDuration(runElapsed(s, now))}</dd>
            </div>
            <div>
              <dt>
                <ListOrdered size={12} aria-hidden="true" /> Events
              </dt>
              <dd className="tabular">{s.eventCount}</dd>
            </div>
            {(s.aiProvider || s.model) && (
              <div>
                <dt>AI</dt>
                <dd>
                  <ModelChip provider={s.aiProvider} model={s.model} />
                </dd>
              </div>
            )}
          </dl>
        </Card>
      </motion.div>

      <motion.div variants={item}>
        <Card as="section" padding="md" aria-labelledby="rn-pipe-h">
          <h2 id="rn-pipe-h" className="rn-h2">
            <Route size={16} aria-hidden="true" /> Pipeline
            {active && <span className="rn-live-dot" aria-hidden="true" />}
          </h2>
          <PipelineGraph detail={data} />
        </Card>
      </motion.div>

      <motion.div variants={item}>
        <Card as="section" padding="md" aria-labelledby="rn-ev-h">
          <h2 id="rn-ev-h" className="rn-h2">
            <ListOrdered size={16} aria-hidden="true" /> Events
            <span className="tiny muted">{data.events.length}</span>
          </h2>
          {error !== null && <ErrorNotice error={error} title="Refresh failed" onRetry={() => void load()} />}
          <EventTimeline events={data.events} />
        </Card>
      </motion.div>
    </motion.div>
  );
}
