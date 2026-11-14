import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Activity, CalendarCheck2, ChevronRight } from "lucide-react";
import type { RunSummary, SessionSummary } from "../../../contracts";
import { api } from "../../api";
import { Badge, type BadgeTone, Button, EmptyState, ErrorNotice, Skeleton, StatusPill, fadeOnly, fadeUp, stagger } from "../../design";
import { formatCents, formatTimeRange } from "../format";
import { hrefs } from "../../shell/routes";
import { Section } from "./ClientForm";

const MAX_PAGES = 5;

/** Walks list pages (bounded) collecting items that match the client ref. */
async function collect<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; next: string | null }>,
  keep: (t: T) => boolean,
  cursor?: string,
): Promise<{ items: T[]; next: string | null }> {
  const out: T[] = [];
  let next: string | null = null;
  let cur = cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPage(cur);
    out.push(...page.items.filter(keep));
    next = page.next;
    if (!next) break;
    cur = next;
  }
  return { items: out, next };
}

const RUN_TONE: Record<RunSummary["status"], BadgeTone> = { running: "info", waiting: "warning", succeeded: "success", failed: "danger" };
const RUN_LABEL: Record<RunSummary["status"], string> = { running: "Running", waiting: "Waiting", succeeded: "Succeeded", failed: "Failed" };

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
function duration(ms: number | null): string | null {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ClientActivity({ clientRef }: { clientRef: string }) {
  const reduce = useReducedMotion();
  const v = reduce ? fadeOnly : fadeUp;

  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sCursor, setSCursor] = useState<string | null>(null);
  const [sErr, setSErr] = useState<unknown>(null);
  const [sMore, setSMore] = useState(false);

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [rCursor, setRCursor] = useState<string | null>(null);
  const [rErr, setRErr] = useState<unknown>(null);
  const [rMore, setRMore] = useState(false);

  const fetchSessions = useCallback(
    (cursor?: string) =>
      collect(
        (c) => api.listSessions(c).then((r) => ({ items: r.sessions, next: r.nextCursor })),
        (s) => s.clientRef === clientRef,
        cursor,
      ),
    [clientRef],
  );
  const fetchRuns = useCallback(
    (cursor?: string) =>
      collect(
        (c) => api.listRuns({ cursor: c }).then((r) => ({ items: r.runs, next: r.nextCursor })),
        (r) => r.clientRef === clientRef,
        cursor,
      ),
    [clientRef],
  );

  const loadSessions = useCallback(() => {
    setSErr(null);
    setSessions(null);
    fetchSessions()
      .then((r) => {
        setSessions(r.items);
        setSCursor(r.next);
      })
      .catch(setSErr);
  }, [fetchSessions]);
  const loadRuns = useCallback(() => {
    setRErr(null);
    setRuns(null);
    fetchRuns()
      .then((r) => {
        setRuns(r.items);
        setRCursor(r.next);
      })
      .catch(setRErr);
  }, [fetchRuns]);
  useEffect(loadSessions, [loadSessions]);
  useEffect(loadRuns, [loadRuns]);

  async function moreSessions() {
    if (!sCursor) return;
    setSMore(true);
    try {
      const r = await fetchSessions(sCursor);
      setSessions((p) => {
        const seen = new Set((p ?? []).map((x) => x.id));
        return [...(p ?? []), ...r.items.filter((x) => !seen.has(x.id))];
      });
      setSCursor(r.next);
    } catch (e) {
      setSErr(e);
    } finally {
      setSMore(false);
    }
  }
  async function moreRuns() {
    if (!rCursor) return;
    setRMore(true);
    try {
      const r = await fetchRuns(rCursor);
      setRuns((p) => {
        const seen = new Set((p ?? []).map((x) => x.runId));
        return [...(p ?? []), ...r.items.filter((x) => !seen.has(x.runId))];
      });
      setRCursor(r.next);
    } catch (e) {
      setRErr(e);
    } finally {
      setRMore(false);
    }
  }

  return (
    <div className="cl-activity">
      <Section icon={<CalendarCheck2 size={18} aria-hidden="true" />} title="Sessions" subtitle="This client's sessions — open one to review or approve.">
        {sErr != null && <ErrorNotice title="Couldn't load sessions" error={sErr} onRetry={loadSessions} />}
        {sessions == null && sErr == null && (
          <div className="stack-sm" aria-busy="true" aria-label="Loading sessions">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={56} radius={12} />
            ))}
          </div>
        )}
        {sessions && sessions.length === 0 && (
          <EmptyState compact icon={<CalendarCheck2 size={22} />} title="No sessions found" description={sCursor ? "None in the most recent pages — load more to search further." : "Sessions for this client ref will appear here."} />
        )}
        {sessions && sessions.length > 0 && (
          <motion.ul className="cl-rows" variants={stagger} initial="hidden" animate="show">
            {sessions.map((s) => (
              <motion.li key={s.id} variants={v}>
                <a className="cl-row-link" href={hrefs.session(s.id)}>
                  <span className="cl-row-main">
                    <span className="cl-row-title">{formatTimeRange(s.startAt, s.endAt, s.timezone)}</span>
                    <span className="cl-row-sub subtle small mono">
                      {s.serviceCode}
                      {s.amountCents != null ? ` · ${formatCents(s.amountCents)}` : ""}
                    </span>
                  </span>
                  <StatusPill status={s.status} size="sm" />
                  <ChevronRight size={16} aria-hidden="true" className="cl-row-chev" />
                </a>
              </motion.li>
            ))}
          </motion.ul>
        )}
        {sessions && sCursor && (
          <div>
            <Button size="sm" variant="secondary" loading={sMore} onClick={() => void moreSessions()}>
              Load more
            </Button>
          </div>
        )}
      </Section>

      <Section icon={<Activity size={18} aria-hidden="true" />} title="Recent runs" subtitle="Processing and delivery runs for this client's sessions.">
        {rErr != null && <ErrorNotice title="Couldn't load runs" error={rErr} onRetry={loadRuns} />}
        {runs == null && rErr == null && (
          <div className="stack-sm" aria-busy="true" aria-label="Loading runs">
            {[0, 1].map((i) => (
              <Skeleton key={i} height={56} radius={12} />
            ))}
          </div>
        )}
        {runs && runs.length === 0 && (
          <EmptyState compact icon={<Activity size={22} />} title="No runs yet" description={rCursor ? "None in the most recent pages — load more to search further." : "Runs appear when this client's sessions are processed or delivered."} />
        )}
        {runs && runs.length > 0 && (
          <motion.ul className="cl-rows" variants={stagger} initial="hidden" animate="show">
            {runs.map((r) => (
              <motion.li key={r.runId} variants={v}>
                <a className="cl-row-link" href={hrefs.run(r.runId)}>
                  <span className="cl-row-main">
                    <span className="cl-row-title">
                      {r.runKind === "delivery" ? "Delivery" : "Processing"} · {when(r.startedAt)}
                    </span>
                    <span className="cl-row-sub subtle small">
                      {r.currentStage.replace(/_/g, " ")}
                      {duration(r.durationMs) ? ` · ${duration(r.durationMs)}` : ""}
                      {r.model ? ` · ${r.model}` : ""}
                    </span>
                  </span>
                  <Badge tone={RUN_TONE[r.status]} dot={r.status === "running"}>
                    {RUN_LABEL[r.status]}
                  </Badge>
                  <ChevronRight size={16} aria-hidden="true" className="cl-row-chev" />
                </a>
              </motion.li>
            ))}
          </motion.ul>
        )}
        {runs && rCursor && (
          <div>
            <Button size="sm" variant="secondary" loading={rMore} onClick={() => void moreRuns()}>
              Load more
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}
