import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, ExternalLink, Info, MailPlus, Send } from "lucide-react";
import type { CompletedSessionFiles, Connection, ConnectionProvider, EmailDraftRequest, FileDelivery, FileKind, SettingsBundle } from "../../../contracts";
import { api } from "../../api";
import { Button, Dialog, Field, Input, Textarea, formatNumber } from "../../design";
import { EmailChips } from "../settings/EmailChips";
import { FileKindChecks } from "../settings/FileKindChecks";
import { ProviderChoice } from "../settings/ProviderChoice";
import { inlineError } from "../settings/SaveBar";
import { CONNECTION_LABELS, renderTemplatePreview, serviceDateIn } from "../settings/shared";

export function templateVars(item: CompletedSessionFiles, identity: string | null): Record<string, string> {
  return {
    clientRef: item.clientRef,
    serviceDate: serviceDateIn(item.startAt, item.timezone),
    serviceCode: item.serviceCode,
    amount: item.amountCents != null ? formatNumber(item.amountCents, "cents") : "—",
    revision: String(item.bundleRevision),
    ...(identity ? { providerIdentity: identity } : {}),
  };
}

export function EmailDraftDialog({
  item,
  open,
  onClose,
  settings,
  connections,
  identity,
  onDelivery,
}: {
  item: CompletedSessionFiles;
  open: boolean;
  onClose: () => void;
  settings: SettingsBundle | null;
  connections: Connection[];
  identity: string | null;
  onDelivery: (d: FileDelivery) => void;
}) {
  const reduce = useReducedMotion();
  const connected = connections.filter((c) => c.status === "connected").map((c) => c.provider);
  const email = settings?.email;
  const vars = useMemo(() => templateVars(item, identity), [item, identity]);
  const preSubject = email ? renderTemplatePreview(email.subjectTemplate, vars) : "";
  const preBody = email ? renderTemplatePreview(email.bodyTemplate, vars) : "";

  const [provider, setProvider] = useState<ConnectionProvider | null>(null);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<FileKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<FileDelivery | null>(null);
  const [touched, setTouched] = useState(false);

  // Reset each time it opens.
  useEffect(() => {
    if (!open) return;
    const pref = email?.provider && connected.includes(email.provider) ? email.provider : (connected[0] ?? null);
    setProvider(pref);
    setTo(email?.defaultTo ?? []);
    setCc(email?.defaultCc ?? []);
    setSubject(preSubject);
    setBody(preBody);
    setFiles(email?.attach?.length ? email.attach : item.files.map((f) => f.kind));
    setErr(null);
    setResult(null);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toErr = touched && to.length === 0 ? "Add at least one recipient." : null;
  const filesErr = touched && files.length === 0 ? "Choose at least one file." : null;
  const subjectErr = touched && !subject.trim() ? "Subject is required." : null;

  async function create() {
    setTouched(true);
    if (!provider || to.length === 0 || files.length === 0 || !subject.trim()) return;
    setBusy(true);
    setErr(null);
    const req: EmailDraftRequest = { provider, to, files };
    if (cc.length) req.cc = cc;
    // Only send text the user edited; otherwise the server renders the real template.
    if (subject !== preSubject) req.subject = subject.trim();
    if (body !== preBody) req.body = body;
    try {
      const d = await api.createEmailDraft(item.sessionId, req);
      onDelivery(d);
      setResult(d);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const mailName = provider ? CONNECTION_LABELS[provider].mail : "your mailbox";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={result ? "Draft ready" : `Email draft · ${item.clientRef}`}
      description={result ? undefined : "We create a draft with the PDFs attached. You review it and press Send — this app never sends email."}
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            {result.webUrl && (
              <a className="ds-btn ds-btn-primary ds-btn-md u2-link-btn" href={result.webUrl} target="_blank" rel="noopener noreferrer">
                Open draft in {mailName} <ExternalLink size={16} aria-hidden="true" />
              </a>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" icon={<MailPlus size={16} />} loading={busy} disabled={!provider} onClick={() => void create()}>
              Create draft
            </Button>
          </>
        )
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {result ? (
          <motion.div
            key="ok"
            className="u2-draft-ok"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 22 }}
          >
            <motion.span
              className="u2-draft-ok-ico"
              initial={reduce ? false : { scale: 0, rotate: -40 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 14, delay: 0.1 }}
            >
              <CheckCircle2 size={40} aria-hidden="true" />
            </motion.span>
            <h3 className="u2-h2" role="status">
              Draft created in {CONNECTION_LABELS[result.provider].mail} — open it and press Send
            </h3>
            <p className="u2-muted">
              Nothing has been sent. The draft to {result.recipients.join(", ")} is waiting in your Drafts folder with{" "}
              {result.files.length} PDF{result.files.length === 1 ? "" : "s"} attached.
              {!result.webUrl && " Open your mail app to find it."}
            </p>
            <p className="u2-note">
              <Send size={14} aria-hidden="true" /> You stay in control: review recipients and attachments, then press Send yourself.
            </p>
          </motion.div>
        ) : (
          <motion.div key="form" className="u2-composer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {connected.length === 0 ? (
              <div className="u2-note u2-note-warn">
                <Info size={16} aria-hidden="true" />
                <span>
                  No mail account is connected. <a href="#/connections">Connect Google or Microsoft</a> to create drafts.
                </span>
              </div>
            ) : (
              <ProviderChoice
                name={`draft-provider-${item.sessionId}`}
                legend="Create the draft in"
                kind="mail"
                value={provider}
                connections={connections}
                only={connected}
                onChange={(p) => p && setProvider(p)}
              />
            )}
            <div className="u2-grid-2">
              <EmailChips label="To" required value={to} onChange={setTo} error={toErr} />
              <EmailChips label="Cc" value={cc} onChange={setCc} />
            </div>
            <Field label="Subject" error={subjectErr ?? undefined}>
              <Input value={subject} maxLength={250} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Message" hint="Preview of your template with this session's values. The server fills the real values when it creates the draft.">
              <Textarea rows={7} value={body} maxLength={10_000} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <FileKindChecks legend="Attach" value={files} onChange={setFiles} error={filesErr} />
            {inlineError(err) && (
              <motion.p className="u2-inline-error" role="alert" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                {inlineError(err)}
              </motion.p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Dialog>
  );
}
