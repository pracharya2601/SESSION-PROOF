import { useState } from "react";
import { Check, Sparkles, UserRoundPen, X } from "lucide-react";
import { Badge, Button, Card, Field, Select } from "../../design";
import { clockOf, confidenceLabel, confidenceTone, type PickOption } from "./model";
import type { RecordingSuggestion } from "./types";
import "./recordings.css";

/**
 * One pending content suggestion: client, confidence, rationale; Accept / Reject / Pick another
 * client (from the timeline's events, then known clients). The parent calls the API.
 */
export function SuggestionCard({
  s,
  options,
  busy,
  timeZone,
  onAccept,
  onReject,
}: {
  s: RecordingSuggestion;
  options: PickOption[];
  busy: boolean;
  timeZone?: string;
  onAccept: (body: { eventId?: string; clientRef?: string } | null) => void;
  onReject: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState("");
  const chosen = options.find((o) => o.value === pick) ?? null;
  const canAccept = !!(s.suggestedClientRef || s.eventId);
  const segs = s.segmentIndexes.length;

  return (
    <Card as="article" padding="md" className="rc-sug" aria-label={`Suggestion for ${s.suggestedClientRef ?? "an unknown client"}`}>
      <div className="rc-sug-head">
        <div>
          <span className="tiny muted">Suggested client</span>
          <div className="rc-sug-client mono">{s.suggestedClientRef ?? "No client"}</div>
          <span className="tiny muted">
            {clockOf(s.from, timeZone)}–{clockOf(s.to, timeZone)} · {segs} segment{segs === 1 ? "" : "s"}
          </span>
        </div>
        <div className="stack-sm" style={{ alignItems: "flex-end" }}>
          <Badge tone={confidenceTone(s.confidence)} icon={<Sparkles size={11} />}>
            {confidenceLabel(s.confidence)}
          </Badge>
          {s.kind === "unscheduled" && <Badge tone="warning">Unscheduled</Badge>}
        </div>
      </div>
      {s.rationale && <p className="rc-sug-rationale">{s.rationale}</p>}
      <span className="tiny subtle">Method: {s.method}</span>
      <div className="rc-sug-actions">
        <Button variant="primary" size="sm" icon={<Check size={14} />} disabled={!canAccept || busy} loading={busy && !picking} onClick={() => onAccept(null)}>
          Accept
        </Button>
        <Button size="sm" icon={<X size={14} />} disabled={busy} onClick={onReject}>
          Reject
        </Button>
        <Button size="sm" variant="ghost" icon={<UserRoundPen size={14} />} disabled={busy || options.length === 0} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          Pick another client
        </Button>
      </div>
      {picking && (
        <div className="rc-sug-pick">
          <Field label="Assign to">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} options={[{ value: "", label: "Choose…" }, ...options.map((o) => ({ value: o.value, label: o.label }))]} />
          </Field>
          <Button size="sm" variant="primary" disabled={!chosen || busy} loading={busy && picking} onClick={() => chosen && onAccept(chosen.body)}>
            Assign
          </Button>
        </div>
      )}
    </Card>
  );
}
