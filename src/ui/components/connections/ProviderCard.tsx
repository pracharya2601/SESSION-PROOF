import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Cloud, KeyRound, Link2, Mail, PlugZap, RefreshCw, Unplug, User } from "lucide-react";
import type { Connection, ConnectionProvider } from "../../../contracts";
import { Badge, Button, Card, cx, fadeOnly, fadeUp, stagger } from "../../design";
import { CONNECTION_LABELS, formatInstant } from "../settings/shared";

const DEFAULT_SCOPES: Record<ConnectionProvider, string[]> = {
  google: ["openid", "email", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/gmail.compose"],
  microsoft: ["openid", "email", "offline_access", "User.Read", "Files.ReadWrite", "Mail.ReadWrite"],
};

const ENV_HINT: Record<ConnectionProvider, string> = {
  google: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
  microsoft: "MS_CLIENT_ID and MS_CLIENT_SECRET",
};

type ScopeInfo = { icon: typeof Cloud; text: string };

/** Plain-language description of each OAuth scope we request. Unknown scopes are shown verbatim. */
function describeScope(scope: string): ScopeInfo | null {
  const s = scope.toLowerCase();
  if (s === "openid" || s === "email" || s === "user.read" || s === "profile")
    return { icon: User, text: "See your account email address" };
  if (s.endsWith("/drive.file")) return { icon: Cloud, text: "Create files in folders this app makes" };
  if (s.endsWith("/gmail.compose")) return { icon: Mail, text: "Create email drafts — never sends" };
  if (s === "files.readwrite") return { icon: Cloud, text: "Create files in OneDrive (only in the folder this app makes)" };
  if (s === "mail.readwrite") return { icon: Mail, text: "Create email drafts — never sends" };
  if (s === "offline_access") return { icon: RefreshCw, text: "Stay connected without signing in each time" };
  return { icon: KeyRound, text: scope };
}

function scopeList(conn: Connection): ScopeInfo[] {
  const scopes = conn.scopes.length ? conn.scopes : DEFAULT_SCOPES[conn.provider];
  const seen = new Set<string>();
  const out: ScopeInfo[] = [];
  for (const sc of scopes) {
    const d = describeScope(sc);
    if (d && !seen.has(d.text)) {
      seen.add(d.text);
      out.push(d);
    }
  }
  return out;
}

const STATUS = {
  connected: { tone: "success", label: "Connected", Icon: CheckCircle2 },
  not_connected: { tone: "neutral", label: "Not connected", Icon: Link2 },
  error: { tone: "danger", label: "Connection problem", Icon: AlertTriangle },
  not_configured: { tone: "warning", label: "Not configured", Icon: KeyRound },
} as const;

export function ProviderCard({
  conn,
  busy,
  onConnect,
  onDisconnect,
}: {
  conn: Connection;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const reduce = useReducedMotion();
  const v = reduce ? fadeOnly : fadeUp;
  const labels = CONNECTION_LABELS[conn.provider];
  const st = STATUS[conn.status];
  const connected = conn.status === "connected";

  return (
    <Card
      glow={connected}
      padding="lg"
      className={cx("u2-prov", `u2-prov-${conn.provider}`, `u2-prov-${conn.status}`)}
      motionProps={{ variants: v, layout: !reduce }}
      as="article"
      aria-labelledby={`prov-${conn.provider}`}
    >
      <div className="u2-prov-aurora" aria-hidden="true" />
      <div className="u2-prov-head">
        <motion.div
          className={cx("u2-prov-logo", `u2-logo-${conn.provider}`)}
          aria-hidden="true"
          animate={connected && !reduce ? { boxShadow: ["0 0 0 0 rgba(52,211,153,0.0)", "0 0 0 10px rgba(52,211,153,0.12)", "0 0 0 0 rgba(52,211,153,0.0)"] } : undefined}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        >
          {conn.provider === "google" ? "G" : "M"}
        </motion.div>
        <div className="u2-prov-title">
          <h2 id={`prov-${conn.provider}`} className="u2-h2">
            {labels.name}
          </h2>
          <span className="u2-muted">
            {labels.storage} + {labels.mail}
          </span>
        </div>
        <Badge tone={st.tone} dot icon={<st.Icon size={12} />}>
          {st.label}
        </Badge>
      </div>

      <div className="u2-prov-body">
        {connected && (
          <dl className="u2-prov-meta">
            <dt>Account</dt>
            <dd className="u2-prov-email">{conn.accountEmail ?? "—"}</dd>
            <dt>Connected</dt>
            <dd>{formatInstant(conn.connectedAt)}</dd>
          </dl>
        )}
        {conn.status === "error" && (
          <div className="u2-note u2-note-danger" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              {conn.lastError ?? "The connection stopped working."}
              {conn.accountEmail && <> ({conn.accountEmail})</>} Reconnect to continue uploads and drafts.
            </span>
          </div>
        )}
        {conn.status === "not_configured" && (
          <div className="u2-note u2-note-warn">
            <KeyRound size={16} aria-hidden="true" />
            <span>
              This server has no {labels.name} OAuth app yet. An admin must set <code>{ENV_HINT[conn.provider]}</code> as Worker
              secrets, then reload this page.
            </span>
          </div>
        )}
        {conn.status === "not_connected" && (
          <p className="u2-muted">
            Connect your {labels.name} account to save PDFs to {labels.storage} and create drafts in {labels.mail}.
          </p>
        )}

        <div className="u2-scopes">
          <span className="u2-path-label">{connected ? "Access granted" : "Access we'll request"}</span>
          <motion.ul variants={stagger} initial="hidden" animate="show">
            {scopeList(conn).map((s) => (
              <motion.li key={s.text} variants={v}>
                <s.icon size={14} aria-hidden="true" />
                {s.text}
              </motion.li>
            ))}
          </motion.ul>
        </div>
      </div>

      <div className="u2-prov-actions">
        {connected ? (
          <Button variant="ghost" icon={<Unplug size={16} />} onClick={onDisconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : conn.status === "error" ? (
          <>
            <Button variant="primary" icon={<RefreshCw size={16} />} loading={busy} onClick={onConnect}>
              Reconnect
            </Button>
            <Button variant="ghost" icon={<Unplug size={16} />} onClick={onDisconnect} disabled={busy}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            icon={<PlugZap size={16} />}
            loading={busy}
            disabled={conn.status === "not_configured"}
            title={conn.status === "not_configured" ? "An admin must configure this provider first" : undefined}
            onClick={onConnect}
          >
            Connect {labels.name}
          </Button>
        )}
      </div>
    </Card>
  );
}
