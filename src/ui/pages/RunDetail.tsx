import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Archive, ArchiveRestore, ArrowUpRight, Clock, ListOrdered, Route, Trash2, Workflow } from "lucide-react";
import type { RunDetail as RunDetailData } from "../../contracts";
import { api, ApiClientError } from "../api";
import { Button, Card, EmptyState, ErrorNotice, PageHeader, Skeleton, fadeOnly, fadeUp, stagger, useToast } from "../design";
import { ConfirmDelete } from "../components/recordings/ConfirmDelete";
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
  const [archived, setArchived] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [d, arch] = await Promise.all([
        api.getRun(runId),
        api.listArchived("run").then((r) => r.items.some((i) => i.id === runId)).catch(() => false),
      ]);
      if (!mounted.current) return;
      setData(d);
      setArchived(arch);
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

  async function toggleArchive() {
    setArchiving(true);
    try {
      if (archived) await api.unarchive("run", runId);
      else await api.archive("run", runId);
      toast.success(archived ? "Run restored" : "Run archived", archived ? undefined : "Hidden from Run history.");
      await load();
    } catch (e) {
      toast.error("Could not update the run", e instanceof Error ? e.message : undefined);
    } finally {
      setArchiving(false);
    }
  }

  return (
    <motion.div className="rn-page" variants={stagger} initial="hidden" animate="show">
      <PageHeader
        eyebrow={`${kindLabel(s.runKind)} run`}
        title={s.clientRef ?? "Agent run"}
        subtitle={<span className="mono tiny rn-runid">{s.runId}</span>}
        onBack={goBack}
        backLabel="All runs"
        actions={
          <>
            <a className="ds-btn ds-btn-secondary ds-btn-sm" href={sessionHref(s.sessionId)}>
              Session review <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <Button size="sm" icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} loading={archiving} onClick={() => void toggleArchive()}>
              {archived ? "Unarchive" : "Archive"}
            </Button>
            <Button size="sm" variant="ghost" iconOnly aria-label="Delete run" title="Delete run" icon={<Trash2 size={14} />} disabled={active} onClick={() => setConfirm(true)} />
          </>
        }
      />
      <ConfirmDelete
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete run history?"
        summary={[
          { label: "Run", value: <span className="mono tiny">{s.runId}</span> },
          { label: "Kind", value: kindLabel(s.runKind) },
          { label: "Client", value: s.clientRef ?? "Unknown" },
          { label: "Events", value: String(s.eventCount) },
        ]}
        notes={[
          "Deletes this run's events from Run history.",
          s.runKind === "delivery"
            ? "Delivery runs can be deleted; the session and its files are not touched."
            : "A processing run is kept while its session exists (it is that draft's audit trail). Archive it instead, or delete the draft session.",
          "An audit entry (who, when, which run) is kept.",
        ]}
        onConfirm={async () => {
          await api.deleteRun(runId);
          toast.success("Run deleted");
          goBack();
        }}
        onArchiveInstead={async () => {
          await api.archive("run", runId);
          toast.success("Run archived", "Hidden from Run history.");
          await load();
        }}
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
