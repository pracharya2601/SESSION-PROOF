import { useCallback, useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { DocModel, FileKind } from "../../../contracts";
import { api } from "../../api";
import { ErrorNotice, Skeleton } from "../../design";
import { DocPreview } from "./DocPreview";

/** Fetches the session's DocModel (api.getDocument) and renders it as paper. */
export function SessionDocPreview({ sessionId, kind }: { sessionId: string; kind: FileKind }) {
  const [model, setModel] = useState<DocModel | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(() => {
    let alive = true;
    setErr(null);
    setModel(null);
    api
      .getDocument(sessionId, kind)
      .then((m) => alive && setModel(m))
      .catch((e) => alive && setErr(e));
    return () => {
      alive = false;
    };
  }, [sessionId, kind]);

  useEffect(() => load(), [load]);

  return (
    <div className="dp-session">
      <p className="dp-session-note">
        <Info size={14} aria-hidden="true" /> Preview — the PDF is generated when you download or sync.
      </p>
      {err != null ? (
        <ErrorNotice title="Couldn't load the preview" error={err} onRetry={() => void load()} />
      ) : model ? (
        <DocPreview model={model} className="dp-session-doc" />
      ) : (
        <div className="dp-session-skel" aria-busy="true" aria-label="Loading preview">
          <Skeleton height={28} width={220} radius={999} />
          <div className="dp-skel-paper">
            <Skeleton height={26} width="55%" />
            <Skeleton lines={3} />
            <Skeleton height={90} radius={6} />
            <Skeleton lines={4} />
          </div>
        </div>
      )}
    </div>
  );
}
