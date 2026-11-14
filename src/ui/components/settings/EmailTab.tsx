import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Braces, Mail, Paperclip } from "lucide-react";
import type { Connection, EmailSettings, SettingsBundle } from "../../../contracts";
import { api } from "../../api";
import { Card, Field, Input, Textarea, fadeOnly, fadeUp, pressable, stagger, useToast } from "../../design";
import { EmailChips } from "./EmailChips";
import { FILE_ICONS, FileKindChecks } from "./FileKindChecks";
import { ProviderChoice } from "./ProviderChoice";
import { SaveBar } from "./SaveBar";
import { CONNECTION_LABELS, FILE_LABELS, SAMPLE_VARS, TEMPLATE_PLACEHOLDERS, renderTemplatePreview, type Placeholder } from "./shared";

function same(a: EmailSettings, b: EmailSettings) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const PH_LABELS: Record<Placeholder, string> = {
  clientRef: "Client ref",
  serviceDate: "Service date",
  serviceCode: "Service code",
  amount: "Amount",
  revision: "Revision",
  providerIdentity: "Your identity",
};

export function EmailTab({
  bundle,
  connections,
  onSaved,
  onDirtyChange,
}: {
  bundle: SettingsBundle;
  connections: Connection[];
  onSaved: (b: SettingsBundle) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [draft, setDraft] = useState<EmailSettings>(bundle.email);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  useEffect(() => setDraft(bundle.email), [bundle.email]);
  const dirty = !same(draft, bundle.email);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const subjectErr = !draft.subjectTemplate.trim() ? "Subject is required." : draft.subjectTemplate.length > 250 ? "Max 250 characters." : null;
  const bodyErr = draft.bodyTemplate.length > 10_000 ? "Max 10,000 characters." : null;

  function insert(ph: Placeholder) {
    const token = `{${ph}}`;
    const which = lastField.current;
    const el = which === "subject" ? subjectRef.current : bodyRef.current;
    const key = which === "subject" ? "subjectTemplate" : "bodyTemplate";
    const cur = draft[key];
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    setDraft({ ...draft, [key]: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const b = await api.saveEmailSettings(draft);
      onSaved(b);
      toast.success("Email settings saved");
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  }

  const v = reduce ? fadeOnly : fadeUp;
  const subjPreview = renderTemplatePreview(draft.subjectTemplate, SAMPLE_VARS);
  const bodyPreview = renderTemplatePreview(draft.bodyTemplate, SAMPLE_VARS);

  return (
    <motion.div className="u2-tab-stack" variants={stagger} initial="hidden" animate="show">
      <motion.div variants={v}>
        <Card padding="lg" className="u2-section">
          <div className="u2-section-head">
            <span className="u2-section-ico">
              <Mail size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 className="u2-h2">Email drafts</h2>
              <p className="u2-muted">
                We create a <strong>draft</strong> in your mailbox with the PDFs attached. You review it and press Send — this
                app never sends email.
              </p>
            </div>
          </div>
          <ProviderChoice
            name="mail-provider"
            legend="Mail provider"
            kind="mail"
            value={draft.provider}
            connections={connections}
            onChange={(provider) => setDraft({ ...draft, provider })}
          />
          <div className="u2-grid-2">
            <EmailChips label="Default To" value={draft.defaultTo} onChange={(defaultTo) => setDraft({ ...draft, defaultTo })} hint="Prefilled in every draft; you can change it per session." />
            <EmailChips label="Default Cc" value={draft.defaultCc} onChange={(defaultCc) => setDraft({ ...draft, defaultCc })} />
          </div>
        </Card>
      </motion.div>

      <motion.div variants={v} className="u2-split">
        <Card padding="lg" className="u2-section">
          <div className="u2-ph-row" role="group" aria-label="Insert placeholder at cursor">
            <span className="u2-ph-label">
              <Braces size={14} aria-hidden="true" /> Insert
            </span>
            {TEMPLATE_PLACEHOLDERS.map((ph) => (
              <motion.button
                key={ph}
                type="button"
                className="u2-ph-chip"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(ph)}
                title={`Insert {${ph}}`}
                {...(reduce ? {} : pressable)}
              >
                {PH_LABELS[ph]}
              </motion.button>
            ))}
          </div>
          <Field label="Subject template" error={subjectErr ?? undefined}>
            <Input
              ref={subjectRef}
              value={draft.subjectTemplate}
              maxLength={250}
              onFocus={() => (lastField.current = "subject")}
              onChange={(e) => setDraft({ ...draft, subjectTemplate: e.target.value })}
            />
          </Field>
          <Field label="Body template" error={bodyErr ?? undefined} hint="Plain text. Placeholders are filled in by the server when the draft is created.">
            <Textarea
              ref={bodyRef}
              rows={8}
              value={draft.bodyTemplate}
              onFocus={() => (lastField.current = "body")}
              onChange={(e) => setDraft({ ...draft, bodyTemplate: e.target.value })}
            />
          </Field>
          <FileKindChecks legend="Attach by default" value={draft.attach} onChange={(attach) => setDraft({ ...draft, attach })} />
        </Card>

        <Card padding="lg" className="u2-mail-preview" aria-label="Live preview with sample values">
          <div className="u2-mail-preview-head">
            <span className="u2-path-label">Live preview · sample C-104</span>
            <span className="u2-muted u2-small">{draft.provider ? CONNECTION_LABELS[draft.provider].mail : "Mail"} draft</span>
          </div>
          <dl className="u2-mail-meta">
            <dt>To</dt>
            <dd>{draft.defaultTo.join(", ") || <span className="u2-muted">— chosen per session —</span>}</dd>
            {draft.defaultCc.length > 0 && (
              <>
                <dt>Cc</dt>
                <dd>{draft.defaultCc.join(", ")}</dd>
              </>
            )}
            <dt>Subject</dt>
            <dd className="u2-mail-subject">{subjPreview || <span className="u2-muted">—</span>}</dd>
          </dl>
          <pre className="u2-mail-body">{bodyPreview}</pre>
          <div className="u2-mail-attach">
            {draft.attach.length === 0 && <span className="u2-muted u2-small">No attachments</span>}
            {draft.attach.map((k) => {
              const Icon = FILE_ICONS[k];
              return (
                <motion.span key={k} layout={!reduce} className="u2-attach-pill" initial={reduce ? false : { opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
                  <Paperclip size={12} aria-hidden="true" />
                  <Icon size={12} aria-hidden="true" />
                  {FILE_LABELS[k]}.pdf
                </motion.span>
              );
            })}
          </div>
        </Card>
      </motion.div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={err}
        invalid={!!subjectErr || !!bodyErr}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(bundle.email);
          setErr(null);
        }}
      />
    </motion.div>
  );
}
