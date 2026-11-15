/**
 * Review assistant chat: one place to ask questions and fix the draft.
 * Opens with a locally computed "what needs attention" message (no model call).
 * The assistant returns PROPOSALS; Apply sends them through the normal review save
 * (expectedRevision-guarded) — nothing is applied by the server on its own.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Check, Loader2, Pencil, Send, Sparkles, X } from "lucide-react";
import type { EvidenceItem, ReviewEdits, SessionBundle } from "../../../contracts";
import type { ProposedEdits } from "../../../assistant/types";
import { api, ApiClientError } from "../../api";
import { Button } from "../../design";
import {
  historyKey,
  loadHistory,
  openingMessage,
  quickReplies,
  safeSessionStorage,
  saveHistory,
  splitCitations,
  toApiMessages,
  toReviewEdits,
  attentionItems,
  type ChatMessage,
  type ProposalState,
} from "./helpers";
import "./chat.css";

export type ApplyResult = { ok: true; revision: number } | { ok: false; conflict: boolean; message: string };

function newId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmtTime(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** ev_00N chip; hover/focus shows the transcript line. */
export function CitationChip(props: { id: string; evidence: Map<string, EvidenceItem>; timezone: string; onCite?: (id: string) => void }) {
  const e = props.evidence.get(props.id);
  const line = e ? `${e.speaker ? `${e.speaker}: ` : ""}${e.excerpt}` : "Not in this session's transcript";
  return (
    <span className="rvc-cite-wrap">
      <button
        type="button"
        className="rvc-cite"
        aria-label={`Evidence ${props.id}: ${line.slice(0, 200)}`}
        onClick={() => props.onCite?.(props.id)}
      >
        {props.id}
      </button>
      <span className="rvc-cite-tip" role="tooltip">
        {e?.observedFrom && <span className="rvc-cite-time">{fmtTime(e.observedFrom, props.timezone)} · </span>}
        {line.slice(0, 400)}
      </span>
    </span>
  );
}

function RichText(props: { text: string; evidence: Map<string, EvidenceItem>; timezone: string; onCite?: (id: string) => void }) {
  const ids = useMemo(() => [...props.evidence.keys()], [props.evidence]);
  return (
    <>
      {splitCitations(props.text, ids).map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <CitationChip key={i} id={p.id} evidence={props.evidence} timezone={props.timezone} onCite={props.onCite} />
        ),
      )}
    </>
  );
}

function ProposalEditor(props: { bundle: SessionBundle; edits: ProposedEdits; onChange: (e: ProposedEdits) => void }) {
  const { edits: e, onChange } = props;
  const goals = props.bundle.config.plan.goals;
  return (
    <div className="rvc-editor">
      {e.confirmedMinutes !== undefined && (
        <label className="rvc-ed-row">
          <span>Confirmed minutes</span>
          <input
            type="number"
            min={1}
            max={props.bundle.config.rate.maxMinutes}
            value={e.confirmedMinutes}
            onChange={(ev) => onChange({ ...e, confirmedMinutes: Math.round(Number(ev.target.value)) })}
          />
        </label>
      )}
      {(["activitySummary", "progressConfirmation", "participantChoices"] as const).map((k) =>
        e[k] !== undefined ? (
          <label key={k} className="rvc-ed-row rvc-ed-col">
            <span>{k === "activitySummary" ? "Activity summary" : k === "progressConfirmation" ? "Progress" : "Participant choices"}</span>
            <textarea rows={3} maxLength={k === "participantChoices" ? 1000 : 2000} value={e[k]} onChange={(ev) => onChange({ ...e, [k]: ev.target.value })} />
          </label>
        ) : null,
      )}
      {e.participantDirected !== undefined && (
        <label className="rvc-ed-row">
          <span>Participant directed</span>
          <select value={e.participantDirected ? "yes" : "no"} onChange={(ev) => onChange({ ...e, participantDirected: ev.target.value === "yes" })}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      )}
      {e.goalsAddressed !== undefined && (
        <fieldset className="rvc-ed-goals">
          <legend>Goals addressed</legend>
          {goals.map((g) => (
            <label key={g.goalId}>
              <input
                type="checkbox"
                checked={e.goalsAddressed!.includes(g.goalId)}
                onChange={(ev) =>
                  onChange({
                    ...e,
                    goalsAddressed: goals.map((x) => x.goalId).filter((id) => (id === g.goalId ? ev.target.checked : e.goalsAddressed!.includes(id))),
                  })
                }
              />{" "}
              {g.objective}
            </label>
          ))}
        </fieldset>
      )}
      {(e.rejectedClaims ?? []).map((r, i) => (
        <label key={r.claimId} className="rvc-ed-row rvc-ed-col">
          <span>Reason to remove {r.claimId}</span>
          <input
            type="text"
            maxLength={500}
            value={r.reason}
            onChange={(ev) => {
              const list = [...(e.rejectedClaims ?? [])];
              list[i] = { ...r, reason: ev.target.value };
              onChange({ ...e, rejectedClaims: list });
            }}
          />
        </label>
      ))}
    </div>
  );
}

function ProposalCard(props: {
  bundle: SessionBundle;
  proposal: ProposalState;
  evidence: Map<string, EvidenceItem>;
  timezone: string;
  disabled: boolean;
  onCite?: (id: string) => void;
  onApply: (edits: ProposedEdits) => void;
  onDismiss: () => void;
}) {
  const p = props.proposal;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProposedEdits>(p.edits);
  const done = p.status === "applied" || p.status === "dismissed";
  const valid = toReviewEdits(draft) !== null;
  return (
    <div className={`rvc-proposal is-${p.status}`} aria-label="Suggested change">
      <div className="rvc-proposal-head">
        <Sparkles size={14} aria-hidden="true" />
        <span>Suggested change</span>
        {p.status === "applied" && <span className="rvc-tag rvc-tag-ok">Applied</span>}
        {p.status === "dismissed" && <span className="rvc-tag">Dismissed</span>}
        {p.status === "conflict" && <span className="rvc-tag rvc-tag-warn">Record changed — ask again</span>}
        {p.status === "failed" && <span className="rvc-tag rvc-tag-warn">Not saved</span>}
      </div>
      {editing ? (
        <ProposalEditor bundle={props.bundle} edits={draft} onChange={setDraft} />
      ) : (
        <ul className="rvc-proposal-lines">
          {p.summary.map((s, i) => (
            <li key={i}>
              <RichText text={s} evidence={props.evidence} timezone={props.timezone} onCite={props.onCite} />
            </li>
          ))}
        </ul>
      )}
      {(p.rationale || p.citations.length > 0) && !editing && (
        <p className="rvc-proposal-why">
          {p.rationale && <RichText text={p.rationale} evidence={props.evidence} timezone={props.timezone} onCite={props.onCite} />}{" "}
          {p.citations.map((c) => (
            <CitationChip key={c} id={c} evidence={props.evidence} timezone={props.timezone} onCite={props.onCite} />
          ))}
        </p>
      )}
      {p.note && <p className="rvc-proposal-note">{p.note}</p>}
      {!done && (
        <div className="rvc-proposal-actions">
          <Button
            size="sm"
            variant="primary"
            icon={p.status === "applying" ? <Loader2 size={14} className="ds-spin" /> : <Check size={14} />}
            disabled={props.disabled || p.status === "applying" || !valid}
            onClick={() => props.onApply(editing ? draft : p.edits)}
          >
            {p.status === "applying" ? "Applying…" : "Apply"}
          </Button>
          <Button size="sm" variant="ghost" icon={<Pencil size={14} />} disabled={p.status === "applying"} onClick={() => setEditing((v) => !v)}>
            {editing ? "Done editing" : "Edit"}
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={14} />} disabled={p.status === "applying"} onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

export function AssistantChat(props: {
  sessionId: string;
  bundle: SessionBundle;
  timezone: string;
  /** Editing allowed (NEEDS_REVIEW). Otherwise the chat is read-only. */
  editable: boolean;
  onApply: (edits: ReviewEdits) => Promise<ApplyResult>;
  onCite?: (evidenceId: string) => void;
  /** No AI key / provider: the page shows the manual form instead. */
  onUnavailable: (reason: string) => void;
}) {
  const { bundle, sessionId } = props;
  const revision = bundle.bundleRevision;
  const storage = useMemo(() => safeSessionStorage(), []);
  const key = historyKey(sessionId, revision);
  const evidence = useMemo(() => new Map(bundle.evidence.map((e) => [e.id, e])), [bundle.evidence]);
  const [history, setHistory] = useState<ChatMessage[]>(() => loadHistory(storage, key) ?? [openingMessage(bundle)]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevKey = useRef(key);
  const historyRef = useRef(history);
  historyRef.current = history;
  const onUnavailable = props.onUnavailable;

  // Availability (no model call).
  useEffect(() => {
    let cancelled = false;
    api
      .assistantStatus(sessionId)
      .then((s) => {
        if (!cancelled && !s.available) {
          setUnavailable(true);
          onUnavailable(s.reason ?? "The review assistant is not available.");
        }
      })
      .catch(() => {
        /* status unknown — keep the chat; a send will report problems */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onUnavailable]);

  // New revision (after Apply or a reload): restore its history, or carry the conversation over with a fresh status note.
  useEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    const stored = loadHistory(storage, key);
    if (stored) {
      setHistory(stored);
      return;
    }
    const left = attentionItems(bundle);
    const note: ChatMessage = {
      id: `rev-${revision}`,
      role: "assistant",
      local: true,
      content:
        `Saved as revision ${revision}. ` +
        (left.length === 0 ? "Everything required is in place — you can approve." : `Still needed:\n${left.map((i) => `• ${i.text}`).join("\n")}`),
    };
    setHistory([...historyRef.current, note]);
  }, [key, revision, bundle, storage]);

  useEffect(() => {
    saveHistory(storage, key, history);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, key, storage]);

  const chips = useMemo(() => quickReplies(bundle), [bundle]);

  function updateProposal(msgId: string, pid: string, patch: Partial<ProposalState>) {
    setHistory((h) =>
      h.map((m) => (m.id === msgId ? { ...m, proposals: m.proposals?.map((p) => (p.id === pid ? { ...p, ...patch } : p)) } : m)),
    );
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending || !props.editable) return;
    const user: ChatMessage = { id: newId(), role: "user", content };
    const next = [...history, user];
    setHistory(next);
    setInput("");
    setSending(true);
    try {
      const r = await api.askAssistant(sessionId, { messages: toApiMessages(next), expectedRevision: revision });
      setHistory((h) => [
        ...h,
        {
          id: newId(),
          role: "assistant",
          content: r.reply,
          citations: r.citations,
          refusals: r.refusals,
          proposals: r.proposals.map((p) => ({ ...p, status: "pending" as const })),
        },
      ]);
    } catch (e) {
      let msg = "The assistant could not answer just now. Try again, or use Edit manually.";
      if (e instanceof ApiClientError) {
        if (e.status === 503 && e.code === "ASSISTANT_UNAVAILABLE") {
          setUnavailable(true);
          props.onUnavailable(e.message);
          return;
        }
        if (e.status === 409) msg = "This record changed — reloaded. Ask again to work on the latest version.";
        else if (e.status === 429) msg = e.message;
        else if (e.message) msg = e.message;
      }
      setHistory((h) => [...h, { id: newId(), role: "assistant", content: msg, local: true, error: true }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function apply(msgId: string, p: ProposalState, edits: ProposedEdits) {
    const review = toReviewEdits(edits);
    if (!review) return;
    updateProposal(msgId, p.id, { status: "applying", note: undefined });
    const r = await props.onApply(review);
    if (r.ok) updateProposal(msgId, p.id, { status: "applied", edits, note: `Saved as revision ${r.revision}.` });
    else updateProposal(msgId, p.id, { status: r.conflict ? "conflict" : "failed", note: r.message });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  if (unavailable) return null;

  return (
    <section className="rvc" aria-label="Review assistant">
      <header className="rvc-head">
        <span className="rvc-avatar" aria-hidden="true">
          <Bot size={16} />
        </span>
        <div>
          <h2 className="rvc-title">Review assistant</h2>
          <p className="rvc-sub">Ask about the visit or tell me what's wrong. I suggest changes — you apply them.</p>
        </div>
      </header>

      <div className="rvc-list" ref={listRef} role="log" aria-live="polite" aria-relevant="additions">
        <AnimatePresence initial={false}>
          {history.map((m) => (
            <motion.div
              key={m.id}
              className={`rvc-msg rvc-${m.role}${m.error ? " is-error" : ""}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
            >
              <div className="rvc-bubble">
                <RichText text={m.content} evidence={evidence} timezone={props.timezone} onCite={props.onCite} />
              </div>
              {m.proposals?.map((p) => (
                <ProposalCard
                  key={p.id}
                  bundle={bundle}
                  proposal={p}
                  evidence={evidence}
                  timezone={props.timezone}
                  disabled={!props.editable}
                  onCite={props.onCite}
                  onApply={(edits) => void apply(m.id, p, edits)}
                  onDismiss={() => updateProposal(m.id, p.id, { status: "dismissed" })}
                />
              ))}
            </motion.div>
          ))}
        </AnimatePresence>
        {sending && (
          <div className="rvc-msg rvc-assistant">
            <div className="rvc-bubble rvc-typing" aria-label="Assistant is thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {props.editable ? (
        <>
          <div className="rvc-chips" aria-label="Quick replies">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className="rvc-chip"
                disabled={sending}
                onClick={() => {
                  if (c.mode === "send") void send(c.text);
                  else {
                    setInput(c.text);
                    requestAnimationFrame(() => {
                      const el = inputRef.current;
                      if (!el) return;
                      el.focus();
                      const at = c.cursor ?? c.text.length;
                      el.setSelectionRange(at, at);
                    });
                  }
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <form
            className="rvc-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <label className="rvc-sr" htmlFor="rvc-input">
              Message the review assistant
            </label>
            <textarea
              id="rvc-input"
              ref={inputRef}
              rows={2}
              maxLength={4000}
              placeholder="e.g. It ran 45 minutes; the client planned the bus route herself"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
            />
            <Button type="submit" variant="primary" iconOnly aria-label="Send" disabled={!input.trim() || sending} icon={<Send size={16} />} />
          </form>
          <p className="rvc-foot">What you tell me is recorded as provider-confirmed, not evidence. Names are hidden from the AI.</p>
        </>
      ) : (
        <p className="rvc-foot">This revision is not editable; the assistant is read-only.</p>
      )}
    </section>
  );
}
