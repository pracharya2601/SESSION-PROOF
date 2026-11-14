import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw, Search, UserPlus, Users } from "lucide-react";
import type { ClientSummary } from "../../contracts";
import { api } from "../api";
import { Button, Card, EmptyState, ErrorNotice, Input, PageHeader, Skeleton, Switch, stagger, useToast } from "../design";
import { ClientCard } from "../components/clients/ClientCard";
import { NewClientDialog } from "../components/clients/NewClientDialog";
import { hrefs } from "../shell/routes";
import "../components/settings/u2.css";
import "../components/clients/clients.css";

function matches(s: ClientSummary, needle: string): boolean {
  const c = s.client;
  return [c.clientRef, c.displayName, c.preferredName, c.fundingSource].some((v) => v && v.toLowerCase().includes(needle));
}

export default function Clients() {
  const toast = useToast();
  const [items, setItems] = useState<ClientSummary[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [serverQ, setServerQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const reqId = useRef(0);

  // Debounce the server-side search; local filtering gives instant feedback meanwhile.
  useEffect(() => {
    const t = window.setTimeout(() => setServerQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    const id = ++reqId.current;
    setErr(null);
    api
      .listClients({ search: serverQ || undefined, includeInactive })
      .then((r) => {
        if (id === reqId.current) setItems(r);
      })
      .catch((e) => {
        if (id === reqId.current) setErr(e);
      });
  }, [serverQ, includeInactive]);
  useEffect(load, [load]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const needle = q.trim().toLowerCase();
    const list = includeInactive ? items : items.filter((s) => s.client.active);
    return needle ? list.filter((s) => matches(s, needle)) : list;
  }, [items, q, includeInactive]);

  return (
    <div className="u2-page">
      <PageHeader
        eyebrow="Records"
        title="Clients"
        subtitle="Per-client hourly rates, funding & authorization details, custom invoice fields and document templates."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={15} />} onClick={load} aria-label="Refresh clients">
              Refresh
            </Button>
            <Button variant="primary" size="sm" icon={<UserPlus size={15} />} onClick={() => setCreating(true)}>
              New client
            </Button>
          </>
        }
      />

      <div className="u2-toolbar cl-toolbar">
        <Input
          type="search"
          leading={<Search size={16} />}
          placeholder="Search ref, name or funding source…"
          aria-label="Search clients"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Switch checked={includeInactive} onChange={setIncludeInactive} label="Show inactive" />
        {filtered && q && (
          <span className="u2-muted u2-small" role="status">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {err != null && <ErrorNotice title="Couldn't load clients" error={err} onRetry={load} />}

      {filtered == null && err == null && (
        <ul className="cl-grid" aria-busy="true" aria-label="Loading clients">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i}>
              <Card padding="md" className="cl-skel">
                <div className="row">
                  <Skeleton circle width={40} height={40} />
                  <div className="stack-sm" style={{ flex: 1 }}>
                    <Skeleton width="60%" height={16} />
                    <Skeleton width="35%" height={12} />
                  </div>
                </div>
                <Skeleton height={56} radius={12} />
              </Card>
            </li>
          ))}
        </ul>
      )}

      {filtered && filtered.length === 0 && err == null && (
        <EmptyState
          icon={<Users size={28} />}
          title={q ? `No clients match “${q}”` : "No clients yet"}
          description={
            q
              ? "Try a different ref or name, or include inactive clients."
              : "Add a client to set their hourly rate, funding source and invoice details. New drafts for that client ref will use them."
          }
          action={
            q ? (
              <Button variant="secondary" size="sm" onClick={() => setQ("")}>
                Clear search
              </Button>
            ) : (
              <Button variant="primary" size="sm" icon={<UserPlus size={15} />} onClick={() => setCreating(true)}>
                New client
              </Button>
            )
          }
        />
      )}

      {filtered && filtered.length > 0 && (
        <motion.ul className="cl-grid" variants={stagger} initial="hidden" animate="show">
          <AnimatePresence initial={false} mode="popLayout">
            {filtered.map((s) => (
              <ClientCard key={s.client.clientRef} summary={s} />
            ))}
          </AnimatePresence>
        </motion.ul>
      )}

      <NewClientDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ref) => {
          setCreating(false);
          toast.success("Client created", ref);
          window.location.hash = hrefs.client(ref);
        }}
      />
    </div>
  );
}
