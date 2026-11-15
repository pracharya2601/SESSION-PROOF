import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Archive, ArchiveRestore, AudioLines, GanttChart, Lightbulb, ListOrdered, Trash2 } from "lucide-react";
import { api, ApiClientError } from "../api";
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader, Skeleton, fadeOnly, fadeUp, stagger, useToast } from "../design";
import { hrefs } from "../shell/routes";
import { usePoll } from "../components/runs/model";
import { ConfirmDelete } from "../components/recordings/ConfirmDelete";
import { SuggestionCard } from "../components/recordings/SuggestionCard";
import { Timeline, TONE_LABELS } from "../components/recordings/Timeline";
import {
  STATUS_LABEL,
  clockOf,
  dateOf,
  formatSpan,
  layoutTimeline,
  pendingSuggestions,
  pickOptions,
  recordingDurationMs,
  segmentText,
  segmentTone,
  suggestionBySegment,
} from "../components/recordings/model";
import type { RecordingDetailView, RecordingTimelineEvent } from "../components/recordings/types";
import { RecordingChips, recordingDeleteNotes, recordingSummary } from "../components/recordings/RecordingBits";
import "../components/recordings/recordings.css";

function goBack() {
  window.location.hash = hrefs.recordings;
}

export default function RecordingDetail({ recordingId }: { recordingId: string }) {
  const reduce = useReducedMotion();
  const toast = useToast();
  const [data, setData] = useState<RecordingDetailView | null>(null);
  const [events, setEvents] = useState<RecordingTimelineEvent[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busySug, setBusySug] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const mounted = useRef(true);
  const segRefs = useRef(new Map<number, HTMLLIElement>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [d, ev, arch] = await Promise.all([
        api.getRecording(recordingId),
        api.recordingEvents(recordingId).then((r) => r.events).catch(() => [] as RecordingTimelineEvent[]),
        api.listArchived("recording").then((r) => r.items.some((i) => i.id === recordingId)).catch(() => false),
      ]);
      if (!mounted.current) return;
      setData(d);
      setEvents(ev);
      setArchived(arch);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e);
    }
  }, [recordingId]);

  useEffect(() => {
    setData(null);
    void load();
    api
      .listClients()
      .then((c) => mounted.current && setClients(c.map((x) => x.client.clientRef)))
      .catch(() => undefined);
  }, [load]);

  const active = !!data && (data.recording.status === "recording" || data.recording.status === "stopped");
  usePoll(load, active, 4000, 150);

  const bySuggestion = useMemo(() => suggestionBySegment(data?.suggestions), [data]);
  const layout = useMemo(
    () => (data ? layoutTimeline({ recording: data.recording, segments: data.segments, events, suggestions: data.suggestions }) : null),
    [data, events],
  );
  const pending = pendingSuggestions(data?.suggestions);

  function select(index: number) {
    setSelected(index);
    segRefs.current.get(index)?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }

  async function decide(sid: string, fn: () => Promise<string | null>) {
    setBusySug(sid);
    try {
      const sessionId = await fn();
      if (sessionId) {
        toast.toast({
          title: "Assigned",
          description: "The segments were added to the session; it is being re-drafted.",
          tone: "success",
          action: { label: "Open session", onClick: () => (window.location.hash = hrefs.session(sessionId)) },
        });
      } else {
        toast.success("Suggestion rejected", "Those segments stay unassigned.");
      }
      await load();
    } catch (e) {
      toast.error("Could not update the suggestion", e instanceof ApiClientError ? `${e.message} (${e.code})` : undefined);
    } finally {
      if (mounted.current) setBusySug(null);
    }
  }

  async function toggleArchive() {
    setArchiving(true);
    try {
      if (archived) await api.unarchive("recording", recordingId);
      else await api.archive("recording", recordingId);
      toast.success(archived ? "Recording restored" : "Recording archived", archived ? undefined : "Hidden from the Recordings list.");
      await load();
    } catch (e) {
      toast.error("Could not update the recording", e instanceof Error ? e.message : undefined);
    } finally {
      setArchiving(false);
    }
  }

  const notFound = error instanceof ApiClientError && error.status === 404;
  const item = reduce ? fadeOnly : fadeUp;

  if (!data || !layout) {
    return (
      <div className="rc-page">
        <PageHeader eyebrow="Recording" title="Recording" onBack={goBack} backLabel="All recordings" />
        {notFound ? (
          <EmptyState icon={<AudioLines size={22} />} title="Recording not found" description="It may have been deleted, or it belongs to another account." />
        ) : error ? (
          <ErrorNotice error={error} onRetry={() => void load()} />
        ) : (
          <div className="stack" aria-busy="true">
            <Skeleton height={80} radius={16} />
            <Skeleton height={180} radius={16} />
            <Skeleton lines={5} />
          </div>
        )}
      </div>
    );
  }

  const r = data.recording;
  const sessionsByEvent = new Map((r.partition?.sessions ?? []).map((s) => [s.eventId, s]));

  return (
    <motion.div className="rc-page" variants={stagger} initial="hidden" animate="show">
      <PageHeader
        eyebrow={`Recording · ${STATUS_LABEL[r.status]}`}
        title={`${dateOf(r.startedAt)}, ${clockOf(r.startedAt)}${r.endedAt ? `–${clockOf(r.endedAt)}` : ""}`}
        subtitle={
          <span className="rc-chips">
            <span className="small muted">
              {formatSpan(recordingDurationMs(r))} · {r.transcriber === "deepgram" ? "Deepgram" : "Simulated"} · {r.segmentCount} segments
            </span>
            <RecordingChips recording={r} suggestions={pending.length} archived={archived} />
          </span>
        }
        onBack={goBack}
        backLabel="All recordings"
        actions={
          <>
            <Button size="sm" icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} loading={archiving} onClick={() => void toggleArchive()}>
              {archived ? "Unarchive" : "Archive"}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={r.status === "recording"} onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </>
        }
      />

      {error !== null && <ErrorNotice error={error} title="Refresh failed" onRetry={() => void load()} />}

      <motion.div variants={item}>
        <Card as="section" padding="md" aria-labelledby="rc-tl-h">
          <h2 id="rc-tl-h" className="rc-h2">
            <GanttChart size={16} aria-hidden="true" /> Timeline
          </h2>
          {layout.lanes.length === 0 ? (
            <p className="small muted">No segments yet.</p>
          ) : (
            <Timeline layout={layout} selected={selected} onSelect={select} />
          )}
        </Card>
      </motion.div>

      {pending.length > 0 && (
        <motion.div variants={item}>
          <section aria-labelledby="rc-sug-h">
            <h2 id="rc-sug-h" className="rc-h2">
              <Lightbulb size={16} aria-hidden="true" /> Suggestions <span className="tiny muted">{pending.length}</span>
            </h2>
            <div className="rc-sugs">
              {pending.map((s) => (
                <SuggestionCard
                  key={s.id}
                  s={s}
                  busy={busySug === s.id}
                  options={pickOptions(
                    events.filter((e) => !e.dismissed),
                    [...(s.candidateClientRefs ?? []), ...clients],
                    { eventId: s.eventId, clientRef: s.eventId ? null : s.suggestedClientRef },
                  )}
                  onAccept={(body) =>
                    void decide(s.id, async () => (await api.acceptSuggestion(r.id, s.id, body ?? {})).sessionId)
                  }
                  onReject={() =>
                    void decide(s.id, async () => {
                      await api.rejectSuggestion(r.id, s.id);
                      return null;
                    })
                  }
                />
              ))}
            </div>
          </section>
        </motion.div>
      )}

      <motion.div variants={item}>
        <Card as="section" padding="md" aria-labelledby="rc-seg-h">
          <h2 id="rc-seg-h" className="rc-h2">
            <ListOrdered size={16} aria-hidden="true" /> Transcript <span className="tiny muted">{data.segments.length}</span>
          </h2>
          {data.segments.length === 0 ? (
            <p className="small muted">No transcript segments.</p>
          ) : (
            <ol className="rc-segs">
              {data.segments.map((s) => {
                const tone = segmentTone(s, bySuggestion);
                const text = segmentText(s, tone);
                const a = s.assignment;
                const sess = a.status === "assigned" ? (a.sessionId ? { sessionId: a.sessionId, clientRef: a.clientRef } : sessionsByEvent.get(a.eventId) ?? null) : null;
                return (
                  <li
                    key={s.index}
                    ref={(el) => {
                      if (el) segRefs.current.set(s.index, el);
                      else segRefs.current.delete(s.index);
                    }}
                    className={`rc-seg${selected === s.index ? " is-selected" : ""}`}
                    onClick={() => setSelected(s.index)}
                  >
                    <span className={`rc-seg-dot rc-tone-${tone}`} aria-hidden="true" />
                    <div>
                      <div className="rc-seg-head">
                        <span className="mono tabular">
                          {clockOf(s.observedFrom)}–{clockOf(s.observedTo)}
                        </span>
                        {s.speaker && <span>{s.speaker}</span>}
                        {sess ? (
                          <a href={hrefs.session(sess.sessionId)}>
                            <Badge tone="success">{sess.clientRef ?? "Session"}</Badge>
                          </a>
                        ) : (
                          <Badge tone={tone === "suggested" ? "info" : tone === "ambiguous" ? "warning" : "neutral"}>{TONE_LABELS[tone]}</Badge>
                        )}
                      </div>
                      {text.kind === "text" ? (
                        <p className="rc-seg-text">{text.text}</p>
                      ) : text.kind === "deleted" ? (
                        <p className="rc-seg-text is-muted">Text deleted after 24 h.</p>
                      ) : (
                        <p className="rc-seg-text is-muted">Text not shown: this segment is not assigned to a session.</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </motion.div>

      <ConfirmDelete
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete recording?"
        summary={recordingSummary(r)}
        notes={recordingDeleteNotes(r)}
        onConfirm={async () => {
          await api.deleteRecording(r.id);
          toast.success("Recording deleted");
          goBack();
        }}
      />
    </motion.div>
  );
}
