import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Archive, ArchiveRestore, AudioLines, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import type { Recording } from "../../contracts";
import { api } from "../api";
import { Button, EmptyState, ErrorNotice, PageHeader, Skeleton, Switch, fadeOnly, fadeUp, stagger, useToast } from "../design";
import { hrefs } from "../shell/routes";
import { usePoll } from "../components/runs/model";
import { ConfirmDelete } from "../components/recordings/ConfirmDelete";
import { RecordingChips, recordingDeleteNotes, recordingSummary } from "../components/recordings/RecordingBits";
import {
  STATUS_LABEL,
  clockOf,
  dateOf,
  formatSpan,
  pendingSuggestions,
  recordingDurationMs,
  transcriberLabel,
} from "../components/recordings/model";
import "../components/recordings/recordings.css";

interface Row {
  recording: Recording;
  archived: boolean;
}

const DETAIL_PREFETCH = 25;

export default function Recordings() {
  const reduce = useReducedMotion();
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Recording | null>(null);
  const token = useRef(0);

  const load = useCallback(async () => {
    const t = ++token.current;
    try {
      const [live, archived] = await Promise.all([
        api.listRecordings(),
        showArchived ? api.listArchived("recording").then((r) => r.items) : Promise.resolve([]),
      ]);
      if (t !== token.current) return;
      const arch = archived.filter((i) => i.recording).map((i) => ({ recording: i.recording!, archived: true }));
      const all = [...live.map((recording) => ({ recording, archived: false })), ...arch].sort((a, b) =>
        b.recording.startedAt.localeCompare(a.recording.startedAt),
      );
      setRows(all);
      setError(null);
    } catch (e) {
      if (t === token.current) setError(e);
    }
  }, [showArchived]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  // Pending suggestion counts need each recording's detail: fetch for the newest partitioned ones.
  const wanted = useMemo(
    () => (rows ?? []).filter((r) => r.recording.status === "partitioned").slice(0, DETAIL_PREFETCH).map((r) => r.recording.id),
    [rows],
  );
  useEffect(() => {
    let live = true;
    const missing = wanted.filter((id) => !(id in suggestions));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map((id) =>
        api
          .getRecording(id)
          .then((d) => [id, pendingSuggestions(d.suggestions).length] as const)
          .catch(() => [id, -1] as const),
      ),
    ).then((pairs) => {
      if (!live) return;
      setSuggestions((prev) => {
        const next = { ...prev };
        for (const [id, n] of pairs) next[id] = n;
        return next;
      });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const active = !!rows?.some((r) => r.recording.status === "recording" || r.recording.status === "stopped");
  usePoll(load, active, 5000, 120);

  async function refresh() {
    setRefreshing(true);
    setSuggestions({});
    await load();
    setRefreshing(false);
  }

  async function toggleArchive(r: Row) {
    setBusy(r.recording.id);
    try {
      if (r.archived) {
        await api.unarchive("recording", r.recording.id);
        toast.success("Recording restored");
      } else {
        await api.archive("recording", r.recording.id);
        toast.toast({
          title: "Recording archived",
          description: "Hidden from the list. Turn on Show archived to find it.",
          tone: "info",
          action: { label: "Undo", onClick: () => void api.unarchive("recording", r.recording.id).then(load) },
        });
      }
      await load();
    } catch (e) {
      toast.error("Could not update the recording", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  const item = reduce ? fadeOnly : fadeUp;

  return (
    <div className="rc-page">
      <PageHeader
        eyebrow="Band"
        title="Recordings"
        subtitle="Every band recording and how the calendar split it into sessions."
        actions={
          <Button size="sm" icon={<RefreshCw size={14} className={refreshing ? "ds-spin" : undefined} />} onClick={() => void refresh()} disabled={refreshing}>
            Refresh
          </Button>
        }
      />
      <div className="rc-toolbar">
        <span className="small muted">{rows ? `${rows.filter((r) => !r.archived).length} recording${rows.filter((r) => !r.archived).length === 1 ? "" : "s"}` : ""}</span>
        <Switch checked={showArchived} onChange={setShowArchived} label="Show archived" />
      </div>

      {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}

      {rows === null && error === null ? (
        <div className="rc-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rc-row">
              <div className="stack-sm">
                <Skeleton width="35%" height={14} />
                <Skeleton width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : rows && rows.length === 0 ? (
        <EmptyState
          icon={<AudioLines size={22} />}
          title={showArchived ? "No recordings" : "No recordings yet"}
          description="Recordings from a paired phone appear here once the band starts recording."
        />
      ) : rows ? (
        <motion.ul className="rc-list" variants={stagger} initial="hidden" animate="show" aria-label="Recordings">
          {rows.map((r) => {
            const rec = r.recording;
            const n = suggestions[rec.id];
            return (
              <motion.li key={rec.id} variants={item} className={`rc-row${r.archived ? " is-archived" : ""}`}>
                <a className="rc-row-link" href={hrefs.recording(rec.id)}>
                  <span className="rc-row-title">
                    <span>
                      {dateOf(rec.startedAt)}, {clockOf(rec.startedAt)}
                      {rec.endedAt ? `–${clockOf(rec.endedAt)}` : ""}
                    </span>
                    <span className="small muted tabular">{formatSpan(recordingDurationMs(rec))}</span>
                  </span>
                  <span className="rc-row-meta">
                    <span>{transcriberLabel(rec.transcriber)}</span>
                    <span>{STATUS_LABEL[rec.status]}</span>
                    {rec.bandNumber != null && <span>Band {rec.bandNumber}</span>}
                    <RecordingChips recording={rec} suggestions={n === undefined || n < 0 ? null : n} archived={r.archived} />
                  </span>
                </a>
                <div className="rc-row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={r.archived ? "Unarchive recording" : "Archive recording"}
                    title={r.archived ? "Unarchive" : "Archive"}
                    icon={r.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                    loading={busy === rec.id}
                    onClick={() => void toggleArchive(r)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label="Delete recording"
                    title="Delete"
                    icon={<Trash2 size={15} />}
                    disabled={rec.status === "recording"}
                    onClick={() => setConfirm(rec)}
                  />
                  <a href={hrefs.recording(rec.id)} className="ds-btn ds-btn-ghost ds-btn-sm ds-btn-icon" aria-hidden="true" tabIndex={-1}>
                    <ChevronRight size={16} />
                  </a>
                </div>
              </motion.li>
            );
          })}
        </motion.ul>
      ) : null}

      {confirm && (
        <ConfirmDelete
          open={!!confirm}
          onClose={() => setConfirm(null)}
          title="Delete recording?"
          summary={recordingSummary(confirm)}
          notes={recordingDeleteNotes(confirm)}
          onConfirm={async () => {
            await api.deleteRecording(confirm.id);
            toast.success("Recording deleted");
            await load();
          }}
        />
      )}
    </div>
  );
}
