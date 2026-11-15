/**
 * Settings → Business profile: the provider's business details printed on every invoice
 * (letterhead, vendor #, remit-to, numbering). Captured once. Approval is blocked until the
 * required fields (business name, vendor #, address) are filled.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, ImagePlus, Trash2 } from "lucide-react";
import type { BusinessProfileView, ProviderProfileInput } from "../../../contracts";
import { api } from "../../api";
import { Badge, Button, Card, ErrorNotice, Field, Input, Skeleton, Textarea, errorMessage, useToast } from "../../design";

// Local copies of contract limits (keeps zod out of the UI bundle).
const LOGO_MAX_BYTES = 100 * 1024;
const PREFIX_RE = /^[A-Za-z0-9-]*$/;

type TextKey = Exclude<keyof ProviderProfileInput, "logoDataUrl" | "nextInvoiceNumber" | "invoicePrefix">;
type Draft = Record<TextKey, string> & { invoicePrefix: string; nextInvoiceNumber: string; logoDataUrl: string | null };

const TEXT_KEYS: TextKey[] = [
  "legalName",
  "dba",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "phone",
  "email",
  "vendorNumber",
  "npi",
  "taxIdLast4",
  "remitTo",
  "signerName",
  "paymentTerms",
];

function toDraft(p: ProviderProfileInput): Draft {
  const d = { invoicePrefix: p.invoicePrefix, nextInvoiceNumber: String(p.nextInvoiceNumber), logoDataUrl: p.logoDataUrl } as Draft;
  for (const k of TEXT_KEYS) d[k] = (p[k] as string | null) ?? "";
  return d;
}

function toInput(d: Draft): { input: ProviderProfileInput | null; errors: Partial<Record<keyof Draft, string>> } {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const opt = (s: string) => (s.trim() === "" ? null : s.trim());
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) errors.email = "Enter an address like billing@example.com.";
  if (d.npi.trim() && !/^\d{10}$/.test(d.npi.trim())) errors.npi = "NPI is 10 digits.";
  if (d.taxIdLast4.trim() && !/^\d{4}$/.test(d.taxIdLast4.trim())) errors.taxIdLast4 = "Enter the last 4 digits only.";
  if (!PREFIX_RE.test(d.invoicePrefix.trim()) || d.invoicePrefix.trim().length > 12) errors.invoicePrefix = "Up to 12 letters, numbers and dashes.";
  const next = Number(d.nextInvoiceNumber.trim());
  if (!/^\d{1,8}$/.test(d.nextInvoiceNumber.trim()) || next < 1) errors.nextInvoiceNumber = "A whole number from 1.";
  if (Object.keys(errors).length) return { input: null, errors };
  const input = {
    invoicePrefix: d.invoicePrefix.trim(),
    nextInvoiceNumber: next,
    logoDataUrl: d.logoDataUrl,
  } as ProviderProfileInput;
  for (const k of TEXT_KEYS) (input as Record<string, unknown>)[k] = opt(d[k]);
  return { input, errors };
}

function previewNumber(prefix: string, next: string): string {
  const n = /^\d+$/.test(next.trim()) ? next.trim().padStart(4, "0") : "0001";
  const p = prefix.trim();
  return p ? `${p}-${n}` : n;
}

export function BusinessProfileSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const toast = useToast();
  const [view, setView] = useState<BusinessProfileView | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((v: BusinessProfileView) => {
    setView(v);
    setDraft(toDraft(v.profile));
  }, []);
  const load = useCallback(() => {
    setLoadErr(null);
    api.getBusinessProfile().then(apply).catch(setLoadErr);
  }, [apply]);
  useEffect(load, [load]);

  const dirty = !!view && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(view.profile));
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  if (loadErr) return <ErrorNotice title="Couldn't load the business profile" error={loadErr} onRetry={load} />;
  if (!view || !draft) {
    return (
      <Card padding="lg" aria-busy="true">
        <Skeleton lines={8} />
      </Card>
    );
  }

  const { input, errors } = toInput(draft);
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const text = (k: TextKey, label: string, o: { hint?: string; placeholder?: string; max?: number; mono?: boolean; required?: boolean } = {}) => (
    <Field label={label} hint={o.hint} error={errors[k]} required={o.required}>
      <Input value={draft[k]} maxLength={o.max ?? 120} placeholder={o.placeholder} className={o.mono ? "mono" : undefined} onChange={(e) => set(k)(e.target.value)} />
    </Field>
  );

  async function save() {
    if (!input) return;
    setSaving(true);
    try {
      apply(await api.saveBusinessProfile(input));
      toast.success("Business profile saved");
    } catch (e) {
      toast.error("Couldn't save", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  function pickLogo(file: File | undefined) {
    setLogoError(null);
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") return setLogoError("Use a PNG or JPEG image.");
    if (file.size > LOGO_MAX_BYTES) return setLogoError("The logo must be 100 KB or smaller.");
    const r = new FileReader();
    r.onload = () => typeof r.result === "string" && setDraft((d) => (d ? { ...d, logoDataUrl: r.result as string } : d));
    r.onerror = () => setLogoError("Couldn't read that file.");
    r.readAsDataURL(file);
  }

  const missing = view.missing;

  return (
    <div className="u2-tab-stack">
      <Card padding="lg" className="u2-section">
        <div className="u2-section-head">
          <span className="u2-section-ico">
            <Building2 size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="u2-h2">Business profile</h2>
            <p className="u2-muted">
              Printed on every invoice you send to a participant's FMS: your business name, address, vendor number and how to pay you. Approved
              invoices keep the details they were approved with.
            </p>
          </div>
        </div>

        <p className={missing.length ? "warn-box small" : "u2-muted"} role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {missing.length ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
          <span>
            {missing.length
              ? `Approval is blocked until you add: ${missing.join(", ")}.`
              : "Complete — invoices show your business details."}
          </span>
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: "grid", gap: 18 }}
        >
          <div className="u2-grid-2">
            {text("legalName", "Legal / business name", { required: true, placeholder: "Example Support Services LLC" })}
            {text("dba", "DBA (doing business as)", { hint: "Optional." })}
            {text("vendorNumber", "Vendor #", { required: true, hint: "Regional Center / FMS vendor number.", mono: true, max: 40 })}
            {text("signerName", "Authorized signer", { hint: "Typed name used as your e-signature at approval." })}
          </div>
          <div className="u2-grid-2">
            {text("addressLine1", "Street address", { required: true })}
            {text("addressLine2", "Address line 2", { hint: "Optional." })}
            {text("city", "City", { required: true, max: 60 })}
            {text("state", "State", { required: true, max: 30, placeholder: "CA" })}
            {text("postalCode", "ZIP", { required: true, max: 20, mono: true })}
            {text("phone", "Business phone", { max: 40 })}
            {text("email", "Business email", { hint: "Shown on the invoice for billing questions.", max: 254 })}
          </div>
          <div className="u2-grid-2">
            {text("npi", "NPI", { hint: "Optional, 10 digits.", mono: true, max: 10 })}
            {text("taxIdLast4", "Tax ID — last 4 digits", { hint: "Optional. Never enter the full number.", mono: true, max: 4 })}
          </div>
          <Field label="Remit to" hint="Where the FMS sends payment. Leave empty to use the business address." error={errors.remitTo}>
            <Textarea rows={3} maxLength={400} value={draft.remitTo} onChange={(e) => set("remitTo")(e.target.value)} />
          </Field>
          <div className="u2-grid-2">
            <Field label="Invoice number prefix" hint="Letters, numbers and dashes." error={errors.invoicePrefix}>
              <Input className="mono" maxLength={12} value={draft.invoicePrefix} onChange={(e) => set("invoicePrefix")(e.target.value)} />
            </Field>
            <Field
              label="Next invoice number"
              hint={`Numbers are assigned in order when you approve and are never reused. Next: ${previewNumber(draft.invoicePrefix, draft.nextInvoiceNumber)}`}
              error={errors.nextInvoiceNumber}
            >
              <Input className="mono" inputMode="numeric" maxLength={8} value={draft.nextInvoiceNumber} onChange={(e) => set("nextInvoiceNumber")(e.target.value)} />
            </Field>
            {text("paymentTerms", "Payment terms", { placeholder: "Net 30", max: 300 })}
          </div>

          <Field label="Logo" hint="Optional. PNG or JPEG, 100 KB or smaller." error={logoError ?? undefined}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {draft.logoDataUrl ? (
                <img src={draft.logoDataUrl} alt="Business logo" style={{ maxHeight: 56, maxWidth: 180, objectFit: "contain", background: "#fff", borderRadius: 6, padding: 4 }} />
              ) : (
                <Badge tone="neutral">No logo</Badge>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => pickLogo(e.target.files?.[0])} />
              <Button type="button" variant="secondary" size="sm" icon={<ImagePlus size={14} />} onClick={() => fileRef.current?.click()}>
                {draft.logoDataUrl ? "Replace" : "Upload"}
              </Button>
              {draft.logoDataUrl && (
                <Button type="button" variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => setDraft((d) => (d ? { ...d, logoDataUrl: null } : d))}>
                  Remove
                </Button>
              )}
            </div>
          </Field>

          <div style={{ display: "flex", gap: 10 }}>
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty || !input || saving}>
              Save business profile
            </Button>
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => setDraft(toDraft(view.profile))} disabled={saving}>
                Discard
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
