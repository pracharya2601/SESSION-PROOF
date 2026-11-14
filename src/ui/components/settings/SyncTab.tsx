import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Clock, History, RefreshCw } from "lucide-react";
import type { SyncSettings, SyncSettingsView } from "../../../contracts";
import { api } from "../../api";
import { Card, ErrorNotice, Field, Input, Select, Skeleton, Switch, fadeOnly, fadeUp, stagger, useToast } from "../../design";
import { SaveBar } from "./SaveBar";
import { formatInstant } from "./shared";

// Mirrors SYNC_INTERVAL_OPTIONS in src/contracts (kept local so zod stays out of the bundle).
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

function same(a: SyncSettings, b: SyncSettings) {
  return a.enabled === b.enabled && a.intervalMinutes === b.intervalMinutes && a.lookbackDays === b.lookbackDays;
}

export function SyncTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [view, setView] = useState<SyncSettingsView | null>(null);
  const [draft, setDraft] = useState<SyncSettings | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    setLoadErr(null);
    api
      .getSyncSettings()
      .then((v) => {
        setView(v);
        setDraft(v.settings);
      })
      .catch(setLoadErr);
  }
  useEffect(load, []);

  const dirty = !!view && !!draft && !same(view.settings, draft);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const lookbackInvalid = !!draft && (!Number.isInteger(draft.lookbackDays) || draft.lookbackDays < 1 || draft.lookbackDays > 30);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const v = await api.saveSyncSettings(draft);
      setView(v);
      setDraft(v.settings);
      toast.success("Sync schedule saved", v.settings.enabled ? `Next run ${formatInstant(v.nextRunAt)}` : "Automatic sync is off.");
    } catch (e) {
      setSaveErr(e);
    } finally {
      setSaving(false);
    }
  }

  if (loadErr) return <ErrorNotice title="Couldn't load sync settings" error={loadErr} onRetry={load} />;
  if (!view || !draft)
    return (
      <Card aria-busy="true">
        <Skeleton lines={5} />
      </Card>
    );

  const v = reduce ? fadeOnly : fadeUp;
  return (
    <motion.div className="u2-tab-stack" variants={stagger} initial="hidden" animate="show">
      <motion.div variants={v}>
        <Card padding="lg" className="u2-section">
          <div className="u2-section-head">
            <span className="u2-section-ico">
              <RefreshCw size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 className="u2-h2">Automatic sync</h2>
              <p className="u2-muted">Find finished visits and their transcripts without pressing Sync now.</p>
            </div>
          </div>
          <Switch
            checked={draft.enabled}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
            label="Find finished visits automatically"
            description="Retries for approvals and queued work always run, even when this is off."
          />
          <motion.div
            className="u2-grid-2"
            animate={{ opacity: draft.enabled ? 1 : 0.45 }}
            transition={{ duration: 0.2 }}
          >
            <Field label="How often">
              <Select
                value={draft.intervalMinutes}
                disabled={!draft.enabled}
                onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}
                options={INTERVALS.map((i) => ({ value: i.minutes, label: i.label }))}
              />
            </Field>
            <Field
              label="Look back for late transcripts"
              hint="1–30 days"
              error={lookbackInvalid ? "Enter a whole number of days between 1 and 30." : undefined}
            >
              <Input
                type="number"
                min={1}
                max={30}
                step={1}
                value={Number.isFinite(draft.lookbackDays) ? draft.lookbackDays : ""}
                onChange={(e) => setDraft({ ...draft, lookbackDays: Math.trunc(Number(e.target.value)) })}
              />
            </Field>
          </motion.div>
        </Card>
      </motion.div>
      <motion.div variants={v} className="u2-stat-row">
        <div className="u2-stat">
          <History size={16} aria-hidden="true" />
          <span className="u2-stat-label">Last automatic run</span>
          <span className="u2-stat-value">{formatInstant(view.lastRunAt)}</span>
        </div>
        <div className="u2-stat">
          <Clock size={16} aria-hidden="true" />
          <span className="u2-stat-label">Next run</span>
          <span className="u2-stat-value">{view.settings.enabled ? formatInstant(view.nextRunAt) : "Off"}</span>
        </div>
        <div className="u2-stat">
          <RefreshCw size={16} aria-hidden="true" />
          <span className="u2-stat-label">Server heartbeat</span>
          <span className="u2-stat-value">every {view.heartbeatMinutes} min</span>
        </div>
      </motion.div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={saveErr}
        invalid={lookbackInvalid}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(view.settings);
          setSaveErr(null);
        }}
        label="Save schedule"
      />
    </motion.div>
  );
}
