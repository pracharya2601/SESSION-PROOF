/** Console table + markdown summary for an EvalReport. Never includes request bodies or keys. */
import type { CaseResult, EvalReport } from "../harness";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);
const yn = (b: boolean) => (b ? "yes" : "no");

function row(c: CaseResult): string[] {
  return [
    c.id,
    c.outcome + (c.rejectReason ? `(${c.rejectReason})` : ""),
    String(c.claims),
    pct(c.citations.validity),
    `${c.requiredCitations.met}/${c.requiredCitations.total}`,
    c.goals.recall === null ? "—" : `${c.goals.addressed}/${c.goals.mustAddress}`,
    c.goals.unknownPrecision === null ? "—" : `${c.goals.stayedUnknown}/${c.goals.mustStayUnknown}`,
    `${c.forbidden.leaked}/${c.forbidden.hits.length}`,
    `${c.pii.leaked.length}/${c.pii.planted}`,
    c.injection.applicable ? yn(c.injection.resisted) : "—",
    yn(c.approval.afterDuration),
    String(c.perf.ms),
    `${c.perf.inputTokens}/${c.perf.outputTokens}${c.perf.tokensEstimated && c.perf.calls ? "~" : ""}`,
  ];
}

const HEAD = ["case", "outcome", "claims", "cite ok", "req cite", "goal recall", "stay unk", "forbid leak/hit", "pii leak", "inj ok", "approvable*", "ms", "tok in/out"];

export function consoleTable(r: EvalReport): string {
  const rows = [HEAD, ...r.cases.map(row)];
  const w = HEAD.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
  return rows.map((x) => x.map((v, i) => v.padEnd(w[i]!)).join("  ")).join("\n");
}

export function markdown(r: EvalReport): string {
  const s = r.summary;
  const L: string[] = [];
  L.push(`# AI eval — ${r.mode}${r.provider ? ` / ${r.provider}` : ""}${r.model ? ` / ${r.model}` : ""}`);
  L.push("");
  L.push(`Generated ${r.generatedAt}. Prompt version: ${r.promptVersion ?? "—"}.`);
  for (const n of r.notes) L.push(`> ${n}`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`| metric | value |`);
  L.push(`|---|---|`);
  L.push(`| cases (drafted) | ${s.cases} (${s.drafted}) |`);
  L.push(`| outcome as expected | ${s.outcomeMatches}/${s.cases} |`);
  L.push(`| rejected by validator | ${s.rejected.join(", ") || "none"} |`);
  L.push(`| errors | ${s.errors.join("; ") || "none"} |`);
  L.push(`| citation validity (must be 100%) | ${pct(s.citationValidity)} |`);
  L.push(`| required citations met | ${s.requiredCitations.met}/${s.requiredCitations.total} |`);
  L.push(`| goal recall (mustAddress) | ${pct(s.goalRecall)} |`);
  L.push(`| goals kept unknown (mustStayUnknown) | ${pct(s.unknownPrecision)} |`);
  L.push(`| forbidden claims: hits / leaked into draft | ${s.forbiddenHits} / ${s.forbiddenLeaked} |`);
  L.push(`| cases with a leaked forbidden claim that are approvable after duration only | ${s.forbiddenLeakedIntoApprovable.join(", ") || "none"} |`);
  L.push(`| PII values leaked in outbound requests | ${s.piiLeaked.length} of ${s.piiPlanted} planted |`);
  L.push(`| prompt-injection resisted | ${s.injectionResisted}/${s.injectionCases} (billing unchanged in all cases: ${yn(s.billingUnchangedAll)}) |`);
  L.push(`| forbidden text on invoice task lines | ${s.invoiceLeaks.length} |`);
  L.push(`| approvable after duration only | ${s.approvableAfterDuration.join(", ") || "none"} |`);
  L.push(`| calls / total ms / max ms | ${s.perf.calls} / ${s.perf.totalMs} / ${s.perf.maxMs} |`);
  L.push(`| tokens in / out | ${s.perf.inputTokens} / ${s.perf.outputTokens} |`);
  L.push(`| cost (USD, approx.) | ${s.perf.costUsd.toFixed(4)} |`);
  if (s.perf.httpErrors.length) L.push(`| HTTP errors | ${s.perf.httpErrors.join("; ")} |`);
  L.push("");
  L.push("## Forbidden claims by kind");
  L.push("");
  L.push("| kind | hits | refused by a blocking check |");
  L.push("|---|---|---|");
  for (const [k, v] of Object.entries(s.forbiddenByKind)) L.push(`| ${k} | ${v.hits} | ${v.refused} |`);
  if (!Object.keys(s.forbiddenByKind).length) L.push("| (none) | 0 | 0 |");
  L.push("");
  L.push("## Validator probes (mutations that must be caught)");
  L.push("");
  L.push("| probe | caught |");
  L.push("|---|---|");
  for (const [k, v] of Object.entries(s.probes)) L.push(`| ${k} | ${v.caught}/${v.total} |`);
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(`| ${HEAD.join(" | ")} |`);
  L.push(`|${HEAD.map(() => "---").join("|")}|`);
  for (const c of r.cases) L.push(`| ${row(c).join(" | ")} |`);
  L.push("");
  L.push("\\* approvable = `canApprove` after the provider confirms only the duration (no progress/goal attestation). `~` = estimated tokens.");
  L.push("");
  L.push("## Findings per case");
  for (const c of r.cases) {
    const lines: string[] = [];
    for (const h of c.forbidden.hits) lines.push(`- forbidden \`${h.id}\` (${h.kind}) in ${h.section} [${h.support}] ${h.refused ? `REFUSED by ${h.refusedBy}` : "**LEAKED**"}: "${h.text}"`);
    for (const l of c.pii.leaked) lines.push(`- PII leaked to model: ${l.type} "${l.value}" (synthetic)${l.knownGap ? " — known scrubber gap" : ""}`);
    for (const l of c.invoiceLeaks) lines.push(`- forbidden text on INVOICE line: ${l}`);
    if (!c.injection.billingUnchanged) lines.push(`- billing/rate/duration differs from the server baseline`);
    if (c.requiredCitations.missed.length) lines.push(`- required citation missed: ${c.requiredCitations.missed.join(", ")}`);
    if (c.goals.missedAddress.length) lines.push(`- goal not addressed: ${c.goals.missedAddress.join(", ")}`);
    if (c.goals.overclaimed.length) lines.push(`- goal should stay unknown: ${c.goals.overclaimed.map((g) => `${g}=${c.goals.statuses[g]}`).join(", ")}`);
    for (const p of c.probes.filter((p) => !p.caught)) lines.push(`- probe MISSED: ${p.probe} (expected ${p.expected}, got ${p.got})`);
    if (c.approval.matchesExpectation === false) lines.push(`- approvable after duration = ${c.approval.afterDuration}, expected ${c.approval.expectedAfterDuration}`);
    if (c.error) lines.push(`- ${c.outcome}: ${c.error}`);
    if (lines.length) {
      L.push("");
      L.push(`### ${c.id}`);
      L.push(`Blocking at r1: ${c.approval.blockingR1.join(", ") || "none"}; after duration: ${c.approval.blockingAfterDuration.join(", ") || "none"}.`);
      L.push(...lines);
    }
  }
  return L.join("\n") + "\n";
}
