import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../contracts";
import { api, ApiClientError } from "../api";
import { ErrorNotice } from "../components/ErrorNotice";
import { ACTIVE_STATUSES, REASON_STATUSES, StatusChip } from "../components/StatusChip";
import { formatCents, formatTimeRange } from "../components/format";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX = 40;

type ActionState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "error"; error: unknown };

function isEstimate(s: SessionSummary): boolean {
  const flag = (s as SessionSummary & { isEstimate?: unknown }).isEstimate;
  if (typeof flag === "boolean") return flag;
  return !(s.status === "APPROVED" || s.status === "COMPLETED" || s.canApprove === true);
}

function hasActive(list: SessionSummary[]): boolean {
  return list.some((s) => ACTIVE_STATUSES.has(s.status));
}

export default function Today({ devMode }: { devMode: boolean }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [load, setLoad] = useState<{ kind: "loading" } | { kind: "ready" } | { kind: "error"; error: unknown }>({
    kind: "loading",
  });
  const [pollError, setPollError] = useState<unknown>(null);
  const [polling, setPolling] = useState(false);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [seedState, setSeedState] = useState<ActionState>({ kind: "idle" });
  const [syncState, setSyncState] = useState<ActionState>({ kind: "idle" });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCount = useRef(0);
  const mounted = useRef(true);

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
        setSessions(list);
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
  }, [fetchAll]);

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
      setSessions(list);
      setLoad({ kind: "ready" });
      setPollError(null);
      maybeStartPolling(list);
    } catch (err) {
      if (!mounted.current) return;
      setLoad({ kind: "error", error: err });
      stopPolling();
    }
  }, [fetchAll, maybeStartPolling, stopPolling]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSeed() {
    setSeedState({ kind: "busy" });
    try {
      await api.seed();
      setSeedState({ kind: "ok", message: "Demo data seeded." });
      await refresh();
    } catch (err) {
      setSeedState({ kind: "error", error: err });
    }
  }

  async function onSync() {
    setSyncState({ kind: "busy" });
    try {
      const res = await api.sync();
      const d = res.discovery;
      const parts: string[] = [];
      if (d) parts.push(`${d.examined} examined, ${d.created} new, ${d.enqueued} queued`);
      if (res.dispatch) parts.push(`${res.dispatch.succeeded} dispatched`);
      setSyncState({ kind: "ok", message: "Sync started" + (parts.length ? ` — ${parts.join("; ")}.` : ".") });
      const list = await fetchAll().catch(() => null);
      if (list && mounted.current) {
        setSessions(list);
        setLoad({ kind: "ready" });
      }
      // Sync is asynchronous (202): poll so new work becomes visible.
      maybeStartPolling(list ?? sessions, true);
    } catch (err) {
      setSyncState({ kind: "error", error: err });
    }
  }

  const backendDown =
    load.kind === "error" &&
    (!(load.error instanceof ApiClientError) || load.error.code === "NETWORK" || load.error.status >= 500);

  return (
    <section className="stack" aria-labelledby="today-heading">
      <div className="row-between">
        <h1 id="today-heading">Today's sessions</h1>
        <div className="row">
          {devMode && (
            <button type="button" className="btn" onClick={onSeed} disabled={seedState.kind === "busy"}>
              {seedState.kind === "busy" && <span className="spinner" aria-hidden="true" />}
              {seedState.kind === "busy" ? "Seeding…" : "Seed demo data"}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onSync} disabled={syncState.kind === "busy"}>
            {syncState.kind === "busy" && <span className="spinner" aria-hidden="true" />}
            {syncState.kind === "busy" ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>

      <div aria-live="polite" className="stack-sm">
        {seedState.kind === "ok" && <div className="success-box">{seedState.message}</div>}
        {seedState.kind === "error" && <ErrorNotice title="Seed failed" error={seedState.error} />}
        {syncState.kind === "ok" && <div className="success-box">{syncState.message}</div>}
        {syncState.kind === "error" && <ErrorNotice title="Sync failed" error={syncState.error} />}
        {polling && (
          <p className="muted small row">
            <span className="spinner" aria-hidden="true" /> Checking for updates every few seconds…
          </p>
        )}
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
          <div className="warn-box small row">
            <span>Some sessions are still in progress. Automatic refresh stopped.</span>
            <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        )}
      </div>

      {load.kind === "loading" && (
        <p className="muted row" role="status">
          <span className="spinner" aria-hidden="true" /> Loading sessions…
        </p>
      )}

      {load.kind === "error" && (
        <ErrorNotice
          title={backendDown ? "Backend unavailable" : "Could not load sessions"}
          error={load.error}
          onRetry={() => void refresh()}
        />
      )}

      {load.kind === "ready" && sessions.length === 0 && (
        <div className="card stack-sm">
          <h2>No sessions yet</h2>
          <p className="muted">
            {devMode
              ? "Seed the synthetic demo data, then press Sync now to discover and process sessions."
              : "Press Sync now to discover sessions from your calendar."}
          </p>
        </div>
      )}

      {sessions.length > 0 && load.kind !== "error" && (
        <ul className="session-list" aria-label="Sessions">
          {sessions.map((s) => (
            <SessionCard key={s.id} s={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionCard({ s }: { s: SessionSummary }) {
  const estimate = isEstimate(s);
  return (
    <li className="card session-card">
      <div className="row-between">
        <h2 className="h3">
          Client <span className="mono">{s.clientRef}</span>
        </h2>
        <StatusChip status={s.status} />
      </div>
      <div className="session-meta">
        <span>{formatTimeRange(s.startAt, s.endAt, s.timezone)}</span>
        <span className="muted">Service {s.serviceCode}</span>
        <span>
          {s.amountCents == null ? (
            <span className="muted">Amount: not available</span>
          ) : (
            <>
              <span className="amount">{formatCents(s.amountCents)}</span>{" "}
              {estimate ? <span className="badge badge-warn">estimate</span> : <span className="muted">confirmed</span>}
            </>
          )}
        </span>
      </div>
      {REASON_STATUSES.has(s.status) && s.statusReason && (
        <p className={s.status === "FAILED" ? "error-box small" : "warn-box small"}>{s.statusReason}</p>
      )}
      <div>
        <a className="btn btn-sm" href={`#/sessions/${encodeURIComponent(s.id)}`}>
          Review<span className="sr-only"> session for client {s.clientRef}</span>
        </a>
      </div>
    </li>
  );
}
