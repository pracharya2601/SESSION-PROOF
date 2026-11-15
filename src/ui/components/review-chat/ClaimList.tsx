/**
 * Manual fallback for removing a misleading draft statement: one row per extracted claim,
 * with "Remove…" (asks for a reason) or "Restore". Sends edits.rejectedClaims through the
 * normal review save; earlier removals are kept (the server replaces the list).
 */
import { useMemo, useState } from "react";
import { Ban, RotateCcw, Trash2 } from "lucide-react";
import type { ReviewEdits, SessionBundle } from "../../../contracts";
import { Button } from "../../design";
import { CitationChip } from "./AssistantChat";
import { allExtractedClaims, existingRejections, refusedClaimId, removeClaimEdits } from "./helpers";

export function ClaimList(props: {
  bundle: SessionBundle;
  timezone: string;
  editable: boolean;
  busy: boolean;
  onSave: (edits: ReviewEdits) => Promise<unknown>;
  onCite?: (id: string) => void;
}) {
  const { bundle } = props;
  const claims = useMemo(() => allExtractedClaims(bundle), [bundle]);
  const removed = useMemo(() => new Map(existingRejections(bundle).map((r) => [r.claimId, r.reason])), [bundle]);
  const refused = useMemo(() => new Set(bundle.checks.issues.map((i) => refusedClaimId(i)).filter((x): x is string => !!x)), [bundle]);
  const evidence = useMemo(() => new Map(bundle.evidence.map((e) => [e.id, e])), [bundle.evidence]);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (claims.length === 0) return null;

  async function restore(claimId: string) {
    const rest = existingRejections(bundle).filter((r) => r.claimId !== claimId);
    await props.onSave({ rejectedClaims: rest } as ReviewEdits);
  }

  return (
    <div className="rvc-claims">
      <h3 className="rvc-claims-h">Statements in the draft</h3>
      <ul>
        {claims.map((c) => {
          const why = removed.get(c.id);
          const isRefused = refused.has(c.id);
          return (
            <li key={c.id} className={`rvc-claim${why !== undefined ? " is-removed" : ""}${isRefused ? " is-refused" : ""}`}>
              <div className="rvc-claim-main">
                {isRefused && (
                  <span className="rvc-tag rvc-tag-danger" title="Goes beyond what the session evidence shows">
                    <Ban size={12} aria-hidden="true" /> Refused
                  </span>
                )}
                <span className="rvc-claim-text">{c.text}</span>{" "}
                {c.evidenceIds.map((id) => (
                  <CitationChip key={id} id={id} evidence={evidence} timezone={props.timezone} onCite={props.onCite} />
                ))}
                {c.support === "uncertain" && <span className="rvc-tag rvc-tag-warn">Uncertain</span>}
                {why !== undefined && <p className="rvc-claim-why">Removed by provider: {why}</p>}
              </div>
              {props.editable && (
                <div className="rvc-claim-act">
                  {why !== undefined ? (
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} disabled={props.busy} onClick={() => void restore(c.id)}>
                      Restore
                    </Button>
                  ) : open === c.id ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={14} />}
                      disabled={props.busy}
                      onClick={() => {
                        setOpen(c.id);
                        setReason("");
                      }}
                    >
                      Remove…
                    </Button>
                  )}
                </div>
              )}
              {open === c.id && (
                <form
                  className="rvc-claim-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const edits = removeClaimEdits(bundle, c.id, reason);
                    if (!edits) return;
                    await props.onSave(edits);
                    setOpen(null);
                  }}
                >
                  <label htmlFor={`rvc-reason-${c.id}`}>Why remove it? (shown on the note as “removed by provider”)</label>
                  <input
                    id={`rvc-reason-${c.id}`}
                    type="text"
                    maxLength={500}
                    autoFocus
                    value={reason}
                    placeholder="e.g. Overstates one trip as every week"
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <div className="rvc-claim-form-act">
                    <Button type="submit" size="sm" variant="danger" disabled={props.busy || reason.trim().length < 3}>
                      Remove statement
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
