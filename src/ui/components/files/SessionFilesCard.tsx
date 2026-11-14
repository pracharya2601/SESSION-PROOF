import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CalendarDays, ChevronDown, CloudUpload, Download, FlaskConical, History, MailPlus, ShieldCheck } from "lucide-react";
import type { CompletedSessionFiles, Connection, ConnectionProvider, FileDelivery, FileKind, SettingsBundle } from "../../../contracts";
import { api } from "../../api";
import { AnimatedNumber, Badge, Button, Card, errorMessage, fadeOnly, fadeUp, useToast } from "../../design";
import { formatTimeRange } from "../format";
import { CONNECTION_LABELS, formatInstant, serviceDateIn } from "../settings/shared";
import { DeliveryTimeline } from "./DeliveryTimeline";
import { EmailDraftDialog } from "./EmailDraftDialog";
import { FileTiles, downloadAll } from "./FileTiles";
import { PreviewDialog } from "./PreviewDialog";

const POLL_MS = 2000;
const POLL_MAX = 30;

/** Storage provider to use: the settings choice if connected, else the first connected account. */
export function pickStorageProvider(settings: SettingsBundle | null, connections: Connection[]): ConnectionProvider | null {
  const connected = connections.filter((c) => c.status === "connected").map((c) => c.provider);
  const pref = settings?.storage.provider;
  if (pref && connected.includes(pref)) return pref;
  return connected[0] ?? null;
}

export function SessionFilesCard({
  item,
  settings,
  connections,
  identity,
  onDeliveries,
}: {
  item: CompletedSessionFiles;
  settings: SettingsBundle | null;
  connections: Connection[];
  identity: string | null;
  onDeliveries: (sessionId: string, update: (prev: FileDelivery[]) => FileDelivery[]) => void;
}) {
  const reduce = useReducedMotion();
  const toast = useToast();
  const [preview, setPreview] = useState<FileKind | null>(null);
  const [composer, setComposer] = useState(false);
  const [history, setHistory] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const storage = pickStorageProvider(settings, connections);
  const hasMail = connections.some((c) => c.status === "connected");
  const serviceDate = serviceDateIn(item.startAt, item.timezone);

  function upsert(d: FileDelivery) {
    onDeliveries(item.sessionId, (prev) => [d, ...prev.filter((x) => x.id !== d.id)]);
  }

  function announce(d: FileDelivery) {
    const where = CONNECTION_LABELS[d.provider].storage;
    if (d.status === "done") {
      toast.toast({
        tone: "success",
        title: `Saved to ${where}`,
        description: `${d.files.length} PDF${d.files.length === 1 ? "" : "s"} for ${item.clientRef} uploaded.`,
        action: d.webUrl ? { label: "Open folder", onClick: () => window.open(d.webUrl!, "_blank", "noopener,noreferrer") } : undefined,
      });
    } else if (d.status === "failed") {
      toast.error(`Upload to ${where} failed`, d.error ?? "The provider rejected the upload.");
    }
  }

  async function saveToDrive() {
    if (!storage) return;
    setUploading(true);
    try {
      let d = await api.uploadToDrive(item.sessionId, { provider: storage });
      upsert(d);
      for (let i = 0; d.status === "pending" && i < POLL_MAX && alive.current; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const list = await api.listDeliveries(item.sessionId);
        const found = list.find((x) => x.id === d.id);
        if (found) d = found;
        onDeliveries(item.sessionId, () => list);
      }
      if (d.status === "pending") toast.info("Upload is still running", "It continues in the background; check the history later.");
      else announce(d);
    } catch (e) {
      toast.error("Couldn't save to Drive", errorMessage(e));
    } finally {
      if (alive.current) setUploading(false);
    }
  }

  const v = reduce ? fadeOnly : fadeUp;
  const doneCount = item.deliveries.filter((d) => d.status === "done").length;
  const driveTip = storage
    ? `Upload all three PDFs to ${CONNECTION_LABELS[storage].storage}`
    : "Connect Google Drive or OneDrive on the Connections page first";
  const fileName = item.files.find((f) => f.kind === preview)?.filename;

  return (
    <Card as="article" padding="lg" className="u2-session" motionProps={{ variants: v, layout: !reduce }} aria-labelledby={`s-${item.sessionId}`}>
      <div className="u2-session-head">
        <div className="u2-session-id">
          <span className="u2-session-avatar" aria-hidden="true">
            {item.clientRef.replace(/[^A-Za-z0-9]/g, "").slice(0, 3)}
          </span>
          <div>
            <h2 id={`s-${item.sessionId}`} className="u2-session-ref">
              {item.clientRef}
              <span className="u2-session-code">{item.serviceCode}</span>
            </h2>
            <div className="u2-session-meta">
              <span title={formatTimeRange(item.startAt, item.endAt, item.timezone)}>
                <CalendarDays size={13} aria-hidden="true" /> {serviceDate}
              </span>
              <span>
                <ShieldCheck size={13} aria-hidden="true" /> Approved {formatInstant(item.approvedAt, item.timezone)}
              </span>
            </div>
          </div>
        </div>
        <div className="u2-session-right">
          <div className="u2-session-badges">
            <Badge tone="info">Revision {item.bundleRevision}</Badge>
            {item.evidenceMode === "fixture" && (
              <Badge tone="fixture" icon={<FlaskConical size={12} />}>
                Fixture
              </Badge>
            )}
          </div>
          <div className="u2-session-amount">
            {item.amountCents != null ? <AnimatedNumber value={item.amountCents} format="cents" /> : <span className="u2-muted">No charge</span>}
            {item.confirmedMinutes != null && <span className="u2-muted u2-small">{item.confirmedMinutes} min</span>}
          </div>
        </div>
      </div>

      <FileTiles item={item} onPreview={setPreview} />

      <AnimatePresence initial={false}>
        {uploading && (
          <motion.div
            key="prog"
            className="u2-progress"
            role="progressbar"
            aria-label={`Uploading to ${storage ? CONNECTION_LABELS[storage].storage : "cloud"}`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <span className="u2-progress-label">Uploading to {storage ? CONNECTION_LABELS[storage].storage : "cloud"}…</span>
            <span className="u2-progress-track">
              <span className="u2-progress-bar" />
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="u2-session-actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={15} />}
          loading={downloading}
          onClick={async () => {
            setDownloading(true);
            await downloadAll(item);
            if (alive.current) setDownloading(false);
          }}
        >
          Download all
        </Button>
        <span className="u2-tip" data-tip={driveTip}>
          <Button
            variant="primary"
            size="sm"
            icon={<CloudUpload size={15} />}
            loading={uploading}
            disabled={!storage}
            aria-label={storage ? undefined : `Save to Drive — ${driveTip}`}
            onClick={() => void saveToDrive()}
          >
            Save to {storage ? CONNECTION_LABELS[storage].storage : "Drive"}
          </Button>
        </span>
        <span className="u2-tip" data-tip={hasMail ? "Prepare a draft — you press Send" : "Connect Gmail or Outlook first"}>
          <Button variant="secondary" size="sm" icon={<MailPlus size={15} />} onClick={() => setComposer(true)}>
            Email draft
          </Button>
        </span>
        <button
          type="button"
          className="u2-history-toggle"
          aria-expanded={history}
          aria-controls={`h-${item.sessionId}`}
          onClick={() => setHistory((h) => !h)}
        >
          <History size={15} aria-hidden="true" />
          History
          {item.deliveries.length > 0 && <span className="u2-count">{doneCount}/{item.deliveries.length}</span>}
          <motion.span animate={{ rotate: history ? 180 : 0 }} transition={{ type: "spring", stiffness: 400, damping: 25 }} aria-hidden="true">
            <ChevronDown size={15} />
          </motion.span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {history && (
          <motion.div
            id={`h-${item.sessionId}`}
            key="hist"
            className="u2-history"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 32 }}
          >
            <DeliveryTimeline deliveries={item.deliveries} />
          </motion.div>
        )}
      </AnimatePresence>

      <PreviewDialog sessionId={item.sessionId} kind={preview} clientRef={item.clientRef} filename={fileName} onClose={() => setPreview(null)} />
      <EmailDraftDialog
        item={item}
        open={composer}
        onClose={() => setComposer(false)}
        settings={settings}
        connections={connections}
        identity={identity}
        onDelivery={(d) => {
          upsert(d);
          setHistory(true);
        }}
      />
    </Card>
  );
}
