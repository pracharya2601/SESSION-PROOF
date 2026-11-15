import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Copy, Database, FileText, ListOrdered, Lock, Palette, RotateCcw, Save, Type } from "lucide-react";
import type { DocModel, DocumentTemplate, FileKind, SessionSummary, TemplateInput, TemplateText, TemplateTheme } from "../../contracts";
import { api, ApiClientError } from "../api";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  STATUS_LABELS,
  Select,
  Skeleton,
  Spinner,
  TabPanel,
  Tabs,
  Textarea,
  errorMessage,
  useToast,
} from "../design";
import { DocPreview } from "../components/doc/DocPreview";
import { AccentPicker } from "../components/templates/AccentPicker";
import { SectionList } from "../components/templates/SectionList";
import { Segmented } from "../components/templates/Segmented";
import { FONT_STACKS } from "../components/doc/paper";
import { KIND_LABELS, builtinId, sameInput, templateHref, toInput, validateInput, type InputErrors } from "../components/templates/shared";
import "../components/templates/templates.css";

type Panel = "theme" | "sections" | "text";

/** Draft kept across an aborted hash navigation (the route remounts this page). */
let stash: { id: string; draft: TemplateInput } | null = null;

function kindFromHash(): FileKind {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const k = q.get("kind");
  return k === "invoice" || k === "approval_record" ? k : "session_note";
}

function sessionLabel(s: SessionSummary): string {
  const d = new Date(s.startAt);
  const when = Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return [s.clientRef, when, STATUS_LABELS[s.status] ?? s.status].filter(Boolean).join(" · ");
}

function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tp-group">
      <div className="tp-group-head">
        <h3>{title}</h3>
        {hint && <span className="tp-help">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export default function TemplateEditor({ templateId }: { templateId: string }) {
  const reduce = useReducedMotion();
  const toast = useToast();
  const isNew = templateId === "new";
  const [orig, setOrig] = useState<DocumentTemplate | null>(null);
  const [draft, setDraft] = useState<TemplateInput | null>(null);
  const [saved, setSaved] = useState<TemplateInput | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);
  const [panel, setPanel] = useState<Panel>("theme");
  const [saving, setSaving] = useState(false);
  const [dupBusy, setDupBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [showErrs, setShowErrs] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [model, setModel] = useState<DocModel | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState<unknown>(null);

  const readOnly = !isNew && !!orig?.builtin;
  const dirty = draft !== null && !readOnly && (isNew || !sameInput(draft, saved));
  const errors: InputErrors = draft ? validateInput(draft) : {};
  const hasErrors = Object.keys(errors).length > 0;
  const allowNav = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty && !allowNav.current;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // ------------------------------------------------------------ load
  const load = useCallback(() => {
    setLoadErr(null);
    setNotFound(false);
    setDraft(null);
    const kind = kindFromHash();
    api
      .listTemplates(isNew ? kind : undefined)
      .then((list) => {
        const t = isNew ? (list.find((x) => x.id === builtinId(kind)) ?? list.find((x) => x.kind === kind)) : list.find((x) => x.id === templateId);
        if (!t) {
          setNotFound(true);
          return;
        }
        const base = toInput(t);
        setOrig(t);
        setSaved(isNew ? null : base);
        const restored = stash && stash.id === templateId ? stash.draft : null;
        stash = null;
        setDraft(restored ?? (isNew ? { ...base, name: "Untitled template" } : base));
      })
      .catch(setLoadErr);
  }, [isNew, templateId]);
  useEffect(load, [load]);

  useEffect(() => {
    api
      .listSessions()
      .then((r) => setSessions(r.sessions.filter((s) => s.currentBundleRevision > 0)))
      .catch(() => setSessions([]));
  }, []);

  // ------------------------------------------------------------ live preview (debounced)
  const previewKey = draft && !hasErrors ? JSON.stringify(draft) : null;
  const seq = useRef(0);
  useEffect(() => {
    if (!previewKey) return;
    const my = ++seq.current;
    setPvBusy(true);
    const t = window.setTimeout(() => {
      api
        .previewTemplate({ template: JSON.parse(previewKey) as TemplateInput, ...(sessionId ? { sessionId } : {}) })
        .then((m) => {
          if (my !== seq.current) return;
          setModel(m);
          setPvErr(null);
        })
        .catch((e) => my === seq.current && setPvErr(e))
        .finally(() => my === seq.current && setPvBusy(false));
    }, 350);
    return () => window.clearTimeout(t);
  }, [previewKey, sessionId]);

  // ------------------------------------------------------------ unsaved-changes guard
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    function onClick(e: MouseEvent) {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("#/") || href === window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingNav(href);
    }
    function onHash(e: HashChangeEvent) {
      if (!dirtyRef.current) return;
      // Back/forward or a programmatic change slipped past the click guard.
      const d = draftRef.current;
      if (window.confirm("Discard unsaved template changes?")) {
        stash = null;
        allowNav.current = true;
        return;
      }
      if (d) stash = { id: templateId, draft: d };
      allowNav.current = true;
      window.location.replace(e.oldURL);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("hashchange", onHash);
    };
  }, [templateId]);

  function navigate(href: string) {
    if (dirtyRef.current) {
      setPendingNav(href);
      return;
    }
    window.location.hash = href;
  }

  function leave(href: string, replace = false) {
    allowNav.current = true;
    if (replace) window.location.replace(href);
    else window.location.hash = href;
  }

  // ------------------------------------------------------------ edits
  const setTheme = <K extends keyof TemplateTheme>(k: K, v: TemplateTheme[K]) =>
    setDraft((d) => (d ? { ...d, theme: { ...d.theme, [k]: v } } : d));
  const setText = <K extends keyof TemplateText>(k: K, v: TemplateText[K]) =>
    setDraft((d) => (d ? { ...d, text: { ...d.text, [k]: v } } : d));

  // ------------------------------------------------------------ save
  const save = useCallback(async () => {
    const d = draftRef.current;
    if (!d || readOnly || saving) return;
    if (Object.keys(validateInput(d)).length > 0) {
      setShowErrs(true);
      setSaveErr("Fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      if (isNew) {
        const c = await api.createTemplate(d);
        setSaved(toInput(c));
        toast.success("Template created", c.name);
        leave(templateHref(c.id), true);
      } else if (orig) {
        const u = await api.updateTemplate(orig.id, d);
        const next = toInput(u);
        setOrig(u);
        setSaved(next);
        setDraft(next);
        setShowErrs(false);
        toast.success("Template saved", u.name);
      }
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 400 || e.status === 409 || e.status === 422)) {
        setSaveErr(e.message + (e.correlationId ? ` (Reference: ${e.correlationId})` : ""));
      } else {
        setSaveErr(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  }, [isNew, orig, readOnly, saving, toast]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  async function duplicateToEdit() {
    if (!orig || !draft) return;
    setDupBusy(true);
    try {
      const c = await api.createTemplate({ ...toInput(orig), name: `${orig.name} copy`.slice(0, 80) });
      toast.success("Copy created", "You can edit this template now.");
      leave(templateHref(c.id));
    } catch (e) {
      toast.error("Couldn't duplicate", errorMessage(e));
    } finally {
      setDupBusy(false);
    }
  }

  const kind: FileKind = draft?.kind ?? orig?.kind ?? kindFromHash();
  const sessionOptions = useMemo(
    () => [{ value: "", label: "Sample data (synthetic)" }, ...(sessions ?? []).map((s) => ({ value: s.id, label: sessionLabel(s) }))],
    [sessions],
  );
  const errOf = (k: keyof InputErrors) => (showErrs || k !== "name" ? errors[k] : undefined);

  // ------------------------------------------------------------ render
  if (loadErr != null) {
    return (
      <div className="tp-page">
        <PageHeader title="Template designer" onBack={() => navigate("#/templates")} backLabel="Templates" />
        <ErrorNotice title="Couldn't load the template" error={loadErr} onRetry={load} />
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="tp-page">
        <PageHeader title="Template designer" onBack={() => navigate("#/templates")} backLabel="Templates" />
        <EmptyState
          icon={<FileText size={28} />}
          title="Template not found"
          description="It may have been deleted."
          action={
            <a className="ds-btn ds-btn-primary ds-btn-sm" href="#/templates">
              All templates
            </a>
          }
        />
      </div>
    );
  }

  const disabled = readOnly || saving;

  return (
    <div className="tp-page tp-editor">
      <PageHeader
        onBack={() => navigate(`#/templates?kind=${kind}`)}
        backLabel="Templates"
        eyebrow={`${KIND_LABELS[kind]} template${isNew ? " · new" : ""}`}
        title={draft ? draft.name.trim() || "Untitled template" : <Skeleton width={240} height={30} />}
        actions={
          readOnly ? (
            <Button variant="primary" icon={<Copy size={15} />} loading={dupBusy} onClick={() => void duplicateToEdit()}>
              Duplicate to edit
            </Button>
          ) : (
            <>
              <AnimatePresence>
                {dirty && (
                  <motion.span
                    key="dirty"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, x: 8 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                  >
                    <Badge tone="warning" dot>
                      {isNew ? "Not saved yet" : "Unsaved changes"}
                    </Badge>
                  </motion.span>
                )}
              </AnimatePresence>
              {!isNew && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RotateCcw size={14} />}
                  disabled={!dirty || saving}
                  onClick={() => {
                    setDraft(saved);
                    setSaveErr(null);
                    setShowErrs(false);
                  }}
                >
                  Discard
                </Button>
              )}
              <Button
                variant="primary"
                icon={<Save size={15} />}
                loading={saving}
                disabled={!dirty || !draft}
                onClick={() => void save()}
                title="Save (Ctrl/⌘ S)"
              >
                {isNew ? "Create template" : "Save"}
              </Button>
            </>
          )
        }
      />

      <AnimatePresence initial={false}>
        {readOnly && (
          <motion.div key="ro" className="info-box tp-banner" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Lock size={15} aria-hidden="true" />
            <span>Built-in templates are read-only. Duplicate this one to customise it — the preview below shows exactly what it produces.</span>
          </motion.div>
        )}
        {saveErr && (
          <motion.div
            key="err"
            className="error-box tp-banner"
            role="alert"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              <strong>Couldn't save.</strong> {saveErr}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="tp-split">
        <section className="tp-controls" aria-label="Template settings">
          {!draft ? (
            <Card padding="md" className="tp-ctl-card" aria-busy="true">
              <Skeleton height={38} />
              <Skeleton height={38} />
              <Skeleton lines={6} height={16} />
            </Card>
          ) : (
            <>
              <Card padding="md" className="tp-ctl-card">
                <Field label="Template name" required error={errOf("name")}>
                  <Input value={draft.name} maxLength={80} disabled={disabled} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field
                  label="Preview with"
                  hint={sessions && sessions.length === 0 ? "No sessions with a draft yet — using sample data." : "Preview only — nothing is saved to the session."}
                >
                  <Select value={sessionId} onChange={(e) => setSessionId(e.target.value)} options={sessionOptions} disabled={sessions === null} />
                </Field>
              </Card>

              <Tabs
                aria-label="Template settings"
                idBase="tpe"
                size="sm"
                value={panel}
                onChange={setPanel}
                items={[
                  { id: "theme", label: "Theme", icon: <Palette size={14} /> },
                  { id: "sections", label: "Sections", icon: <ListOrdered size={14} />, badge: draft.sections.filter((s) => s.enabled).length },
                  { id: "text", label: "Text", icon: <Type size={14} /> },
                ]}
              />

              <TabPanel idBase="tpe" id="theme" active={panel === "theme"} className="tp-panel-body">
                <Card padding="md" className="tp-ctl-card">
                  <Group title="Accent colour">
                    <AccentPicker value={draft.theme.accentColor} onChange={(v) => setTheme("accentColor", v)} disabled={disabled} error={errors.accentColor} />
                  </Group>
                  <Group title="Typeface">
                    <Segmented
                      aria-label="Typeface"
                      value={draft.theme.fontFamily}
                      onChange={(v) => setTheme("fontFamily", v)}
                      disabled={disabled}
                      options={(["sans", "serif", "mono"] as const).map((f) => ({
                        value: f,
                        label: <span style={{ fontFamily: FONT_STACKS[f] }}>{f === "sans" ? "Sans" : f === "serif" ? "Serif" : "Mono"}</span>,
                        hint: <span style={{ fontFamily: FONT_STACKS[f] }}>Aa</span>,
                      }))}
                    />
                  </Group>
                  <div className="tp-two">
                    <Group title="Paper">
                      <Segmented
                        aria-label="Paper size"
                        value={draft.theme.paper}
                        onChange={(v) => setTheme("paper", v)}
                        disabled={disabled}
                        options={[
                          { value: "letter", label: "Letter" },
                          { value: "a4", label: "A4" },
                        ]}
                      />
                    </Group>
                    <Group title="Density">
                      <Segmented
                        aria-label="Density"
                        value={draft.theme.density}
                        onChange={(v) => setTheme("density", v)}
                        disabled={disabled}
                        options={[
                          { value: "comfortable", label: "Comfortable" },
                          { value: "compact", label: "Compact" },
                        ]}
                      />
                    </Group>
                  </div>
                  <Field label="Logo text" hint="Shown above the title, e.g. your agency name.">
                    <Input value={draft.theme.logoText} maxLength={60} disabled={disabled} onChange={(e) => setTheme("logoText", e.target.value)} />
                  </Field>
                  <Field label="Header note">
                    <Input value={draft.theme.headerNote} maxLength={200} disabled={disabled} onChange={(e) => setTheme("headerNote", e.target.value)} />
                  </Field>
                  <Field label="Footer note" hint={`${draft.theme.footerNote.length}/300`}>
                    <Textarea rows={2} value={draft.theme.footerNote} maxLength={300} disabled={disabled} onChange={(e) => setTheme("footerNote", e.target.value)} />
                  </Field>
                </Card>
              </TabPanel>

              <TabPanel idBase="tpe" id="sections" active={panel === "sections"} className="tp-panel-body">
                <Card padding="md" className="tp-ctl-card">
                  <SectionList sections={draft.sections} disabled={disabled} onChange={(s) => setDraft({ ...draft, sections: s })} />
                </Card>
              </TabPanel>

              <TabPanel idBase="tpe" id="text" active={panel === "text"} className="tp-panel-body">
                <Card padding="md" className="tp-ctl-card">
                  <Field label="Title override" hint="Leave empty to use the default title.">
                    <Input value={draft.text.title} maxLength={80} placeholder={KIND_LABELS[kind]} disabled={disabled} onChange={(e) => setText("title", e.target.value)} />
                  </Field>
                  {kind === "invoice" && (
                    <>
                      <Field label="Invoice number prefix (legacy)" hint="Invoice numbers now come from Settings → Business profile (prefix + next number). This field is kept for older templates." error={errors.invoicePrefix}>
                        <Input
                          className="mono"
                          value={draft.text.invoicePrefix}
                          maxLength={12}
                          placeholder="INV-"
                          disabled={disabled}
                          onChange={(e) => setText("invoicePrefix", e.target.value)}
                        />
                      </Field>
                      <Field label="Payment terms" hint="Used when your business profile has no payment terms.">
                        <Textarea rows={2} value={draft.text.paymentTerms} maxLength={500} disabled={disabled} onChange={(e) => setText("paymentTerms", e.target.value)} />
                      </Field>
                      <Field label="Invoice notes">
                        <Textarea rows={3} value={draft.text.invoiceNotes} maxLength={1000} disabled={disabled} onChange={(e) => setText("invoiceNotes", e.target.value)} />
                      </Field>
                    </>
                  )}
                  <Group
                    title="Signatures & attestation"
                    hint={draft.sections.find((s) => s.key === "signatures")?.enabled === false ? "Section is hidden" : undefined}
                  >
                    <Field label="Attestation statement">
                      <Textarea
                        rows={3}
                        value={draft.text.attestationStatement}
                        maxLength={1000}
                        disabled={disabled}
                        onChange={(e) => setText("attestationStatement", e.target.value)}
                      />
                    </Field>
                    <div className="tp-two">
                      <Field label="Participant signature label">
                        <Input
                          value={draft.text.participantSignatureLabel}
                          maxLength={80}
                          disabled={disabled}
                          onChange={(e) => setText("participantSignatureLabel", e.target.value)}
                        />
                      </Field>
                      <Field label="Provider signature label">
                        <Input
                          value={draft.text.providerSignatureLabel}
                          maxLength={80}
                          disabled={disabled}
                          onChange={(e) => setText("providerSignatureLabel", e.target.value)}
                        />
                      </Field>
                    </div>
                    <Field label="Representative signature label" hint="Leave empty for no representative line.">
                      <Input
                        value={draft.text.representativeSignatureLabel}
                        maxLength={80}
                        disabled={disabled}
                        onChange={(e) => setText("representativeSignatureLabel", e.target.value)}
                      />
                    </Field>
                  </Group>
                </Card>
              </TabPanel>
            </>
          )}
        </section>

        <section className="tp-preview-pane" aria-label="Live preview">
          <div className="tp-preview-head">
            <h2>
              Live preview
              {sessionId ? (
                <Badge tone="info" icon={<Database size={11} />}>
                  Real session
                </Badge>
              ) : (
                <Badge tone="fixture">Sample data</Badge>
              )}
            </h2>
            <span className="tp-preview-status" role="status" aria-live="polite">
              {pvBusy ? (
                <>
                  <Spinner size={13} /> Updating…
                </>
              ) : hasErrors ? (
                "Fix the highlighted fields to update"
              ) : model ? (
                "Up to date"
              ) : null}
            </span>
          </div>
          {pvErr != null && (
            <div className="tp-pv-err">
              <ErrorNotice title="Preview failed" error={pvErr} />
            </div>
          )}
          {model ? (
            <motion.div className={pvBusy ? "tp-docwrap busy" : "tp-docwrap"} layout={false}>
              <DocPreview model={model} className="tp-docpv" />
            </motion.div>
          ) : pvErr == null ? (
            <div className="tp-pv-skel" aria-busy="true" aria-label="Loading preview">
              <Skeleton height={26} width="50%" />
              <Skeleton lines={3} />
              <Skeleton height={120} radius={6} />
              <Skeleton lines={5} />
            </div>
          ) : null}
        </section>
      </div>

      <Dialog
        open={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        size="sm"
        title="Discard unsaved changes?"
        description="Your edits to this template haven't been saved."
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingNav(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const href = pendingNav;
                setPendingNav(null);
                if (href) leave(href);
              }}
            >
              Discard changes
            </Button>
          </>
        }
      />
    </div>
  );
}
