import { motion, useReducedMotion } from "framer-motion";
import { CalendarClock, ChevronRight, Landmark } from "lucide-react";
import type { ClientSummary } from "../../../contracts";
import { AnimatedNumber, Badge, fadeOnly, fadeUp } from "../../design";
import { hrefs } from "../../shell/routes";
import { clientLabel, formatDate, formatRate, initials } from "./shared";

export function ClientCard({ summary }: { summary: ClientSummary }) {
  const reduce = useReducedMotion();
  const { client: c, stats: s } = summary;
  const name = clientLabel(c);
  return (
    <motion.li
      className="cl-card-li"
      variants={reduce ? fadeOnly : fadeUp}
      layout={!reduce}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
    >
      <motion.a
        href={hrefs.client(c.clientRef)}
        className="cl-card ds-card ds-pad-md ds-card-interactive"
        data-inactive={!c.active || undefined}
        whileHover={reduce ? undefined : { y: -3 }}
        whileTap={reduce ? undefined : { scale: 0.99 }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
          e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
        }}
      >
        <div className="cl-card-head">
          <span className="cl-avatar" aria-hidden="true">
            {initials(c)}
          </span>
          <span className="cl-card-titles">
            <span className="cl-card-name">{name}</span>
            <span className="cl-card-ref mono">{c.clientRef}</span>
          </span>
          <ChevronRight size={16} className="cl-card-chev" aria-hidden="true" />
        </div>

        <div className="cl-card-chips">
          <Badge tone={c.hourlyRateCents == null ? "neutral" : "info"}>{formatRate(c.hourlyRateCents)}</Badge>
          {c.fundingSource && (
            <Badge tone="neutral" icon={<Landmark size={12} />}>
              {c.fundingSource}
            </Badge>
          )}
          {!c.active && <Badge tone="warning">Inactive</Badge>}
        </div>

        <dl className="cl-stats">
          <div>
            <dt>Sessions</dt>
            <dd>
              <AnimatedNumber value={s.sessions} />
            </dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>
              <AnimatedNumber value={s.completed} />
            </dd>
          </div>
          <div>
            <dt>Needs review</dt>
            <dd className={s.needsReview > 0 ? "cl-warn" : undefined}>
              <AnimatedNumber value={s.needsReview} />
            </dd>
          </div>
          <div>
            <dt>Billed</dt>
            <dd>
              <AnimatedNumber value={s.billedCents} format="cents" />
            </dd>
          </div>
        </dl>

        <div className="cl-card-foot subtle small">
          <CalendarClock size={13} aria-hidden="true" />
          <span>{s.lastServiceAt ? `Last service ${formatDate(s.lastServiceAt)}` : "No services yet"}</span>
        </div>
      </motion.a>
    </motion.li>
  );
}
