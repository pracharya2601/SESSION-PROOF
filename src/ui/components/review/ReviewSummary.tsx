/**
 * Top-of-page summary: who/when/what, minutes, what happened, goals, invoice total,
 * what needs attention, and the Approve button (approval logic stays in Review.tsx).
 */
import { motion } from "framer-motion";
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Clock, Loader2, Receipt } from "lucide-react";
import type { SessionBundle, SessionDetail } from "../../../contracts";
import { Badge, Button, StatusPill } from "../../design";
import { attentionItems, goalChips, invoiceTotal, minutesLine, uncertainClaims, whatHappened } from "../review-chat/helpers";
import { ApproveButton } from "./ApproveButton";
import { Celebration } from "./Celebration";
import { formatCents, formatInstant } from "./format";
import { RevisionBadge } from "./RevisionBadge";
import { rvItem, rvItemReduced, useMotionOK } from "./motion";

const GOAL_LABEL = { addressed: "Addressed", partially_addressed: "Partly", unknown: "Not shown" } as const;

export function ReviewSummary(props: {
  detail: SessionDetail;
  bundle: SessionBundle | null;
  preferredName: string | null;
  onBack: () => void;
  editable: boolean;
  completed: boolean;
  finalizing: boolean;
  approving: boolean;
  canApprove: boolean;
  approveReason: string | null;
  onApprove: () => void;
  celebrate: number;
}) {
  const ok = useMotionOK();
  const { detail, bundle } = props;
  const a = detail.appointment;
  const revision = bundle?.bundleRevision ?? null;
  const attention = bundle ? attentionItems(bundle) : [];
  const unsure = bundle ? uncertainClaims(bundle).length : 0;
  const happened = bundle ? whatHappened(bundle) : { lines: [], source: "none" as const };
  const goals = bundle ? goalChips(bundle) : [];
  const total = bundle ? invoiceTotal(bundle) : { cents: null, estimate: true };
  const mins = bundle ? minutesLine(bundle) : null;
  const prov = bundle?.provenance;

  return (
    <motion.section className="rvs ds-card" aria-label="Session summary" variants={ok ? rvItem : rvItemReduced}>
      <Celebration burstKey={props.celebrate} />
      <div className="rvs-top">
        <Button variant="ghost" size="sm" onClick={props.onBack} icon={<ArrowLeft size={16} />}>
          Back
        </Button>
        <div className="rvs-status">
          <StatusPill status={detail.session.status} layoutId="rv-status-pill" />
          {revision !== null && <RevisionBadge revision={revision} />}
        </div>
      </div>

      <div className="rvs-grid">
        <div className="rvs-main">
          <h1 className="rvs-title">
            {props.preferredName ? (
              <>
                {props.preferredName} <span className="rvs-ref">· {a.clientRef}</span>
              </>
            ) : (
              <>Client {a.clientRef}</>
            )}
          </h1>
          <p className="rvs-meta">
            <CalendarClock size={14} aria-hidden="true" /> {formatInstant(a.startAt, a.timezone)} – {formatInstant(a.endAt, a.timezone, false)}
            <span className="rvs-dot">·</span>
            <span className="rvs-code">{a.serviceCode}</span>
            {bundle?.config.plan.serviceDescription && <span className="rvs-muted"> {bundle.config.plan.serviceDescription}</span>}
          </p>

          {mins && (
            <p className="rvs-minutes">
              <Clock size={14} aria-hidden="true" />
              <span>
                Recorded <strong>{mins.recorded === null ? "—" : `${mins.recorded} min`}</strong>
              </span>
              <span className="rvs-dot">·</span>
              <span>
                Confirmed{" "}
                <strong className={mins.confirmed === null ? "rvs-missing" : undefined}>
                  {mins.confirmed === null ? "not yet" : `${mins.confirmed} min`}
                </strong>
              </span>
              <span className="rvs-dot">·</span>
              <span className="rvs-muted">scheduled {mins.scheduled} min</span>
            </p>
          )}

          <div className="rvs-happened">
            <h2 className="rvs-h">What happened</h2>
            {happened.lines.length > 0 ? (
              <ul>
                {happened.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="rvs-muted">No activities were drafted from the transcript yet.</p>
            )}
            {happened.source === "provider" && <p className="rvs-src">Your summary (provider written)</p>}
          </div>

          {goals.length > 0 && (
            <div className="rvs-goals" aria-label="Plan goals">
              {goals.map((g) => (
                <span key={g.goalId} className={`rvs-goal is-${g.providerConfirmed ? "confirmed" : g.status}`} title={g.label}>
                  {g.providerConfirmed && <CheckCircle2 size={12} aria-hidden="true" />}
                  <span className="rvs-goal-label">{g.label}</span>
                  <span className="rvs-goal-st">{g.providerConfirmed ? "Confirmed" : GOAL_LABEL[g.status]}</span>
                </span>
              ))}
            </div>
          )}
          {prov && (prov.evidenceCompleteness !== "complete" || prov.evidenceWarnings.length > 0) && (
            <p className="rvs-warn">
              <AlertTriangle size={14} aria-hidden="true" /> Evidence {prov.evidenceCompleteness}
              {prov.evidenceWarnings.length > 0 ? ` — ${prov.evidenceWarnings.slice(0, 2).join(" · ")}` : ""}
            </p>
          )}
        </div>

        <aside className="rvs-side" aria-label="Approval">
          <div className="rvs-total">
            <Receipt size={16} aria-hidden="true" />
            <span className="rvs-total-n">{formatCents(total.cents)}</span>
            {total.estimate && <Badge tone="warning">estimate</Badge>}
          </div>
          {bundle && !props.completed && (
            <p className={`rvs-attn ${attention.length > 0 ? "is-bad" : "is-ok"}`}>
              {attention.length > 0 ? (
                <>
                  <strong>{attention.length}</strong> thing{attention.length === 1 ? "" : "s"} need{attention.length === 1 ? "s" : ""} attention
                </>
              ) : (
                <>Ready to approve</>
              )}
              {unsure > 0 && <span className="rvs-muted"> · {unsure} uncertain</span>}
            </p>
          )}
          {props.completed ? (
            <p className="rvs-done">
              <CheckCircle2 size={18} aria-hidden="true" /> Revision {detail.approval?.bundleRevision ?? detail.session.currentBundleRevision} is final.
            </p>
          ) : props.finalizing || detail.session.status === "APPROVED" ? (
            <p className="rvs-muted">
              <Loader2 size={14} className="ds-spin" aria-hidden="true" /> Approved — generating final documents…
            </p>
          ) : props.editable && bundle ? (
            <>
              <ApproveButton
                revision={bundle.bundleRevision}
                pending={props.approving}
                disabled={!props.canApprove}
                describedBy={props.approveReason ? "rvs-approve-reason" : undefined}
                onClick={props.onApprove}
              />
              {props.approveReason && (
                <p id="rvs-approve-reason" className="rvs-reason">
                  {props.approveReason}
                </p>
              )}
            </>
          ) : null}
        </aside>
      </div>
    </motion.section>
  );
}
