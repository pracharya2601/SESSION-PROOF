import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, ExternalLink } from "lucide-react";
import type { FileKind } from "../../../contracts";
import { api } from "../../api";
import { Button, Dialog, Spinner } from "../../design";
import { FILE_LABELS } from "../settings/shared";

export function PreviewDialog({
  sessionId,
  kind,
  clientRef,
  filename,
  onClose,
}: {
  sessionId: string;
  kind: FileKind | null;
  clientRef: string;
  filename?: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = kind ? api.fileUrl(sessionId, kind, { inline: true }) : "";
  return (
    <Dialog
      open={kind != null}
      onClose={onClose}
      size="lg"
      title={kind ? `${FILE_LABELS[kind]} · ${clientRef}` : ""}
      description={filename}
      footer={
        kind && (
          <>
            <a className="ds-btn ds-btn-ghost ds-btn-md u2-link-btn" href={src} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" /> Open in new tab
            </a>
            <a className="ds-btn ds-btn-primary ds-btn-md u2-link-btn" href={api.fileUrl(sessionId, kind)} download={filename ?? true}>
              <Download size={16} aria-hidden="true" /> Download
            </a>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {kind && (
        <div className="u2-pdf-frame">
          <AnimatePresence>
            {loaded !== src && (
              <motion.div key="load" className="u2-pdf-loading" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Spinner size={22} label="Loading preview" />
              </motion.div>
            )}
          </AnimatePresence>
          <iframe key={src} src={src} title={`${FILE_LABELS[kind]} preview`} onLoad={() => setLoaded(src)} />
        </div>
      )}
    </Dialog>
  );
}
