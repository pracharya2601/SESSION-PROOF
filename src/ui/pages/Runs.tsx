import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Activity, ChevronRight, RefreshCw, Workflow } from "lucide-react";
import type { RunSummary } from "../../contracts";
import { api } from "../api";
import { Button, EmptyState, ErrorNotice, PageHeader, Skeleton, fadeOnly, fadeUp, stagger } from "../design";
import { ModelChip, RunStatusIcon, Segmented, type SegOption } from "../components/runs/RunBits";
import {
  absoluteTime,
  formatDuration,
  isActive,
  kindLabel,
  relativeTime,
  runElapsed,
  runHref,
  stageLabel,
  useNow,
  usePoll,
  type RunStatus,
} from "../components/runs/model";
import "../components/runs/runs.css";

type Filter = "all" | RunStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

function mergeFirstPage(prev: RunSummary[], first: RunSummary[]): RunSummary[] {
  const seen = new Set(first.map((r) => r.runId));
  return [...first, ...prev.filter((r) => !seen.has(r.runId))];
}

function RunRow({ run, now }: { run: RunSummary; now: number }) {
  return (
    <a className={`rn-row rn-row-${run.status}`} href={runHref(run.runId)}>
      <RunStatusIcon status={run.status} />
      <div className="rn-row-main">
        <div className="rn-row-title">
          <span className="rn-row-client">{run.clientRef ?? "Unknown client"}</span>
          <span className={`rn-chip rn-chip-kind rn-kind-${run.runKind}`}>{kindLabel(run.runKind)}</span>
        </div>
        <div className="rn-row-sub">
          <span className="rn-row-stage">{stageLabel(run.currentStage)}</span>
          <ModelChip provider={run.aiProvider} model={run.model} />
        </div>
      </div>
      <div className="rn-row-stats">
        <time className="rn-row-when small" dateTime={run.startedAt} title={absoluteTime(run.startedAt)}>
          {relativeTime(run.startedAt, now)}
        </time>
        <span className={`rn-row-dur mono tabular small${isActive(run) ? " is-live" : ""}`} aria-label="Duration">
          {formatDuration(runElapsed(run, now))}
        </span>
        <span className="tiny muted tabular">
          {run.eventCount} event{run.eventCount === 1 ? "" : "s"}
        </span>
      </div>
      <ChevronRight size={16} className="rn-row-chev" aria-hidden="true" />
    </a>
  );
}

export default function Runs() {
  const reduce = useReducedMotion();
  const [filter, setFilter] = useState<Filter>("all");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const token = useRef(0);

  const status = filter === "all" ? undefined : filter;

  const loadFirst = useCallback(
    async (mode: "replace" | "merge") => {
      const t = token.current;
      try {
        const res = await api.listRuns(status ? { status } : {});
        if (t !== token.current) return;
        setRuns((prev) => (mode === "merge" && prev ? mergeFirstPage(prev, res.runs) : res.runs));
        if (mode === "replace") setCursor(res.nextCursor);
        setError(null);
      } catch (e) {
        if (t === token.current) setError(e);
      }
    },
    [status],
  );

  useEffect(() => {
    token.current++;
    setRuns(null);
    setCursor(null);
    setError(null);
    void loadFirst("replace");
  }, [loadFirst]);

  const anyActive = !!runs?.some(isActive);
  usePoll(() => loadFirst("merge"), anyActive, 3000, 200);
  const now = useNow(anyActive || !!runs?.length, anyActive ? 1000 : 30000);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const t = token.current;
    setLoadingMore(true);
    try {
      const res = await api.listRuns(status ? { status, cursor } : { cursor });
      if (t !== token.current) return;
      setRuns((prev) => {
        const base = prev ?? [];
        const seen = new Set(base.map((r) => r.runId));
        return [...base, ...res.runs.filter((r) => !seen.has(r.runId))];
      });
      setCursor(res.nextCursor);
    } catch (e) {
      if (t === token.current) setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await loadFirst("merge");
    setRefreshing(false);
  }

  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = {};
    if (filter === "all" && runs) for (const r of runs) if (isActive(r)) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [runs, filter]);
  const options: SegOption<Filter>[] = FILTERS.map((f) => ({ ...f, count: counts[f.value] }));
  const activeCount = runs?.filter(isActive).length ?? 0;
  const item = reduce ? fadeOnly : fadeUp;

  return (
    <div className="rn-page">
      <PageHeader
        eyebrow="Agents"
        title="Run history"
        subtitle={
          activeCount > 0 ? (
            <span className="rn-live">
              <span className="rn-live-dot" aria-hidden="true" /> {activeCount} agent{activeCount === 1 ? "" : "s"} working now
            </span>
          ) : (
            "Every processing and delivery run, stage by stage."
          )
        }
        actions={
          <Button size="sm" icon={<RefreshCw size={14} className={refreshing ? "ds-spin" : undefined} />} onClick={() => void refresh()} disabled={refreshing}>
            Refresh
          </Button>
        }
      />

      <div className="rn-toolbar">
        <Segmented aria-label="Filter runs by status" options={options} value={filter} onChange={setFilter} />
      </div>

      {error !== null && <ErrorNotice error={error} onRetry={() => void loadFirst(runs ? "merge" : "replace")} />}

      {runs === null && error === null ? (
        <div className="rn-list" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rn-row rn-row-skel">
              <Skeleton circle width={28} height={28} />
              <div className="rn-row-main">
                <Skeleton width="40%" height={14} />
                <Skeleton width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : runs && runs.length === 0 ? (
        <EmptyState
          icon={filter === "all" ? <Workflow size={22} /> : <Activity size={22} />}
          title={filter === "all" ? "No agent runs yet" : `No ${filter} runs`}
          description={
            filter === "all"
              ? "Runs appear here as soon as a session is discovered and the workflow starts processing it."
              : "Try another filter to see the rest of the history."
          }
          action={filter !== "all" ? <Button size="sm" onClick={() => setFilter("all")}>Show all runs</Button> : undefined}
        />
      ) : runs ? (
        <>
          <motion.ul key={filter} className="rn-list" variants={stagger} initial="hidden" animate="show" aria-label="Runs">
              {runs.map((r) => (
                <motion.li key={r.runId} variants={item} layout={reduce ? undefined : "position"}>
                  <RunRow run={r} now={now} />
                </motion.li>
              ))}
          </motion.ul>
          {cursor && (
            <div className="rn-more">
              <Button onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
