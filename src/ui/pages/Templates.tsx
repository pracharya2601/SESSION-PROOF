import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Copy, FileSignature, FileText, LayoutTemplate, Lock, Pencil, Plus, Receipt, RefreshCw, Star, Trash2 } from "lucide-react";
import type { DocumentTemplate, FileKind } from "../../contracts";
import { api } from "../api";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Skeleton,
  TabPanel,
  Tabs,
  errorMessage,
  fadeOnly,
  fadeUp,
  stagger,
  useToast,
} from "../design";
import { TemplateThumb } from "../components/templates/TemplateThumb";
import { KINDS, KIND_LABELS, builtinId, templateHref, toInput } from "../components/templates/shared";
import "../components/templates/templates.css";

const KIND_ICONS: Record<FileKind, typeof FileText> = { session_note: FileText, invoice: Receipt, approval_record: FileSignature };

function kindFromHash(): FileKind {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const k = q.get("kind");
  return k === "invoice" || k === "approval_record" ? k : "session_note";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function Templates() {
  const reduce = useReducedMotion();
  const toast = useToast();
  const [kind, setKind] = useState<FileKind>(kindFromHash);
  const [items, setItems] = useState<DocumentTemplate[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<DocumentTemplate | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    setItems(null);
    api.listTemplates().then(setItems).catch(setErr);
  }, []);
  useEffect(load, [load]);

  function selectKind(k: FileKind) {
    setKind(k);
    // keep the tab in the URL (replace, no history spam)
    window.history.replaceState(null, "", `#/templates?kind=${k}`);
  }

  const byKind = useMemo(() => {
    const out: Record<FileKind, DocumentTemplate[]> = { session_note: [], invoice: [], approval_record: [] };
    for (const t of items ?? []) out[t.kind]?.push(t);
    for (const k of KINDS) out[k].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
    return out;
  }, [items]);

  async function duplicate(t: DocumentTemplate) {
    setBusy(`dup:${t.id}`);
    try {
      const input = toInput(t);
      const created = await api.createTemplate({ ...input, name: `${t.name} copy`.slice(0, 80) });
      setItems((xs) => [...(xs ?? []), created]);
      toast.toast({
        tone: "success",
        title: "Template duplicated",
        description: created.name,
        action: { label: "Edit", onClick: () => (window.location.hash = templateHref(created.id)) },
      });
    } catch (e) {
      toast.error("Couldn't duplicate", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function makeDefault(t: DocumentTemplate) {
    setBusy(`def:${t.id}`);
    try {
      await api.setDefaultTemplate(t.kind, t.builtin ? null : t.id);
      setItems((xs) => xs?.map((x) => (x.kind === t.kind ? { ...x, isDefault: x.id === t.id } : x)) ?? xs);
      toast.success("Default updated", `${t.name} is now the default ${KIND_LABELS[t.kind]} template.`);
    } catch (e) {
      toast.error("Couldn't set default", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function doDelete() {
    const t = confirmDel;
    if (!t) return;
    setBusy(`del:${t.id}`);
    setDelErr(null);
    try {
      await api.deleteTemplate(t.id);
      setItems((xs) => {
        const rest = (xs ?? []).filter((x) => x.id !== t.id);
        if (!t.isDefault) return rest;
        return rest.map((x) => (x.kind === t.kind && x.id === builtinId(t.kind) ? { ...x, isDefault: true } : x));
      });
      setConfirmDel(null);
      toast.success("Template deleted", t.name);
    } catch (e) {
      setDelErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const v = reduce ? fadeOnly : fadeUp;
  const list = byKind[kind];

  return (
    <div className="tp-page">
      <PageHeader
        eyebrow="Documents"
        title="Templates"
        subtitle="Design how your session notes, invoices and approval records look. Previews use sample data."
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={15} />} onClick={load}>
              Refresh
            </Button>
            <a className="ds-btn ds-btn-primary ds-btn-sm" href={`#/templates/new?kind=${kind}`}>
              <Plus size={15} aria-hidden="true" /> New {KIND_LABELS[kind]} template
            </a>
          </>
        }
      />

      <Tabs
        aria-label="Document kind"
        idBase="tpl"
        value={kind}
        onChange={selectKind}
        items={KINDS.map((k) => {
          const Icon = KIND_ICONS[k];
          return { id: k, label: KIND_LABELS[k], icon: <Icon size={14} />, badge: items ? byKind[k].length : undefined };
        })}
      />

      {err != null && <ErrorNotice title="Couldn't load templates" error={err} onRetry={load} />}

      {KINDS.map((k) => (
        <TabPanel key={k} idBase="tpl" id={k} active={kind === k} className="tp-panel">
          {items == null && err == null && (
            <div className="tp-grid" aria-busy="true" aria-label="Loading templates">
              {[0, 1, 2].map((i) => (
                <Card key={i} padding="sm" className="tp-card">
                  <Skeleton height={220} radius={10} />
                  <Skeleton height={18} width="60%" />
                  <Skeleton height={14} width="40%" />
                </Card>
              ))}
            </div>
          )}
          {items && list.length === 0 && (
            <EmptyState
              icon={<LayoutTemplate size={28} />}
              title="No templates yet"
              description="Start from the built-in template."
              action={
                <a className="ds-btn ds-btn-primary ds-btn-sm" href={`#/templates/new?kind=${k}`}>
                  <Plus size={15} aria-hidden="true" /> New template
                </a>
              }
            />
          )}
          {items && list.length > 0 && (
            <motion.ul key={k} className="tp-grid" variants={stagger} initial="hidden" animate="show">
              <AnimatePresence initial={false}>
                {list.map((t) => (
                  <motion.li key={t.id} variants={v} exit="exit" layout={!reduce} className="tp-cell">
                    <Card padding="none" interactive className="tp-card" as="article" aria-label={t.name}>
                      <a className="tp-card-thumb" href={templateHref(t.id)} aria-label={`${t.builtin ? "Open" : "Edit"} ${t.name}`}>
                        <TemplateThumb template={t} />
                        <span className="tp-card-accent" style={{ background: t.theme.accentColor }} aria-hidden="true" />
                      </a>
                      <div className="tp-card-body">
                        <div className="tp-card-title">
                          <h3>{t.name}</h3>
                          <div className="tp-badges">
                            {t.builtin && (
                              <Badge tone="neutral" icon={<Lock size={11} />}>
                                Built-in
                              </Badge>
                            )}
                            {t.isDefault && (
                              <Badge tone="success" icon={<Star size={11} />}>
                                Default
                              </Badge>
                            )}
                          </div>
                        </div>
                        <p className="tp-card-meta">
                          {t.theme.paper === "a4" ? "A4" : "Letter"} · {t.theme.fontFamily} · {t.theme.density}
                          {t.sections.length > 0 && ` · ${t.sections.filter((s) => s.enabled).length} sections`}
                          {!t.builtin && fmtDate(t.updatedAt) && ` · ${fmtDate(t.updatedAt)}`}
                        </p>
                        <div className="tp-card-actions">
                          <a className="ds-btn ds-btn-secondary ds-btn-sm" href={templateHref(t.id)}>
                            {t.builtin ? <LayoutTemplate size={14} aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
                            {t.builtin ? "View" : "Edit"}
                          </a>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Copy size={14} />}
                            loading={busy === `dup:${t.id}`}
                            onClick={() => void duplicate(t)}
                          >
                            Duplicate
                          </Button>
                          {!t.isDefault && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Star size={14} />}
                              loading={busy === `def:${t.id}`}
                              onClick={() => void makeDefault(t)}
                            >
                              Set default
                            </Button>
                          )}
                          {!t.builtin && (
                            <Button
                              size="sm"
                              variant="ghost"
                              iconOnly
                              className="tp-del"
                              aria-label={`Delete ${t.name}`}
                              title="Delete"
                              icon={<Trash2 size={14} />}
                              onClick={() => {
                                setDelErr(null);
                                setConfirmDel(t);
                              }}
                            />
                          )}
                        </div>
                      </div>
                    </Card>
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </TabPanel>
      ))}

      <Dialog
        open={confirmDel !== null}
        onClose={() => setConfirmDel(null)}
        dismissible={!busy?.startsWith("del:")}
        size="sm"
        title="Delete template?"
        description={
          confirmDel
            ? `"${confirmDel.name}" will be removed.${confirmDel.isDefault ? " The built-in template becomes the default again." : ""} Documents already generated are not affected.`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDel(null)} disabled={busy?.startsWith("del:")}>
              Cancel
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} loading={busy?.startsWith("del:")} onClick={() => void doDelete()}>
              Delete
            </Button>
          </>
        }
      >
        {delErr && (
          <p className="error-box" role="alert">
            {delErr}
          </p>
        )}
      </Dialog>
    </div>
  );
}
