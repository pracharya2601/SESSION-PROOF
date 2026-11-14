/**
 * Approved export (Agent 16). Exports are reproduced ONLY from the immutable
 * finalized record (repo.getFinalBundle) — never from the mutable current bundle.
 * Every dynamic string in the HTML passes through escapeHtml.
 */
import { SCHEMA_VERSION, type ApprovalRecord, type FinalBundle } from "../contracts";
import type { Repository } from "../db/repository";
import type { Actor } from "../api/deps";
import { escapeHtml } from "../security/index";
import { ServiceError } from "../services/approval/index";

export interface ExportSource {
  final: FinalBundle;
  approval: ApprovalRecord | null;
}

/** Scoped load: session must belong to actor (404) and be finalized (409 NOT_FINALIZED). */
export async function loadFinalForActor(repo: Repository, actor: Actor, sessionId: string): Promise<ExportSource> {
  const session = await repo.getSessionForProvider(actor.providerId, sessionId);
  if (!session) throw new ServiceError(404, "NOT_FOUND", "Session not found", false);
  const final = await repo.getFinalBundle(sessionId);
  if (!final) throw new ServiceError(409, "NOT_FINALIZED", "Session has not been finalized yet", true);
  const approval = await repo.getApprovalForSession(sessionId);
  return { final, approval };
}

export function exportJson(final: FinalBundle, approval: ApprovalRecord | null = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    finalized: final,
    modes: final.bundle.provenance,
    approval,
  };
}

const e = (v: unknown): string => escapeHtml(v === null || v === undefined ? "—" : String(v));

function money(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function renderExportHtml(final: FinalBundle, approval: ApprovalRecord | null = null): string {
  const b = final.bundle;
  const p = b.provenance;
  const t = b.documents.timeSummary;
  const isFixture = p.evidenceMode === "fixture" || p.extractionMode === "fixture";

  const banner = isFixture
    ? `<div class="banner">FIXTURE / SYNTHETIC DATA — evidence mode: ${e(p.evidenceMode)}, extraction mode: ${e(p.extractionMode)}. Not a real client record.</div>`
    : "";

  const sections = b.documents.sections
    .map(
      (s) =>
        `<section><h2>${e(s.title)}</h2>${
          s.lines.length
            ? `<ul>${s.lines
                .map(
                  (l) =>
                    `<li><span class="origin">[${e(l.origin)}]</span> ${e(l.text)}${
                      l.evidenceIds.length ? ` <span class="ref">evidence: ${e(l.evidenceIds.join(", "))}</span>` : ""
                    }${l.attestationIds.length ? ` <span class="ref">attestation: ${e(l.attestationIds.join(", "))}</span>` : ""}</li>`,
                )
                .join("")}</ul>`
            : "<p>None.</p>"
        }</section>`,
    )
    .join("");

  const coverage = b.documents.planCoverage
    .map((g) => `<tr><td>${e(g.goalId)}</td><td>${e(g.objective)}</td><td>${e(g.status)}</td><td>${e(g.claimIds.join(", ") || "—")}</td></tr>`)
    .join("");

  const issues = b.checks.issues.length
    ? `<ul>${b.checks.issues
        .map((i) => `<li>${i.blocking ? "<strong>BLOCKING</strong> " : ""}${e(i.code)} (${e(i.field)}): ${e(i.message)}</li>`)
        .join("")}</ul>`
    : "<p>No issues recorded.</p>";

  const attestations = b.attestations.length
    ? `<ul>${b.attestations
        .map((a) => `<li>${e(a.field)}: ${e(a.text)} — provider ${e(a.actorProviderId)} at ${e(a.attestedAt)} (rev ${e(a.bundleRevision)})</li>`)
        .join("")}</ul>`
    : "<p>None.</p>";

  const evidence = b.evidence.length
    ? `<ul>${b.evidence
        .map((ev) => `<li><span class="ref">${e(ev.id)} [${e(ev.sourceMode)}]${ev.speaker ? ` ${e(ev.speaker)}:` : ""}</span> ${e(ev.excerpt)}</li>`)
        .join("")}</ul>`
    : "<p>None.</p>";

  const approvalRows = approval
    ? `<tr><th>Approver</th><td>${e(approval.approverProviderId)}</td></tr>
<tr><th>Approved revision</th><td>${e(approval.bundleRevision)}</td></tr>
<tr><th>Approved at</th><td>${e(approval.approvedAt)}</td></tr>
<tr><th>Idempotency key</th><td>${e(approval.idempotencyKey)}</td></tr>
<tr><th>Approval id</th><td>${e(approval.id)}</td></tr>`
    : `<tr><th>Approval id</th><td>${e(final.approvalId)}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session export ${e(b.sessionId)} r${e(final.bundleRevision)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#111;background:#fff}
h1{font-size:20px}h2{font-size:16px;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:24px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
.banner{border:2px solid #b45309;background:#fef3c7;padding:8px 12px;font-weight:600;margin:12px 0}
.origin,.ref{color:#555;font-size:12px}
@media print{body{margin:0}.banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
${banner}
<h1>Approved session record</h1>
<table>
<tr><th>Session</th><td>${e(b.sessionId)}</td></tr>
<tr><th>Client reference</th><td>${e(b.appointment.clientRef)}</td></tr>
<tr><th>Service</th><td>${e(b.appointment.serviceCode)} — ${e(b.config.plan.serviceDescription)}</td></tr>
<tr><th>Bundle revision</th><td>${e(final.bundleRevision)}</td></tr>
<tr><th>Finalized at</th><td>${e(final.finalizedAt)}</td></tr>
</table>
${sections}
<section><h2>Plan coverage</h2><table><tr><th>Goal</th><th>Objective</th><th>Status</th><th>Claims</th></tr>${coverage}</table></section>
<section><h2>Time summary</h2><table>
<tr><th>Scheduled</th><td>${e(t.scheduledFrom)} – ${e(t.scheduledTo)} (${e(t.scheduledMinutes)} min, ${e(t.timezone)})</td></tr>
<tr><th>Evidence window (informational, not billable)</th><td>${t.evidenceWindowFrom ? `${e(t.evidenceWindowFrom)} – ${e(t.evidenceWindowTo)} (${e(t.evidenceWindowMinutes)} min)` : "—"}</td></tr>
<tr><th>Provider-confirmed duration</th><td>${t.confirmedMinutes === null ? "—" : `${e(t.confirmedMinutes)} min`}</td></tr>
</table></section>
<section><h2>Billing</h2><table>
<tr><th>Rate</th><td>${e(money(b.billing.hourlyRateCents))}/hour (${e(b.billing.rateVersion)})</td></tr>
<tr><th>Confirmed minutes</th><td>${e(b.billing.confirmedMinutes)}</td></tr>
<tr><th>Amount</th><td>${e(money(b.billing.amountCents))} ${e(b.billing.currency)}</td></tr>
<tr><th>Rounding</th><td>${e(b.billing.rounding)}</td></tr>
<tr><th>Breakdown</th><td>${e(b.billing.breakdown)}</td></tr>
</table></section>
<section><h2>Documentation checks (not a compliance determination)</h2>
<p>Rule version ${e(b.checks.ruleVersion)} — can approve: ${e(b.checks.canApprove ? "yes" : "no")}</p>${issues}</section>
<section><h2>Provider attestations</h2>${attestations}</section>
<section><h2>Evidence excerpts</h2>${evidence}</section>
<section><h2>Approval record</h2><table>${approvalRows}</table></section>
<section><h2>Provenance</h2><table>
<tr><th>Evidence mode</th><td>${e(p.evidenceMode === "fixture" ? "FIXTURE (synthetic)" : p.evidenceMode)}</td></tr>
<tr><th>Extraction mode</th><td>${e(p.extractionMode === "fixture" ? "FIXTURE (synthetic)" : p.extractionMode)}</td></tr>
<tr><th>Runtime mode</th><td>${e(p.runtimeMode)}</td></tr>
<tr><th>Schema / prompt version</th><td>${e(p.schemaVersion)} / ${e(p.promptVersion)}</td></tr>
<tr><th>Model</th><td>${e(p.model)}</td></tr>
<tr><th>Evidence completeness</th><td>${e(p.evidenceCompleteness)}</td></tr>
<tr><th>Evidence warnings</th><td>${e(p.evidenceWarnings.join("; ") || "none")}</td></tr>
</table></section>
</body></html>`;
}
