import { useEffect, useState } from "react";
import type { SyncSettings, SyncSettingsView } from "../../contracts";
import { api } from "../api";
import { ErrorNotice } from "./ErrorNotice";

// Mirrors SYNC_INTERVAL_OPTIONS in src/contracts (kept local so zod stays out of
// the browser bundle). The server validates; an unlisted value is rejected there.
const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 120, label: "Every 2 hours" },
  { minutes: 240, label: "Every 4 hours" },
  { minutes: 720, label: "Every 12 hours" },
  { minutes: 1440, label: "Once a day" },
];

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function SyncSettingsPanel() {
  const [view, setView] = useState<SyncSettingsView | null>(null);
  const [draft, setDraft] = useState<SyncSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getSyncSettings()
      .then((v) => {
        setView(v);
        setDraft(v.settings);
      })
      .catch(setError);
  }, []);

  const dirty =
    view != null &&
    draft != null &&
    (draft.enabled !== view.settings.enabled ||
      draft.intervalMinutes !== view.settings.intervalMinutes ||
      draft.lookbackDays !== view.settings.lookbackDays);

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const v = await api.saveSyncSettings(draft);
      setView(v);
      setDraft(v.settings);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="card">
      <summary>
        <strong>Automatic sync</strong>{" "}
        <span className="muted small">
          {view == null
            ? "loading…"
            : view.settings.enabled
              ? `${INTERVALS.find((i) => i.minutes === view.settings.intervalMinutes)?.label ?? `every ${view.settings.intervalMinutes} min`} · next ${fmt(view.nextRunAt)}`
              : "off — use Sync now"}
        </span>
      </summary>

      {draft && (
        <form
          className="stack-sm"
          style={{ marginTop: "0.75rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          <label className="row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Find finished visits automatically
          </label>

          <label className="stack-sm">
            <span>How often</span>
            <select
              value={draft.intervalMinutes}
              disabled={!draft.enabled}
              onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}
            >
              {INTERVALS.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>

          <label className="stack-sm">
            <span>Look back for late transcripts (days)</span>
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              value={draft.lookbackDays}
              onChange={(e) => setDraft({ ...draft, lookbackDays: Math.trunc(Number(e.target.value)) || 1 })}
            />
          </label>

          <p className="muted small">
            Last automatic run: {fmt(view?.lastRunAt ?? null)}. The server checks every {view?.heartbeatMinutes} minutes;
            retries for approvals and queued work always run, even when automatic sync is off.
          </p>

          <div className="row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save schedule"}
            </button>
            {saved && !dirty && <span className="small" role="status">Saved.</span>}
          </div>
        </form>
      )}

      {error != null && <ErrorNotice title="Sync settings" error={error} />}
    </details>
  );
}
