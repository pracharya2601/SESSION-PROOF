import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight, FolderOpen, HardDrive } from "lucide-react";
import type { Connection, SettingsBundle, StorageSettings } from "../../../contracts";
import { api } from "../../api";
import { Card, Field, Input, Switch, fadeOnly, fadeUp, stagger, useToast } from "../../design";
import { ProviderChoice } from "./ProviderChoice";
import { SaveBar } from "./SaveBar";
import { CONNECTION_LABELS, SAMPLE_VARS, renderTemplatePreview } from "./shared";

const INVALID = /[\\:*?"<>|]/;

function same(a: StorageSettings, b: StorageSettings) {
  return a.provider === b.provider && a.folderPath === b.folderPath && a.autoUploadOnComplete === b.autoUploadOnComplete;
}

export function StorageTab({
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
  const [draft, setDraft] = useState<StorageSettings>(bundle.storage);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => setDraft(bundle.storage), [bundle.storage]);
  const dirty = !same(draft, bundle.storage);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const pathErr = !draft.folderPath.trim()
    ? "Folder path is required."
    : INVALID.test(draft.folderPath)
      ? 'Folder path can\'t contain \\ : * ? " < > |'
      : draft.folderPath.length > 300
        ? "Keep the folder path under 300 characters."
        : null;
  const segments = useMemo(
    () =>
      renderTemplatePreview(draft.folderPath, SAMPLE_VARS)
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean),
    [draft.folderPath],
  );
  const conn = draft.provider ? connections.find((c) => c.provider === draft.provider) : undefined;

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const b = await api.saveStorageSettings({ ...draft, folderPath: draft.folderPath.trim() });
      onSaved(b);
      toast.success("Storage settings saved");
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  }

  const v = reduce ? fadeOnly : fadeUp;
  return (
    <motion.div className="u2-tab-stack" variants={stagger} initial="hidden" animate="show">
      <motion.div variants={v}>
        <Card padding="lg" className="u2-section">
          <div className="u2-section-head">
            <span className="u2-section-ico">
              <HardDrive size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 className="u2-h2">Cloud storage</h2>
              <p className="u2-muted">Where "Save to Drive" puts a session's three PDFs.</p>
            </div>
          </div>
          <ProviderChoice
            name="storage-provider"
            legend="Storage provider"
            kind="storage"
            value={draft.provider}
            connections={connections}
            onChange={(provider) =>
              setDraft({ ...draft, provider, autoUploadOnComplete: provider ? draft.autoUploadOnComplete : false })
            }
          />
          <AnimatePresence initial={false}>
            {draft.provider && conn && conn.status !== "connected" && (
              <motion.p
                key="warn"
                className="u2-note u2-note-warn"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
              >
                {CONNECTION_LABELS[draft.provider].storage} isn't connected yet.{" "}
                <a href="#/connections">Connect it on the Connections page</a> before uploads can run.
              </motion.p>
            )}
          </AnimatePresence>
        </Card>
      </motion.div>

      <motion.div variants={v}>
        <Card padding="lg" className="u2-section">
          <Field
            label="Folder path"
            hint="Use {clientRef} and {serviceDate} — the app creates these folders for you."
            error={pathErr ?? undefined}
          >
            <Input
              value={draft.folderPath}
              leading={<FolderOpen size={16} />}
              maxLength={300}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, folderPath: e.target.value })}
            />
          </Field>
          <div className="u2-path-preview" aria-label="Folder preview with sample values">
            <span className="u2-path-label">Preview · C-104 on 2026-11-13</span>
            <div className="u2-path">
              <span className="u2-path-root">{draft.provider ? CONNECTION_LABELS[draft.provider].storage : "My Drive"}</span>
              <AnimatePresence initial={false} mode="popLayout">
                {segments.map((s, i) => (
                  <motion.span
                    key={`${i}-${s}`}
                    layout={!reduce}
                    className="u2-path-seg"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6, scale: 0.9 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ type: "spring", stiffness: 420, damping: 30 }}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                    <span className="u2-path-name">{s}</span>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </div>
          <Switch
            checked={draft.autoUploadOnComplete}
            onChange={(autoUploadOnComplete) => setDraft({ ...draft, autoUploadOnComplete })}
            disabled={!draft.provider}
            label="Upload automatically when a session is completed"
            description={
              draft.provider
                ? "After approval, the three PDFs are uploaded in the background. You can still upload manually from Files."
                : "Choose a storage provider to enable automatic uploads."
            }
          />
        </Card>
      </motion.div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={err}
        invalid={!!pathErr}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(bundle.storage);
          setErr(null);
        }}
      />
    </motion.div>
  );
}
