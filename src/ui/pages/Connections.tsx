import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Bot, Check, KeyRound, ShieldCheck } from "lucide-react";
import type { Connection, ConnectionProvider, SettingsBundle } from "../../contracts";
import { api } from "../api";
import { Badge, Button, Card, Dialog, ErrorNotice, PageHeader, Skeleton, errorMessage, fadeOnly, fadeUp, stagger, useToast } from "../design";
import { ProviderCard } from "../components/connections/ProviderCard";
import { AI_PROVIDERS, AI_PROVIDER_LABELS, CONNECTION_LABELS } from "../components/settings/shared";
import "../components/settings/u2.css";

const ERROR_TEXT: Record<string, string> = {
  access_denied: "You declined access, so nothing was connected.",
  invalid_state: "The sign-in link expired or was already used. Please try again.",
  provider_mismatch: "The sign-in came back for a different provider. Please try again.",
  provider_error: "The provider didn't complete the sign-in. Please try again.",
  not_configured: "This provider isn't configured on the server.",
};

function isProvider(p: string | null): p is ConnectionProvider {
  return p === "google" || p === "microsoft";
}

export default function Connections() {
  const reduce = useReducedMotion();
  const toast = useToast();
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [bundle, setBundle] = useState<SettingsBundle | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<ConnectionProvider | null>(null);
  const [confirm, setConfirm] = useState<ConnectionProvider | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api.listConnections().then(setConns).catch(setErr);
    api
      .getSettings()
      .then(setBundle)
      .catch(() => setBundle(null));
  }, []);

  useEffect(() => {
    load();
    // OAuth callback lands on #/connections?connected=<p> or ?error=<code>.
    const [base, query] = window.location.hash.split("?");
    if (!query) return;
    const q = new URLSearchParams(query);
    const connected = q.get("connected");
    const error = q.get("error");
    if (isProvider(connected)) {
      toast.success(`${CONNECTION_LABELS[connected].name} connected`, `${CONNECTION_LABELS[connected].storage} and ${CONNECTION_LABELS[connected].mail} are ready.`);
    } else if (error) {
      toast.toast({ tone: "danger", title: "Connection failed", description: ERROR_TEXT[error] ?? `The provider returned: ${error}` });
    }
    window.history.replaceState(null, "", base || "#/connections");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(p: ConnectionProvider) {
    setBusy(p);
    try {
      const { authorizeUrl } = await api.startConnection(p, "/#/connections");
      window.location.assign(authorizeUrl);
    } catch (e) {
      setBusy(null);
      toast.error(`Couldn't start ${CONNECTION_LABELS[p].name} sign-in`, errorMessage(e));
    }
  }

  async function disconnect(p: ConnectionProvider) {
    setBusy(p);
    try {
      await api.disconnect(p);
      toast.success(`${CONNECTION_LABELS[p].name} disconnected`, "Stored tokens were deleted from this server.");
      setConfirm(null);
      setConns(await api.listConnections());
    } catch (e) {
      toast.error("Disconnect failed", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const v = reduce ? fadeOnly : fadeUp;
  const usedBy = (p: ConnectionProvider) => {
    const uses: string[] = [];
    if (bundle?.storage.provider === p) uses.push(`storage${bundle.storage.autoUploadOnComplete ? " (auto-upload)" : ""}`);
    if (bundle?.email.provider === p) uses.push("email drafts");
    return uses;
  };

  return (
    <div className="u2-page">
      <PageHeader
        eyebrow="Integrations"
        title="Connections"
        subtitle="Link a cloud account to save session PDFs and prepare email drafts. We never send email for you."
      />

      {err != null && <ErrorNotice title="Couldn't load connections" error={err} onRetry={load} />}

      <motion.div className="u2-prov-grid" variants={stagger} initial="hidden" animate="show">
        {conns == null && err == null
          ? [0, 1].map((i) => (
              <Card key={i} padding="lg" aria-busy="true" className="u2-prov">
                <Skeleton width={56} height={56} radius={16} />
                <Skeleton lines={5} />
              </Card>
            ))
          : (conns ?? []).map((c) => (
              <ProviderCard
                key={c.provider}
                conn={c}
                busy={busy === c.provider}
                onConnect={() => void connect(c.provider)}
                onDisconnect={() => setConfirm(c.provider)}
              />
            ))}
      </motion.div>

      <motion.section className="u2-ai-strip" variants={v} initial="hidden" animate="show" aria-labelledby="ai-strip-title">
        <div className="u2-ai-strip-head">
          <span className="u2-section-ico">
            <Bot size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id="ai-strip-title" className="u2-h2">
              AI providers
            </h2>
            <p className="u2-muted">
              Keys are managed by your admin on the server.{" "}
              {bundle?.extractionMode === "fixture" && "Extraction mode is fixture — no AI calls are made."}
            </p>
          </div>
          <a className="ds-btn ds-btn-secondary ds-btn-sm u2-link-btn" href="#/settings?tab=ai">
            AI & Privacy settings <ArrowRight size={14} aria-hidden="true" />
          </a>
        </div>
        <motion.div className="u2-ai-strip-list" variants={stagger} initial="hidden" animate="show">
          {AI_PROVIDERS.map((p) => {
            const s = bundle?.aiProviders.find((x) => x.provider === p);
            const active = bundle?.ai.provider === p;
            return (
              <motion.div key={p} variants={v} className={"u2-ai-chip" + (active ? " u2-ai-chip-on" : "")}>
                <span className={`u2-ai-orb u2-ai-${p}`} aria-hidden="true">
                  {AI_PROVIDER_LABELS[p].charAt(0)}
                </span>
                <span className="u2-ai-chip-name">
                  {s?.label ?? AI_PROVIDER_LABELS[p]}
                  {active && <span className="u2-muted u2-small"> · in use{bundle ? ` (${bundle.ai.model})` : ""}</span>}
                </span>
                {bundle ? (
                  <Badge tone={s?.configured ? "success" : "neutral"} icon={s?.configured ? <Check size={12} /> : <KeyRound size={12} />}>
                    {s?.configured ? "Configured" : "Not configured"}
                  </Badge>
                ) : (
                  <Skeleton width={80} height={20} radius={999} />
                )}
              </motion.div>
            );
          })}
        </motion.div>
        {bundle && (
          <p className="u2-muted u2-small u2-ai-strip-foot">
            <ShieldCheck size={13} aria-hidden="true" /> Privacy controller:{" "}
            {Object.values(bundle.ai.privacy).filter(Boolean).length} of 5 redactions on.
          </p>
        )}
      </motion.section>

      <Dialog
        open={confirm != null}
        onClose={() => busy == null && setConfirm(null)}
        dismissible={busy == null}
        size="sm"
        title={confirm ? `Disconnect ${CONNECTION_LABELS[confirm].name}?` : ""}
        description={
          confirm
            ? `Uploads to ${CONNECTION_LABELS[confirm].storage} and drafts in ${CONNECTION_LABELS[confirm].mail} will stop. Files and drafts already created stay in your account.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy != null}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy != null} onClick={() => confirm && void disconnect(confirm)}>
              Disconnect
            </Button>
          </>
        }
      >
        {confirm && usedBy(confirm).length > 0 && (
          <p className="u2-note u2-note-warn">Your settings use this account for {usedBy(confirm).join(" and ")}.</p>
        )}
      </Dialog>
    </div>
  );
}
