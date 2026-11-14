import { Download } from "lucide-react";
import type { FileKind } from "../../../contracts";
import { api } from "../../api";
import { Button, Dialog } from "../../design";
import { SessionDocPreview } from "../doc/SessionDocPreview";
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
            <a className="ds-btn ds-btn-primary ds-btn-md u2-link-btn" href={api.fileUrl(sessionId, kind)} download={filename ?? true}>
              <Download size={16} aria-hidden="true" /> Download PDF
            </a>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {kind && <SessionDocPreview key={`${sessionId}:${kind}`} sessionId={sessionId} kind={kind} />}
    </Dialog>
  );
}
