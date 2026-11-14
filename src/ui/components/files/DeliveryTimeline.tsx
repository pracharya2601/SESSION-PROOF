import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Cloud, ExternalLink, Loader2, Mail } from "lucide-react";
import type { FileDelivery } from "../../../contracts";
import { Badge, cx } from "../../design";
import { CONNECTION_LABELS, FILE_LABELS, formatInstant } from "../settings/shared";

const TONE = {
  pending: { tone: "info", label: "In progress", Icon: Loader2 },
  done: { tone: "success", label: "Done", Icon: CheckCircle2 },
  failed: { tone: "danger", label: "Failed", Icon: AlertTriangle },
} as const;

function title(d: FileDelivery): string {
  const l = CONNECTION_LABELS[d.provider];
  if (d.target === "drive") return `Saved to ${l.storage}`;
  return `Draft in ${l.mail}${d.recipients.length ? ` to ${d.recipients.join(", ")}` : ""}`;
}

export function DeliveryTimeline({ deliveries }: { deliveries: FileDelivery[] }) {
  const reduce = useReducedMotion();
  const sorted = [...deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (sorted.length === 0)
    return <p className="u2-muted u2-small u2-timeline-empty">No deliveries yet — save to Drive or create an email draft.</p>;
  return (
    <ol className="u2-timeline" aria-label="Delivery history">
      <AnimatePresence initial={false}>
        {sorted.map((d, i) => {
          const st = TONE[d.status];
          const Icon = d.target === "drive" ? Cloud : Mail;
          return (
            <motion.li
              key={d.id}
              layout={!reduce}
              className={cx("u2-tl-item", `u2-tl-${d.status}`)}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 30, delay: reduce ? 0 : i * 0.04 }}
            >
              <span className="u2-tl-node" aria-hidden="true">
                <Icon size={14} />
              </span>
              <div className="u2-tl-body">
                <div className="u2-tl-row">
                  <span className="u2-tl-title">{title(d)}</span>
                  <Badge tone={st.tone} icon={<st.Icon size={12} className={d.status === "pending" && !reduce ? "u2-spin" : undefined} />}>
                    {d.target === "email_draft" && d.status === "done" ? "Draft ready" : st.label}
                  </Badge>
                </div>
                <div className="u2-tl-meta">
                  <span>{formatInstant(d.createdAt)}</span>
                  <span>·</span>
                  <span>r{d.bundleRevision}</span>
                  <span>·</span>
                  <span>{d.files.map((k) => FILE_LABELS[k]).join(", ")}</span>
                  {d.webUrl && (
                    <a className="u2-tl-link" href={d.webUrl} target="_blank" rel="noopener noreferrer">
                      {d.target === "drive" ? "Open folder" : "Open draft"} <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </div>
                {d.error && <p className="u2-tl-error">{d.error}</p>}
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
