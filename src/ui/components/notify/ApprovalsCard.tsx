/**
 * Today → "Approvals waiting": the visits that need the provider's review, with a Review button
 * each (the full review page; nothing is approved from here), plus the unread-notification count.
 */
import { useEffect, useState } from "react";
import { ArrowRight, BellRing, CheckCheck } from "lucide-react";
import type { SessionSummary } from "../../../contracts";
import { api } from "../../api";
import { Badge, Button, Card } from "../../design";
import { formatTimeRange } from "../format";

const MAX_ROWS = 6;

export function ApprovalsCard({ sessions }: { sessions: SessionSummary[] }) {
  const waiting = sessions.filter((s) => s.status === "NEEDS_REVIEW");
  const [unread, setUnread] = useState<{ count: number; bySession: Map<string, string[]> } | null>(null);

  const load = () =>
    api
      .listNotifications({ unread: true, limit: 100 })
      .then((r) => {
        const bySession = new Map<string, string[]>();
        for (const n of r.notifications) {
          if (!n.sessionId) continue;
          bySession.set(n.sessionId, [...(bySession.get(n.sessionId) ?? []), n.id]);
        }
        setUnread({ count: r.unreadCount, bySession });
      })
      .catch(() => setUnread(null));

  const waitingKey = waiting.map((s) => `${s.id}:${s.currentBundleRevision}`).join(",");
  useEffect(() => {
    void load();
  }, [waitingKey]);

  if (waiting.length === 0) return null;

  function open(s: SessionSummary) {
    // Best effort: the visit's unread notifications are read once its review page is opened.
    for (const id of unread?.bySession.get(s.id) ?? []) void api.markNotificationRead(id).catch(() => undefined);
  }

  return (
    <Card as="section" padding="md" aria-labelledby="approvals-heading" className="approvals-card" style={{ marginBottom: 20 }}>
      <div className="row-between" style={{ marginBottom: 10, gap: 12 }}>
        <h2 id="approvals-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 17 }}>
          <BellRing size={18} aria-hidden="true" />
          Approvals waiting <span className="group-count">{waiting.length}</span>
        </h2>
        {unread && unread.count > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={<CheckCheck size={14} />}
            onClick={() => void api.markAllNotificationsRead().then(load).catch(() => undefined)}
          >
            Mark {unread.count} read
          </Button>
        )}
      </div>
      <p className="subtle small" style={{ margin: "0 0 12px" }}>
        Drafts are ready. Open each one, check it against the approval checklist and approve.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {waiting.slice(0, MAX_ROWS).map((s) => (
          <li key={s.id} className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
            <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <strong className="mono">{s.clientRef}</strong>
              <span className="subtle small">{formatTimeRange(s.startAt, s.endAt, s.timezone)}</span>
              {s.canApprove ? <Badge tone="success">Ready to approve</Badge> : <Badge tone="warning">Needs fixes</Badge>}
              {unread?.bySession.has(s.id) && (
                <Badge tone="info" dot>
                  New
                </Badge>
              )}
            </span>
            <a className="ds-btn ds-btn-primary ds-btn-sm" href={`#/sessions/${encodeURIComponent(s.id)}`} onClick={() => open(s)}>
              Review
              <span className="sr-only"> visit for client {s.clientRef}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      {waiting.length > MAX_ROWS && (
        <p className="subtle small" style={{ margin: "10px 0 0" }}>
          And {waiting.length - MAX_ROWS} more under “Needs you” below.
        </p>
      )}
    </Card>
  );
}
