import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CloudUpload, FileStack, FolderSearch, RefreshCw, Search, Wallet } from "lucide-react";
import type { CompletedSessionFiles, Connection, FileDelivery, SettingsBundle } from "../../contracts";
import { api } from "../api";
import { AnimatedNumber, Button, Card, EmptyState, ErrorNotice, Input, PageHeader, Skeleton, fadeOnly, fadeUp, stagger } from "../design";
import { SessionFilesCard, pickStorageProvider } from "../components/files/SessionFilesCard";
import { CONNECTION_LABELS } from "../components/settings/shared";
import "../components/settings/u2.css";

export default function Files() {
  const reduce = useReducedMotion();
  const [items, setItems] = useState<CompletedSessionFiles[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [moreErr, setMoreErr] = useState<unknown>(null);
  const [settings, setSettings] = useState<SettingsBundle | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [identity, setIdentity] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    setErr(null);
    setItems(null);
    api
      .listFiles()
      .then((r) => {
        setItems(r.items);
        setCursor(r.nextCursor);
      })
      .catch(setErr);
    api.getSettings().then(setSettings).catch(() => setSettings(null));
    api.listConnections().then(setConnections).catch(() => setConnections([]));
  }, []);

  useEffect(() => {
    load();
    api
      .me()
      .then((m) => setIdentity(m.identity ?? m.email ?? null))
      .catch(() => setIdentity(null));
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreErr(null);
    try {
      const r = await api.listFiles(cursor);
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((x) => x.sessionId));
        return [...(prev ?? []), ...r.items.filter((x) => !seen.has(x.sessionId))];
      });
      setCursor(r.nextCursor);
    } catch (e) {
      setMoreErr(e);
    } finally {
      setLoadingMore(false);
    }
  }

  const onDeliveries = useCallback((sessionId: string, update: (prev: FileDelivery[]) => FileDelivery[]) => {
    setItems((prev) => prev?.map((it) => (it.sessionId === sessionId ? { ...it, deliveries: update(it.deliveries) } : it)) ?? prev);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!items) return null;
    return needle ? items.filter((i) => i.clientRef.toLowerCase().includes(needle)) : items;
  }, [items, q]);

  const totals = useMemo(() => {
    const list = items ?? [];
    return {
      count: list.length,
      cents: list.reduce((s, i) => s + (i.amountCents ?? 0), 0),
      delivered: list.filter((i) => i.deliveries.some((d) => d.status === "done")).length,
    };
  }, [items]);

  const storage = pickStorageProvider(settings, connections);
  const v = reduce ? fadeOnly : fadeUp;

  return (
    <div className="u2-page">
      <PageHeader
        eyebrow="Completed sessions"
        title="Files"
        subtitle="Approved session notes, invoices and approval records — download, preview, save to the cloud or draft an email."
        actions={
          <Button variant="ghost" size="sm" icon={<RefreshCw size={15} />} onClick={load}>
            Refresh
          </Button>
        }
      />

      <motion.div className="u2-stat-row u2-stat-hero" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={v} className="u2-stat">
          <FileStack size={16} aria-hidden="true" />
          <span className="u2-stat-label">Completed sessions{cursor ? " (loaded)" : ""}</span>
          <span className="u2-stat-value u2-stat-big">{items ? <AnimatedNumber value={totals.count} /> : <Skeleton width={40} height={24} />}</span>
        </motion.div>
        <motion.div variants={v} className="u2-stat">
          <Wallet size={16} aria-hidden="true" />
          <span className="u2-stat-label">Billed</span>
          <span className="u2-stat-value u2-stat-big">
            {items ? <AnimatedNumber value={totals.cents} format="cents" /> : <Skeleton width={90} height={24} />}
          </span>
        </motion.div>
        <motion.div variants={v} className="u2-stat">
          <CloudUpload size={16} aria-hidden="true" />
          <span className="u2-stat-label">Delivered</span>
          <span className="u2-stat-value u2-stat-big">
            {items ? <AnimatedNumber value={totals.delivered} /> : <Skeleton width={40} height={24} />}
          </span>
          <span className="u2-muted u2-small">
            {storage ? `Uploads go to ${CONNECTION_LABELS[storage].storage}` : <a href="#/connections">Connect cloud storage</a>}
          </span>
        </motion.div>
      </motion.div>

      <div className="u2-toolbar">
        <Input
          type="search"
          leading={<Search size={16} />}
          placeholder="Search by client ref…"
          aria-label="Search by client ref"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {filtered && q && (
          <span className="u2-muted u2-small" role="status">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {err != null && <ErrorNotice title="Couldn't load files" error={err} onRetry={load} />}

      {filtered == null && err == null && (
        <div className="u2-session-list" aria-busy="true" aria-label="Loading files">
          {[0, 1, 2].map((i) => (
            <Card key={i} padding="lg" className="u2-session">
              <div className="u2-session-head">
                <Skeleton width={180} height={22} />
                <Skeleton width={90} height={26} />
              </div>
              <div className="u2-tiles">
                {[0, 1, 2].map((j) => (
                  <Skeleton key={j} height={64} radius={14} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {filtered && filtered.length === 0 && (
        <EmptyState
          icon={<FolderSearch size={28} />}
          title={q ? `No sessions match "${q}"` : "No completed sessions yet"}
          description={
            q
              ? cursor
                ? "Only loaded sessions are searched — load more to search further."
                : "Try a different client ref."
              : "Once a session is approved, its session note, invoice and approval record appear here."
          }
          action={
            q ? (
              <Button variant="secondary" size="sm" onClick={() => setQ("")}>
                Clear search
              </Button>
            ) : (
              <a className="ds-btn ds-btn-primary ds-btn-sm u2-link-btn" href="#/">
                Go to Today
              </a>
            )
          }
        />
      )}

      {filtered && filtered.length > 0 && (
        <motion.div className="u2-session-list" variants={stagger} initial="hidden" animate="show">
          <AnimatePresence initial={false}>
            {filtered.map((it) => (
              <SessionFilesCard
                key={it.sessionId}
                item={it}
                settings={settings}
                connections={connections}
                identity={identity}
                onDeliveries={onDeliveries}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {moreErr != null && <ErrorNotice title="Couldn't load more" error={moreErr} onRetry={() => void loadMore()} />}
      {items && cursor && (
        <div className="u2-loadmore">
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
