import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  BadgeDollarSign,
  CalendarClock,
  CheckCheck,
  ClipboardPen,
  Clock3,
  Database,
  Hourglass,
  Inbox,
  RefreshCw,
  Sparkles,
  TimerReset,
} from "lucide-react";
import type { SessionStatus, SessionSummary, SyncSettingsView } from "../../contracts";
import { api, ApiClientError } from "../api";
import { ErrorNotice } from "../components/ErrorNotice";
import { formatCents, formatTimeRange } from "../components/format";
import {
  ACTIVE_STATUSES,
  AnimatedNumber,
  Badge,
  Button,
  Card,
  Celebration,
  EmptyState,
  PageHeader,
  REASON_STATUSES,
  Skeleton,
  StatusPill,
  fadeOnly,
  fadeUp,
  springy,
  stagger,
  useToast,
} from "../design";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX = 40;

function isEstimate(s: SessionSummary): boolean {
  const flag = (s as SessionSummary & { isEstimate?: unknown }).isEstimate;
  if (typeof flag === "boolean") return flag;
  return !(s.status === "APPROVED" || s.status === "COMPLETED" || s.canApprove === true);
}

function hasActive(list: SessionSummary[]): boolean {
  return list.some((s) => ACTIVE_STATUSES.has(s.status));
}

function startOfWeek(now = new Date()): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

type Group = "attention" | "progress" | "done";
const GROUP_OF: Record<SessionStatus, Group> = {
  NEEDS_REVIEW: "attention",
  NO_EVIDENCE: "attention",
  AMBIGUOUS_MATCH: "attention",
  INCOMPLETE: "attention",
  FAILED: "attention",
  SCHEDULED: "progress",
  WAITING_FOR_EVIDENCE: "progress",
  QUEUED: "progress",
  PROCESSING: "progress",
  APPROVED: "progress",
  COMPLETED: "done",
};
const GROUPS: { id: Group; title: string; hint: string }[] = [
  { id: "attention", title: "Needs you", hint: "Review drafts and resolve issues" },
  { id: "progress", title: "In progress", hint: "Scheduled, processing or finalizing" },
  { id: "done", title: "Completed", hint: "Approved and finalized" },
];

function syncChipText(v: SyncSettingsView | null): string {
  if (!v) return "Auto-sync: …";
  if (!v.settings.enabled) return "Auto-sync: off";
  const m = v.settings.intervalMinutes;
  const every = m % 60 === 0 ? (m === 60 ? "every hour" : m === 1440 ? "daily" : `every ${m / 60} h`) : `every ${m} min`;
  const next = v.nextRunAt
    ? new Date(v.nextRunAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;
  return `Auto-sync: ${every}${next ? ` · next ${next}` : ""}`;
}

function apiErrorDetail(err: unknown): string {
  if (err instanceof ApiClientError) return err.message + (err.correlationId ? ` (correlation ID ${err.correlationId})` : "");
  return err instanceof Error ? err.message : "Something went wrong.";
}

export default function Today({ devMode }: { devMode: boolean }) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [load, setLoad] = useState<{ kind: "loading" } | { kind: "ready" } | { kind: "error"; error: unknown }>({
    kind: "loading",
  });
  const [pollError, setPollError] = useState<unknown>(null);
  const [polling, setPolling] = useState(false);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncView, setSyncView] = useState<SyncSettingsView | null>(null);
  const [celebrate, setCelebrate] = useState<Record<string, number>>({});

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCount = useRef(0);
  const mounted = useRef(true);
  const prevStatus = useRef<Map<string, SessionStatus> | null>(null);

  /** Applies a fresh list, detecting sessions that just became COMPLETED. */
  const apply = useCallback(
    (list: SessionSummary[]) => {
      const prev = prevStatus.current;
      if (prev) {
        const done = list.filter((s) => s.status === "COMPLETED" && prev.has(s.id) && prev.get(s.id) !== "COMPLETED");
        if (done.length) {
          setCelebrate((c) => {
            const n = { ...c };
            for (const s of done) n[s.id] = (n[s.id] ?? 0) + 1;
            return n;
          });
          for (const s of done) toast.success("Session completed", `Client ${s.clientRef} is finalized — files are ready.`);
        }
      }
      prevStatus.current = new Map(list.map((s) => [s.id, s.status]));
      setSessions(list);
    },
    [toast],
  );

  const fetchAll = useCallback(async (): Promise<SessionSummary[]> => {
    const all: SessionSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await api.listSessions(cursor);
      all.push(...res.sessions);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return all;
  }, []);

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPolling(false);
  }, []);

  const scheduleTick = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      if (!mounted.current) return;
      pollCount.current += 1;
      let list: SessionSummary[] | null = null;
      try {
        list = await fetchAll();
        if (!mounted.current) return;
        apply(list);
        setPollError(null);
        setLoad({ kind: "ready" });
      } catch (err) {
        if (!mounted.current) return;
        setPollError(err);
      }
      const keepGoing = list === null || hasActive(list);
      if (keepGoing && pollCount.current < POLL_MAX) {
        scheduleTick();
      } else {
        setPolling(false);
        if (keepGoing) setPollExhausted(true);
      }
    }, POLL_INTERVAL_MS);
  }, [fetchAll, apply]);

  /** Starts a fresh bounded polling run if any session is still moving. */
  const maybeStartPolling = useCallback(
    (list: SessionSummary[], force = false) => {
      if (force || hasActive(list)) {
        pollCount.current = 0;
        setPollExhausted(false);
        setPolling(true);
        scheduleTick();
      } else {
        stopPolling();
      }
    },
    [scheduleTick, stopPolling],
  );

  const refresh = useCallback(async () => {
    setLoad((l) => (l.kind === "ready" ? l : { kind: "loading" }));
    try {
      const list = await fetchAll();
      if (!mounted.current) return;
      apply(list);
      setLoad({ kind: "ready" });
      setPollError(null);
      maybeStartPolling(list);
    } catch (err) {
      if (!mounted.current) return;
      setLoad({ kind: "error", error: err });
      stopPolling();
    }
  }, [fetchAll, apply, maybeStartPolling, stopPolling]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    api
      .getSyncSettings()
      .then((v) => mounted.current && setSyncView(v))
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSeed() {
    setSeeding(true);
    try {
      await api.seed();
      toast.success("Demo data seeded", "Press Sync now to discover and process sessions.");
      await refresh();
    } catch (err) {
      toast.error("Seed failed", apiErrorDetail(err));
    } finally {
      setSeeding(false);
    }
  }

  async function onSync() {
    setSyncing(true);
    try {
      const res = await api.sync();
      const d = res.discovery;
      const parts: string[] = [];
      if (d) parts.push(`${d.examined} examined, ${d.created} new, ${d.enqueued} queued`);
      if (res.dispatch) parts.push(`${res.dispatch.succeeded} dispatched`);
      toast.success("Sync started", parts.length ? parts.join(" · ") : "Looking for finished visits.");
      const list = await fetchAll().catch(() => null);
      if (list && mounted.current) {
        apply(list);
        setLoad({ kind: "ready" });
      }
      // Sync is asynchronous (202): poll so new work becomes visible.
      maybeStartPolling(list ?? sessions, true);
    } catch (err) {
      toast.error("Sync failed", apiErrorDetail(err));
    } finally {
      setSyncing(false);
    }
  }

  const stats = useMemo(() => {
    const weekStart = startOfWeek();
    let review = 0;
    let finalizing = 0;
    let completedWeek = 0;
    let approvedCents = 0;
    for (const s of sessions) {
      if (s.status === "NEEDS_REVIEW") review++;
      if (s.status === "APPROVED") finalizing++;
      if (s.status === "COMPLETED" && Date.parse(s.startAt) >= weekStart) completedWeek++;
      if ((s.status === "APPROVED" || s.status === "COMPLETED") && s.amountCents != null) approvedCents += s.amountCents;
    }
    return { review, finalizing, completedWeek, approvedCents };
  }, [sessions]);

  const grouped = useMemo(() => {
    const g: Record<Group, SessionSummary[]> = { attention: [], progress: [], done: [] };
    for (const s of sessions) g[GROUP_OF[s.status] ?? "progress"].push(s);
    return g;
  }, [sessions]);

  const backendDown =
    load.kind === "error" &&
    (!(load.error instanceof ApiClientError) || load.error.code === "NETWORK" || load.error.status >= 500);

  const item = reduce ? fadeOnly : fadeUp;
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <section aria-labelledby="today-heading" className="today">
      <PageHeader
        eyebrow={today}
        title={<span id="today-heading">Today's sessions</span>}
        subtitle="Drafts are prepared from visit evidence. Review, correct and approve — we handle the paperwork."
        actions={
          <>
            {devMode && (
              <Button variant="secondary" icon={<Database size={16} />} loading={seeding} onClick={() => void onSeed()}>
                {seeding ? "Seeding…" : "Seed demo data"}
              </Button>
            )}
            <Button variant="primary" icon={<RefreshCw size={16} />} loading={syncing} onClick={() => void onSync()}>
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </>
        }
      />

      <div className="today-strip">
        <a className="sync-chip" href="#/settings" aria-label={`${syncChipText(syncView)}. Change in Settings.`}>
          <TimerReset size={14} aria-hidden="true" />
          <span>{syncChipText(syncView)}</span>
          <ArrowRight size={12} aria-hidden="true" className="sync-chip-arrow" />
        </a>
        <AnimatePresence>
          {polling && (
            <motion.span
              className="live-chip"
              role="status"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
            >
              <span className="live-dot" aria-hidden="true" /> Checking for updates
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <motion.div className="hero" variants={stagger} initial="hidden" animate="show" aria-busy={load.kind === "loading"}>
        <Stat
          variants={item}
          icon={<ClipboardPen size={18} />}
          label="Needs review"
          tone="accent"
          loading={load.kind === "loading"}
          value={<AnimatedNumber value={stats.review} />}
        />
        <Stat
          variants={item}
          icon={<Hourglass size={18} />}
          label="Awaiting finalization"
          tone="info"
          loading={load.kind === "loading"}
          value={<AnimatedNumber value={stats.finalizing} />}
        />
        <Stat
          variants={item}
          icon={<CheckCheck size={18} />}
          label="Completed this week"
          tone="success"
          loading={load.kind === "loading"}
          value={<AnimatedNumber value={stats.completedWeek} />}
        />
        <Stat
          variants={item}
          icon={<BadgeDollarSign size={18} />}
          label="Approved amount"
          tone="warning"
          loading={load.kind === "loading"}
          value={<AnimatedNumber value={stats.approvedCents} format="cents" />}
          wide
        />
      </motion.div>

      <div aria-live="polite" className="stack-sm today-notices">
        {pollError != null && (
          <div className="warn-box small" role="status">
            Couldn't refresh just now ({pollError instanceof ApiClientError ? pollError.message : "network error"}
            {pollError instanceof ApiClientError && pollError.correlationId && (
              <>
                , correlation ID <span className="mono">{pollError.correlationId}</span>
              </>
            )}
            ). {polling ? "Retrying automatically." : ""}
          </div>
        )}
        {pollExhausted && !polling && (
          <div className="warn-box small row-between">
            <span>Some sessions are still in progress. Automatic refresh stopped.</span>
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
        )}
      </div>

      {load.kind === "loading" && (
        <div className="session-grid" aria-busy="true" aria-label="Loading sessions">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="ds-card ds-pad-md session-skel">
              <div className="row-between">
                <Skeleton width="45%" height={18} />
                <Skeleton width={96} height={24} radius={999} />
              </div>
              <Skeleton lines={2} height={12} />
              <div className="row-between">
                <Skeleton width={90} height={22} />
                <Skeleton width={92} height={32} radius={8} />
              </div>
            </div>
          ))}
        </div>
      )}

      {load.kind === "error" && (
        <ErrorNotice
          title={backendDown ? "Backend unavailable" : "Could not load sessions"}
          error={load.error}
          onRetry={() => void refresh()}
        />
      )}

      {load.kind === "ready" && sessions.length === 0 && (
        <Card padding="none">
          <EmptyState
            icon={<Inbox size={26} />}
            title="No sessions yet"
            description={
              devMode
                ? "Seed the synthetic demo data, then press Sync now to discover and process sessions."
                : "Press Sync now to discover sessions from your calendar."
            }
            action={
              <>
                {devMode && (
                  <Button icon={<Database size={16} />} loading={seeding} onClick={() => void onSeed()}>
                    Seed demo data
                  </Button>
                )}
                <Button variant="primary" icon={<RefreshCw size={16} />} loading={syncing} onClick={() => void onSync()}>
                  Sync now
                </Button>
              </>
            }
          />
        </Card>
      )}

      {sessions.length > 0 && load.kind !== "error" && (
        <LayoutGroup>
          {GROUPS.map((g) => {
            const list = grouped[g.id];
            if (list.length === 0) return null;
            return (
              <motion.section key={g.id} layout={!reduce} className="session-group" aria-labelledby={`grp-${g.id}`}>
                <motion.div layout={!reduce ? "position" : false} className="group-head">
                  <h2 id={`grp-${g.id}`}>
                    {g.title} <span className="group-count">{list.length}</span>
                  </h2>
                  <span className="subtle small">{g.hint}</span>
                </motion.div>
                <motion.ul className="session-grid" aria-label={g.title} variants={stagger} initial="hidden" animate="show">
                  <AnimatePresence initial={false} mode="popLayout">
                    {list.map((s) => (
                      <SessionCard key={s.id} s={s} burst={celebrate[s.id] ?? 0} />
                    ))}
                  </AnimatePresence>
                </motion.ul>
              </motion.section>
            );
          })}
        </LayoutGroup>
      )}
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  loading,
  wide,
  variants,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone: "accent" | "info" | "success" | "warning";
  loading: boolean;
  wide?: boolean;
  variants: typeof fadeUp;
}) {
  return (
    <motion.div variants={variants} className={`stat stat-${tone}${wide ? " stat-wide" : ""}`}>
      <span className="stat-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{loading ? <Skeleton width={wide ? 120 : 48} height={30} radius={8} /> : value}</span>
    </motion.div>
  );
}

function SessionCard({ s, burst }: { s: SessionSummary; burst: number }) {
  const reduce = useReducedMotion();
  const estimate = isEstimate(s);
  const href = `#/sessions/${encodeURIComponent(s.id)}`;
  const showReason = REASON_STATUSES.has(s.status) && s.statusReason;
  const cta = s.status === "NEEDS_REVIEW" ? "Review" : s.status === "COMPLETED" ? "Open" : "Review";
  return (
    <motion.li
      layout={!reduce}
      layoutId={reduce ? undefined : `session-${s.id}`}
      variants={reduce ? fadeOnly : fadeUp}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={springy}
      className="session-li"
    >
      <Card
        interactive
        className={`session-card status-${s.status}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,button")) return;
          window.location.hash = href;
        }}
      >
        <Celebration trigger={burst || null} />
        <div className="sc-head">
          <div className="sc-client">
            <span className="sc-label">Client</span>
            <h3 className="mono sc-ref">{s.clientRef}</h3>
          </div>
          <StatusPill status={s.status} />
        </div>
        <div className="sc-meta">
          <span className="sc-meta-item">
            <CalendarClock size={14} aria-hidden="true" />
            {formatTimeRange(s.startAt, s.endAt, s.timezone)}
          </span>
          <span className="sc-meta-item subtle">
            <Clock3 size={14} aria-hidden="true" />
            Service <span className="mono">{s.serviceCode}</span>
          </span>
          {(s.evidenceMode === "fixture" || s.extractionMode === "fixture") && (
            <span className="sc-meta-item">
              <Badge tone="fixture" icon={<Sparkles size={11} />}>
                Synthetic
              </Badge>
            </span>
          )}
        </div>
        {showReason && (
          <p className={s.status === "FAILED" ? "error-box small sc-reason" : "warn-box small sc-reason"}>{s.statusReason}</p>
        )}
        <div className="sc-foot">
          <div className="sc-amount">
            {s.amountCents == null ? (
              <span className="subtle small">Amount not available</span>
            ) : (
              <>
                <span className="amount sc-amount-value">{formatCents(s.amountCents)}</span>
                {estimate ? (
                  <Badge tone="warning">Estimate</Badge>
                ) : (
                  <Badge tone="success" dot>
                    Confirmed
                  </Badge>
                )}
              </>
            )}
          </div>
          <a className={s.status === "NEEDS_REVIEW" ? "ds-btn ds-btn-primary ds-btn-sm" : "ds-btn ds-btn-secondary ds-btn-sm"} href={href}>
            {cta}
            <span className="sr-only"> session for client {s.clientRef}</span>
            <ArrowRight size={14} aria-hidden="true" />
          </a>
        </div>
      </Card>
    </motion.li>
  );
}
