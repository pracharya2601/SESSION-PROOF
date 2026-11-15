import { useEffect, useState, type ReactNode } from "react";
import { BadgeDollarSign, ExternalLink, Landmark, LayoutTemplate, ShieldCheck, UserRound } from "lucide-react";
import type { ClientRecord, DocumentTemplate, FileKind } from "../../../contracts";
import { api } from "../../api";
import { Badge, Card, ErrorNotice, Field, Input, Select, Skeleton, Switch, Textarea } from "../../design";
import { type ClientDraft, type DraftErrors, FILE_KINDS, LIMITS, centsToDollarString, formatRate, parseDollarsToCents } from "./shared";

export type Patch = (p: Partial<ClientDraft>) => void;

export function Section({ icon, title, subtitle, children }: { icon: ReactNode; title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <Card padding="lg" className="u2-section" as="section">
      <div className="u2-section-head">
        <span className="u2-section-ico">{icon}</span>
        <div>
          <h2 className="u2-h2">{title}</h2>
          {subtitle && <p className="u2-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </Card>
  );
}

export function PrivacyNote() {
  return (
    <p className="u2-note cl-privacy-note">
      <ShieldCheck size={16} aria-hidden="true" />
      <span>
        Names are never sent to AI. They are added to the privacy scrubber's known names and only appear on your own documents.
      </span>
    </p>
  );
}

// ------------------------------------------------------------------ profile
export function ProfileTab({ draft, patch, errors }: { draft: ClientDraft; patch: Patch; errors: DraftErrors }) {
  return (
    <Section icon={<UserRound size={18} aria-hidden="true" />} title="Profile" subtitle="How this client appears on your documents.">
      <div className="u2-grid-2">
        <Field label="Client ref" hint="The stable key from your calendar. Can't be changed.">
          <Input value={draft.clientRef} readOnly className="mono" />
        </Field>
        <Field label="Display name" hint="Full name used on documents." error={errors.displayName}>
          <Input value={draft.displayName} maxLength={LIMITS.displayName + 20} onChange={(e) => patch({ displayName: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Preferred name" hint="What they like to be called." error={errors.preferredName}>
          <Input value={draft.preferredName} maxLength={LIMITS.preferredName + 20} onChange={(e) => patch({ preferredName: e.target.value })} autoComplete="off" />
        </Field>
      </div>
      <PrivacyNote />
      <Switch
        checked={draft.active}
        onChange={(active) => patch({ active })}
        label="Active client"
        description="Inactive clients are hidden from the list and fall back to the agency default rate on new drafts."
      />
      <Field label="Notes" hint={`Private to you — not printed on documents. ${draft.notes.length}/${LIMITS.notes}`} error={errors.notes}>
        <Textarea rows={5} value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} />
      </Field>
    </Section>
  );
}

// ------------------------------------------------------------------ billing
export function BillingTab({
  draft,
  patch,
  errors,
  record,
}: {
  draft: ClientDraft;
  patch: Patch;
  errors: DraftErrors;
  record: ClientRecord | null;
}) {
  const parsed = draft.useDefaultRate ? null : parseDollarsToCents(draft.rateDollars);
  const preview = parsed && "cents" in parsed ? parsed.cents : null;
  const savedCents = record ? record.hourlyRateCents : null;
  const changed = record != null && (draft.useDefaultRate ? savedCents != null : preview != null && preview !== savedCents);
  return (
    <Section icon={<BadgeDollarSign size={18} aria-hidden="true" />} title="Billing" subtitle="The hourly rate used when this client's drafts are assembled.">
      <Switch
        checked={draft.useDefaultRate}
        onChange={(useDefaultRate) => patch({ useDefaultRate })}
        label="Use agency default"
        description="Bill this client at the agency's default hourly rate."
      />
      <div className="u2-grid-2">
        <Field label="Hourly rate (USD)" hint={draft.useDefaultRate ? "Using the agency default." : "Up to 2 decimals, e.g. 85.50"} error={errors.rate}>
          <Input
            value={draft.rateDollars}
            disabled={draft.useDefaultRate}
            inputMode="decimal"
            leading={<span aria-hidden="true">$</span>}
            placeholder={draft.useDefaultRate ? "Default" : "85.00"}
            onChange={(e) => patch({ rateDollars: e.target.value })}
            onBlur={() => {
              const r = parseDollarsToCents(draft.rateDollars);
              if (!draft.useDefaultRate && "cents" in r) patch({ rateDollars: centsToDollarString(r.cents) });
            }}
          />
        </Field>
        <div className="cl-rate-meta">
          <span className="u2-stat-label u2-muted">Saved rate</span>
          <span className="cl-rate-value">{record ? formatRate(record.hourlyRateCents) : "Not saved yet"}</span>
          {record && <Badge tone="neutral">Rate version v{record.rateVersion}</Badge>}
          {changed && (
            <Badge tone="warning" dot>
              New rate → {draft.useDefaultRate ? "Default rate" : formatRate(preview)}
            </Badge>
          )}
        </div>
      </div>
      <p className="u2-note">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>
          Rate changes apply to <strong>new drafts</strong>; approved invoices never change. Each change bumps the rate version, which is frozen into every
          draft so you can always see which rate an invoice used.
        </span>
      </p>
    </Section>
  );
}

// ------------------------------------------------------------------ funding
export function FundingTab({ draft, patch, errors }: { draft: ClientDraft; patch: Patch; errors: DraftErrors }) {
  return (
    <Section
      icon={<Landmark size={18} aria-hidden="true" />}
      title="Funding & authorization"
      subtitle="Self-determination receipt details printed on this client's invoices."
    >
      <div className="u2-grid-2">
        <Field label="Funding source" hint="e.g. Medicaid waiver, county, private pay" error={errors.fundingSource}>
          <Input value={draft.fundingSource} onChange={(e) => patch({ fundingSource: e.target.value })} />
        </Field>
        <Field label="Authorization #" error={errors.authorizationNumber}>
          <Input value={draft.authorizationNumber} className="mono" onChange={(e) => patch({ authorizationNumber: e.target.value })} />
        </Field>
        <Field label="FMS (bill payer)" hint="Financial Management Services name — the invoice is billed to it." error={errors.fiscalIntermediary}>
          <Input value={draft.fiscalIntermediary} onChange={(e) => patch({ fiscalIntermediary: e.target.value })} />
        </Field>
        <Field label="FMS billing address" hint="Printed under Bill to." error={errors.fmsAddress}>
          <Textarea rows={2} value={draft.fmsAddress} maxLength={300} onChange={(e) => patch({ fmsAddress: e.target.value })} />
        </Field>
        <Field label="UCI #" hint="Regional Center Unique Client Identifier." error={errors.uciNumber}>
          <Input value={draft.uciNumber} className="mono" maxLength={20} onChange={(e) => patch({ uciNumber: e.target.value })} />
        </Field>
        <Field label="Authorization # override" hint="Leave empty to use the spending plan authorization from Drive." error={errors.authorizationOverride}>
          <Input value={draft.authorizationOverride} className="mono" maxLength={80} onChange={(e) => patch({ authorizationOverride: e.target.value })} />
        </Field>
        <Field label="Authorized representative" hint="Optional. Signs invoices on the participant's behalf." error={errors.representativeName}>
          <Input value={draft.representativeName} maxLength={120} onChange={(e) => patch({ representativeName: e.target.value })} />
        </Field>
        <Field label="Authorized hours" hint="For the current authorization period (informational)." error={errors.authorizedHours}>
          <Input value={draft.authorizedHours} inputMode="decimal" placeholder="e.g. 40" onChange={(e) => patch({ authorizedHours: e.target.value })} />
        </Field>
        <Field label="Case manager" error={errors.caseManager}>
          <Input value={draft.caseManager} onChange={(e) => patch({ caseManager: e.target.value })} />
        </Field>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ templates
type TplState = Partial<Record<FileKind, DocumentTemplate[] | { error: unknown }>>;

export function TemplatesTab({ draft, patch }: { draft: ClientDraft; patch: Patch }) {
  const [tpls, setTpls] = useState<TplState>({});
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    for (const { kind } of FILE_KINDS) {
      api
        .listTemplates(kind)
        .then((list) => alive && setTpls((p) => ({ ...p, [kind]: list.filter((t) => t.kind === kind) })))
        .catch((error) => alive && setTpls((p) => ({ ...p, [kind]: { error } })));
    }
    return () => {
      alive = false;
    };
  }, [epoch]);

  return (
    <Section
      icon={<LayoutTemplate size={18} aria-hidden="true" />}
      title="Templates"
      subtitle={
        <>
          Choose a document design per file for this client, or keep your default. <a href="#/templates">Manage templates</a>
        </>
      }
    >
      <div className="cl-tpl-list">
        {FILE_KINDS.map(({ kind, label }) => {
          const st = tpls[kind];
          const current = draft.templates[kind];
          if (st && "error" in st) {
            return <ErrorNotice key={kind} title={`Couldn't load ${label.toLowerCase()} templates`} error={st.error} onRetry={() => setEpoch((e) => e + 1)} />;
          }
          const list = st ?? null;
          const def = list?.find((t) => t.isDefault);
          const missing = current != null && list != null && !list.some((t) => t.id === current);
          return (
            <div key={kind} className="cl-tpl-row">
              <Field label={label} hint={def ? `Default: ${def.name}` : undefined}>
                {list == null ? (
                  <Skeleton height={40} radius={10} />
                ) : (
                  <Select
                    value={current ?? ""}
                    onChange={(e) => patch({ templates: { ...draft.templates, [kind]: e.target.value || null } })}
                    options={[
                      { value: "", label: def ? `Default (${def.name})` : "Default" },
                      ...(missing ? [{ value: current!, label: "Missing template (deleted)" }] : []),
                      ...list.map((t) => ({ value: t.id, label: t.builtin ? `${t.name} · built-in` : t.name })),
                    ]}
                  />
                )}
              </Field>
              {current && !missing && (
                <a className="ds-btn ds-btn-ghost ds-btn-sm cl-tpl-open" href={`#/templates/${encodeURIComponent(current)}`}>
                  <ExternalLink size={14} aria-hidden="true" /> Open
                </a>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
