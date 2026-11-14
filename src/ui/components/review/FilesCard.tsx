import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, Eye, FileCheck2, FileSignature, FileText, FolderUp, Mail, Receipt, Send, X } from "lucide-react";
import type { FileKind } from "../../../contracts";
import { api, ApiClientError } from "../../api";
import { Button, Dialog, Field, Input, useToast } from "../../design";
import { SessionDocPreview } from "../doc/SessionDocPreview";
import { Section } from "./Section";
import { rvSpring, useMotionOK } from "./motion";

// Local copies (contracts value exports would pull zod into the bundle).
const KINDS: { kind: FileKind; label: string; hint: string; Icon: typeof FileText }[] = [
  { kind: "session_note", label: "Session Note", hint: "Clinical documentation", Icon: FileText },
  { kind: "invoice", label: "Invoice", hint: "Server-calculated billing", Icon: Receipt },
  { kind: "approval_record", label: "Approval Record", hint: "Who approved what, when", Icon: FileSignature },
];

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function parseRecipients(raw: string): { ok: string[]; bad: string[] } {
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: parts.filter((p) => EMAIL_RE.test(p)), bad: parts.filter((p) => !EMAIL_RE.test(p)) };
}

function describe(e: unknown): { message: string; needsConnection: boolean } {
  if (e instanceof ApiClientError) {
    const needsConnection = /CONNECT|NOT_CONNECTED|RECONNECT|SCOPE|TOKEN/i.test(e.code) || e.status === 412;
    return { message: e.message + (e.correlationId ? ` (Reference: ${e.correlationId})` : ""), needsConnection };
  }
  return { message: e instanceof Error ? e.message : "Unexpected error.", needsConnection: false };
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** COMPLETED: the three PDFs with download / preview, plus Save to Drive and Email draft quick actions. */
export function FilesCard(props: { sessionId: string; revision: number | null }) {
  const ok = useMotionOK();
  const toast = useToast();
  const [preview, setPreview] = useState<{ kind: FileKind; label: string } | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [composer, setComposer] = useState(false);
  const [to, setTo] = useState("");
  const [toError, setToError] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);

  async function saveToDrive() {
    if (driveBusy) return;
    setDriveBusy(true);
    try {
      const d = await api.uploadToDrive(props.sessionId, {});
      if (d.status === "failed") {
        toast.toast({ tone: "danger", title: "Drive upload failed", description: d.error ?? "The provider rejected the upload." });
      } else {
        toast.toast({
          tone: "success",
          title: d.status === "pending" ? "Uploading to Drive…" : "Saved to Drive",
          description: `${d.files.length} file${d.files.length === 1 ? "" : "s"} · ${d.provider === "google" ? "Google Drive" : "OneDrive"}`,
          action: d.webUrl ? { label: "Open folder", onClick: () => openExternal(d.webUrl!) } : undefined,
        });
      }
    } catch (e) {
      const { message, needsConnection } = describe(e);
      toast.toast({
        tone: "danger",
        title: "Could not save to Drive",
        description: message,
        action: needsConnection ? { label: "Open Connections", onClick: () => (window.location.hash = "#/connections") } : undefined,
      });
    } finally {
      setDriveBusy(false);
    }
  }

  async function createDraft() {
    if (draftBusy) return;
    const { ok: recipients, bad } = parseRecipients(to);
    if (recipients.length === 0) {
      setToError("Enter at least one recipient email address.");
      return;
    }
    if (bad.length > 0) {
      setToError(`Not a valid email: ${bad.join(", ")}`);
      return;
    }
    if (recipients.length > 10) {
      setToError("At most 10 recipients.");
      return;
    }
    setToError(null);
    setDraftBusy(true);
    try {
      const d = await api.createEmailDraft(props.sessionId, { to: recipients });
      if (d.status === "failed") {
        toast.toast({ tone: "danger", title: "Draft failed", description: d.error ?? "The provider rejected the draft." });
      } else {
        toast.toast({
          tone: "success",
          title: "Email draft created",
          description: `To ${recipients.join(", ")} — review and press Send in your mail app. Nothing was sent.`,
          action: d.webUrl ? { label: "Open draft", onClick: () => openExternal(d.webUrl!) } : undefined,
        });
        setComposer(false);
        setTo("");
      }
    } catch (e) {
      const { message, needsConnection } = describe(e);
      toast.toast({
        tone: "danger",
        title: "Could not create the draft",
        description: message,
        action: needsConnection ? { label: "Open Connections", onClick: () => (window.location.hash = "#/connections") } : undefined,
      });
    } finally {
      setDraftBusy(false);
    }
  }

  return (
    <Section
      label="Files"
      title="Files"
      icon={<FileCheck2 size={18} />}
      className="rv-files"
      glow
      aside={props.revision !== null ? <span className="rv-count">r{props.revision}</span> : undefined}
    >
      <p className="rv-muted rv-small">Final PDFs for the approved revision.</p>
      <motion.ul
        className="rv-file-list"
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: ok ? 0.08 : 0 } } }}
      >
        {KINDS.map(({ kind, label, hint, Icon }) => (
          <motion.li
            key={kind}
            className="rv-file"
            variants={
              ok
                ? { hidden: { opacity: 0, x: 16, rotateY: -12 }, show: { opacity: 1, x: 0, rotateY: 0, transition: rvSpring } }
                : { hidden: { opacity: 0 }, show: { opacity: 1 } }
            }
          >
            <span className={`rv-file-ico rv-file-ico-${kind}`} aria-hidden="true">
              <Icon size={18} />
              <span className="rv-file-ext">PDF</span>
            </span>
            <span className="rv-file-text">
              <span className="rv-file-label">{label}</span>
              <span className="rv-muted rv-small">{hint}</span>
            </span>
            <span className="rv-file-actions">
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`Preview ${label}`}
                title="Preview"
                icon={<Eye size={16} />}
                onClick={() => setPreview({ kind, label })}
              />
              <a
                className="ds-btn ds-btn-secondary ds-btn-sm ds-btn-icon"
                href={api.fileUrl(props.sessionId, kind)}
                download
                aria-label={`Download ${label} PDF`}
                title="Download"
              >
                <Download size={16} aria-hidden="true" />
              </a>
            </span>
          </motion.li>
        ))}
      </motion.ul>

      <div className="rv-file-quick">
        <Button variant="primary" size="sm" loading={driveBusy} icon={<FolderUp size={16} />} onClick={() => void saveToDrive()}>
          {driveBusy ? "Saving…" : "Save to Drive"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={composer ? <X size={16} /> : <Mail size={16} />}
          aria-expanded={composer}
          aria-controls="rv-email-composer"
          onClick={() => {
            setComposer((c) => !c);
            setToError(null);
          }}
        >
          {composer ? "Cancel" : "Email draft"}
        </Button>
        <a className="rv-link rv-small" href="#/files">
          All files
        </a>
      </div>

      <AnimatePresence initial={false}>
        {composer && (
          <motion.form
            id="rv-email-composer"
            key="composer"
            className="rv-composer"
            initial={ok ? { opacity: 0, height: 0 } : { opacity: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={ok ? { opacity: 0, height: 0 } : { opacity: 0 }}
            transition={rvSpring}
            onSubmit={(e) => {
              e.preventDefault();
              void createDraft();
            }}
            aria-label="Email draft"
          >
            <Field
              id="rv-email-to"
              label="To"
              required
              error={toError ?? undefined}
              hint="Comma-separated. Creates a draft with the PDFs attached — you press Send in your mail app."
            >
              <Input
                type="text"
                inputMode="email"
                autoComplete="email"
                placeholder="billing@example.org"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <div className="rv-row">
              <Button type="submit" variant="primary" size="sm" loading={draftBusy} icon={<Send size={16} />}>
                {draftBusy ? "Creating…" : "Create draft"}
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? `${preview.label} preview` : "Preview"}
        size="lg"
        footer={
          preview && (
            <a className="ds-btn ds-btn-primary ds-btn-md" href={api.fileUrl(props.sessionId, preview.kind)} download>
              <Download size={16} aria-hidden="true" /> Download PDF
            </a>
          )
        }
      >
        {preview && <SessionDocPreview key={preview.kind} sessionId={props.sessionId} kind={preview.kind} />}
      </Dialog>
    </Section>
  );
}
