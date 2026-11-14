import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Bot, Check, FlaskConical, KeyRound, ShieldCheck } from "lucide-react";
import type { AiProviderId, AiSettings, PrivacyOptions, SettingsBundle } from "../../../contracts";
import { api } from "../../api";
import { Badge, Card, Field, Input, Select, Switch, cx, fadeOnly, fadeUp, springy, stagger, useToast } from "../../design";
import { RedactionDemo } from "./RedactionDemo";
import { SaveBar } from "./SaveBar";
import { AI_DEFAULT_MODELS, AI_PROVIDERS, AI_PROVIDER_LABELS, PRIVACY_KEYS, PRIVACY_LABELS } from "./shared";

const CUSTOM = "__custom__";

function same(a: AiSettings, b: AiSettings) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function AiTab({
  bundle,
  onSaved,
  onDirtyChange,
}: {
  bundle: SettingsBundle;
  onSaved: (b: SettingsBundle) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [draft, setDraft] = useState<AiSettings>(bundle.ai);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const modelsFor = (p: AiProviderId) => {
    const s = bundle.aiProviders.find((x) => x.provider === p);
    return s && s.models.length ? s.models : AI_DEFAULT_MODELS[p];
  };
  const suggested = modelsFor(draft.provider);
  const [custom, setCustom] = useState(!suggested.includes(bundle.ai.model));

  useEffect(() => {
    setDraft(bundle.ai);
    setCustom(!modelsFor(bundle.ai.provider).includes(bundle.ai.model));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle.ai]);
  const dirty = !same(draft, bundle.ai);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const modelErr = !draft.model.trim() ? "Choose or enter a model." : draft.model.length > 100 ? "Max 100 characters." : null;
  const fixture = bundle.extractionMode === "fixture";

  function pickProvider(p: AiProviderId) {
    if (p === draft.provider) return;
    const models = modelsFor(p);
    setDraft({ ...draft, provider: p, model: models[0] ?? "" });
    setCustom(models.length === 0);
  }
  function setPrivacy(k: keyof PrivacyOptions, on: boolean) {
    setDraft({ ...draft, privacy: { ...draft.privacy, [k]: on } });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const b = await api.saveAiSettings({ ...draft, model: draft.model.trim() });
      onSaved(b);
      toast.success("AI & privacy settings saved");
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  }

  const v = reduce ? fadeOnly : fadeUp;
  const enabledCount = PRIVACY_KEYS.filter((k) => draft.privacy[k]).length;

  return (
    <motion.div className="u2-tab-stack" variants={stagger} initial="hidden" animate="show">
      {fixture && (
        <motion.div variants={v} className="u2-note u2-note-fixture" role="note">
          <FlaskConical size={16} aria-hidden="true" />
          <span>
            <strong>Extraction mode: fixture.</strong> No AI calls are made — documents are generated from built-in fixtures. These
            settings take effect when the server runs in live mode.
          </span>
        </motion.div>
      )}

      <motion.div variants={v}>
        <Card padding="lg" className="u2-section">
          <div className="u2-section-head">
            <span className="u2-section-ico">
              <Bot size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 className="u2-h2">AI provider</h2>
              <p className="u2-muted">API keys live only on the server. Unconfigured providers need an admin to add a key.</p>
            </div>
          </div>
          <fieldset className="u2-choice">
            <legend className="sr-only">AI provider</legend>
            <motion.div className="u2-ai-grid" variants={stagger} initial="hidden" animate="show">
              {AI_PROVIDERS.map((p) => {
                const status = bundle.aiProviders.find((s) => s.provider === p);
                const configured = !!status?.configured;
                const selected = draft.provider === p;
                return (
                  <motion.label
                    key={p}
                    variants={v}
                    className={cx("u2-ai-card", selected && "u2-choice-on", `u2-ai-${p}`)}
                    whileHover={reduce ? undefined : { y: -3 }}
                    transition={springy}
                  >
                    <input type="radio" name="ai-provider" className="sr-only" checked={selected} onChange={() => pickProvider(p)} />
                    {selected && (
                      <motion.span layoutId="ai-ring" className="u2-choice-ring" transition={reduce ? { duration: 0 } : springy} aria-hidden="true" />
                    )}
                    <span className="u2-ai-orb" aria-hidden="true">
                      {(status?.label ?? AI_PROVIDER_LABELS[p]).charAt(0)}
                    </span>
                    <span className="u2-ai-name">{status?.label ?? AI_PROVIDER_LABELS[p]}</span>
                    <Badge tone={configured ? "success" : "neutral"} icon={configured ? <Check size={12} /> : <KeyRound size={12} />}>
                      {configured ? "Configured" : "Not configured"}
                    </Badge>
                  </motion.label>
                );
              })}
            </motion.div>
          </fieldset>
          {!bundle.aiProviders.find((s) => s.provider === draft.provider)?.configured && (
            <p className="u2-note u2-note-warn">
              {AI_PROVIDER_LABELS[draft.provider]} has no API key on the server. You can save this choice, but live extraction will fail
              until an admin configures it.
            </p>
          )}
          <div className="u2-grid-2">
            <Field label="Model">
              <Select
                value={custom ? CUSTOM : draft.model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) {
                    setCustom(true);
                  } else {
                    setCustom(false);
                    setDraft({ ...draft, model: e.target.value });
                  }
                }}
                options={[...suggested.map((m) => ({ value: m, label: m })), { value: CUSTOM, label: "Custom model…" }]}
              />
            </Field>
            {custom && (
              <Field label="Custom model id" error={modelErr ?? undefined} hint="Any model id your provider accepts.">
                <Input
                  value={draft.model}
                  maxLength={100}
                  spellCheck={false}
                  placeholder="model-id"
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                />
              </Field>
            )}
          </div>
        </Card>
      </motion.div>

      <motion.div variants={v} className="u2-split">
        <Card padding="lg" className="u2-section">
          <div className="u2-section-head">
            <span className="u2-section-ico u2-ico-ok">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 className="u2-h2">Privacy controller</h2>
              <p className="u2-muted">
                Hides personal details before anything reaches the AI provider · {enabledCount} of {PRIVACY_KEYS.length} on
              </p>
            </div>
          </div>
          <div className="u2-switch-list">
            {PRIVACY_KEYS.map((k) => (
              <Switch
                key={k}
                checked={draft.privacy[k]}
                onChange={(on) => setPrivacy(k, on)}
                label={PRIVACY_LABELS[k].label}
                description={PRIVACY_LABELS[k].hint}
              />
            ))}
          </div>
        </Card>
        <Card padding="lg" glow>
          <RedactionDemo options={draft.privacy} />
        </Card>
      </motion.div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={err}
        invalid={!!modelErr}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(bundle.ai);
          setCustom(!modelsFor(bundle.ai.provider).includes(bundle.ai.model));
          setErr(null);
        }}
      />
    </motion.div>
  );
}
