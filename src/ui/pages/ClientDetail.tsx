import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Activity, BadgeDollarSign, CalendarCheck2, CheckCircle2, ClipboardList, Landmark, LayoutTemplate, ListPlus, UserRound, Wallet } from "lucide-react";
import type { ClientRecord, ClientStats } from "../../contracts";
import { api, ApiClientError } from "../api";
import { AnimatedNumber, Badge, Card, ErrorNotice, PageHeader, Skeleton, TabPanel, Tabs, fadeOnly, fadeUp, stagger, useToast } from "../design";
import { SaveBar } from "../components/settings/SaveBar";
import { BillingTab, FundingTab, ProfileTab, TemplatesTab } from "../components/clients/ClientForm";
import { CustomFieldsEditor } from "../components/clients/CustomFieldsEditor";
import { ClientActivity } from "../components/clients/ClientActivity";
import { type ClientDraft, type DraftErrors, clientLabel, draftFromRecord, draftKey, draftToInput, emptyInput, formatDate, formatRate } from "../components/clients/shared";
import "../components/settings/u2.css";
import "../components/clients/clients.css";

type TabKey = "profile" | "billing" | "funding" | "fields" | "templates" | "sessions";
const TABS: { id: TabKey; label: string; icon: ReactNode }[] = [
  { id: "profile", label: "Profile", icon: <UserRound size={15} /> },
  { id: "billing", label: "Billing", icon: <BadgeDollarSign size={15} /> },
  { id: "funding", label: "Funding", icon: <Landmark size={15} /> },
  { id: "fields", label: "Custom fields", icon: <ListPlus size={15} /> },
  { id: "templates", label: "Templates", icon: <LayoutTemplate size={15} /> },
  { id: "sessions", label: "Sessions", icon: <Activity size={15} /> },
];
const IDBASE = "client";

/** Which tab owns each validation error (to jump there on a blocked save). */
const ERROR_TAB: Record<keyof DraftErrors, TabKey> = {
  displayName: "profile",
  preferredName: "profile",
  notes: "profile",
  rate: "billing",
  fundingSource: "funding",
  authorizationNumber: "funding",
  fiscalIntermediary: "funding",
  authorizedHours: "funding",
  caseManager: "funding",
  customFields: "fields",
  fieldLabel: "fields",
  fieldValue: "fields",
};

function tabFromHash(): TabKey {
  const q = window.location.hash.split("?")[1] ?? "";
  const t = new URLSearchParams(q).get("tab");
  return TABS.some((x) => x.id === t) ? (t as TabKey) : "profile";
}

type Load = { kind: "loading" } | { kind: "error"; error: unknown } | { kind: "ready"; record: ClientRecord | null; stats: ClientStats | null };

export default function ClientDetail({ clientRef }: { clientRef: string }) {
  const reduce = useReducedMotion();
  const toast = useToast();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [base, setBase] = useState<ClientDraft | null>(null);
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [tab, setTab] = useState<TabKey>(tabFromHash);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    api
      .getClient(clientRef)
      .then((s) => {
        const d = draftFromRecord(s.client);
        setBase(d);
        setDraft(d);
        setState({ kind: "ready", record: s.client, stats: s.stats });
      })
      .catch((error) => {
        if (error instanceof ApiClientError && error.status === 404) {
          // No record yet (e.g. a ref seen only on appointments): saving creates one.
          const d = draftFromRecord({ ...emptyInput(clientRef), providerId: "", rateVersion: 1, createdAt: "", updatedAt: "" });
          setBase(d);
          setDraft(d);
          setState({ kind: "ready", record: null, stats: null });
        } else setState({ kind: "error", error });
      });
  }, [clientRef]);
  useEffect(load, [load]);

  const dirty = useMemo(() => !!(draft && base && draftKey(draft) !== draftKey(base)), [draft, base]);
  const isNew = state.kind === "ready" && state.record == null;
  const converted = useMemo(() => (draft ? draftToInput(draft) : null), [draft]);
  const errors: DraftErrors = converted && (showErrors || dirty) ? converted.errors : {};
  const hasErrors = !!converted && Object.keys(converted.errors).length > 0;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const patch = useCallback((p: Partial<ClientDraft>) => {
    setSaveErr(null);
    setDraft((d) => (d ? { ...d, ...p } : d));
  }, []);

  function selectTab(next: TabKey) {
    setTab(next);
    const b = window.location.hash.split("?")[0] || `#/clients/${encodeURIComponent(clientRef)}`;
    window.history.replaceState(null, "", `${b}?tab=${next}`);
  }

  async function save() {
    if (!converted || state.kind !== "ready") return;
    setShowErrors(true);
    const errKeys = Object.keys(converted.errors) as (keyof DraftErrors)[];
    if (errKeys.length) {
      const first = errKeys[0]!;
      selectTab(ERROR_TAB[first]);
      toast.error("Check the highlighted fields", converted.errors[first]);
      return;
    }
    setSaving(true);
    setSaveErr(null);
    const prevRate = state.record?.hourlyRateCents;
    const prevVersion = state.record?.rateVersion;
    try {
      const rec = await api.saveClient(converted.input);
      const d = draftFromRecord(rec);
      setBase(d);
      setDraft(d);
      setShowErrors(false);
      setState({ kind: "ready", record: rec, stats: state.stats ?? zeroStats() });
      const rateChanged = state.record != null && (prevRate !== rec.hourlyRateCents || prevVersion !== rec.rateVersion);
      toast.success(
        isNew ? "Client created" : "Client saved",
        rateChanged ? `Rate is now ${formatRate(rec.hourlyRateCents)} (v${rec.rateVersion}) — applies to new drafts.` : clientLabel(rec),
      );
    } catch (e) {
      setSaveErr(e);
      if (!(e instanceof ApiClientError && (e.status === 400 || e.status === 422))) toast.error("Couldn't save client", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(base);
    setSaveErr(null);
    setShowErrors(false);
  }

  const back = () => {
    window.location.hash = "#/clients";
  };
  const v = reduce ? fadeOnly : fadeUp;

  if (state.kind === "loading" || !draft) {
    if (state.kind === "error") {
      return (
        <div className="u2-page">
          <PageHeader eyebrow="Client" title={clientRef} onBack={back} backLabel="Clients" />
          <ErrorNotice title="Couldn't load this client" error={state.error} onRetry={load} />
        </div>
      );
    }
    return (
      <div className="u2-page" aria-busy="true" aria-label="Loading client">
        <Skeleton width={90} height={14} />
        <Skeleton width="40%" height={34} radius={10} />
        <div className="u2-stat-row">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={84} radius={16} />
          ))}
        </div>
        <Card padding="lg">
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }
  if (state.kind === "error") return null;

  const { record, stats } = state;
  const title = record ? clientLabel(record) : clientRef;

  return (
    <div className="u2-page cl-detail">
      <PageHeader
        onBack={back}
        backLabel="Clients"
        eyebrow={
          <span className="cl-eyebrow">
            Client · <span className="mono">{clientRef}</span>
          </span>
        }
        title={title}
        subtitle={
          record
            ? `${formatRate(record.hourlyRateCents)} · rate v${record.rateVersion}${record.fundingSource ? ` · ${record.fundingSource}` : ""} · updated ${formatDate(record.updatedAt)}`
            : "No client record yet — fill in the details and save to create one."
        }
        actions={
          <div className="row">
            {isNew && <Badge tone="info">New</Badge>}
            {record && (record.active ? <Badge tone="success" dot>Active</Badge> : <Badge tone="warning">Inactive</Badge>)}
          </div>
        }
      />

      {stats && (
        <motion.div className="u2-stat-row u2-stat-hero cl-stat-row" variants={stagger} initial="hidden" animate="show">
          <Stat v={v} icon={<CalendarCheck2 size={16} aria-hidden="true" />} label="Sessions" value={<AnimatedNumber value={stats.sessions} />} />
          <Stat v={v} icon={<CheckCircle2 size={16} aria-hidden="true" />} label="Completed" value={<AnimatedNumber value={stats.completed} />} />
          <Stat
            v={v}
            icon={<ClipboardList size={16} aria-hidden="true" />}
            label="Needs review"
            value={<AnimatedNumber value={stats.needsReview} />}
            warn={stats.needsReview > 0}
          />
          <Stat
            v={v}
            icon={<Wallet size={16} aria-hidden="true" />}
            label="Billed"
            value={<AnimatedNumber value={stats.billedCents} format="cents" />}
            foot={
              <>
                <AnimatedNumber value={stats.billedMinutes} format="minutes" /> · last service {formatDate(stats.lastServiceAt)}
              </>
            }
          />
        </motion.div>
      )}

      <div className="u2-tabs-bar">
        <Tabs
          aria-label="Client sections"
          idBase={IDBASE}
          value={tab}
          onChange={selectTab}
          size="sm"
          items={TABS.map((t) => ({
            id: t.id,
            label: t.label,
            icon: t.icon,
            badge:
              Object.entries(errors).some(([k]) => ERROR_TAB[k as keyof DraftErrors] === t.id) ? (
                <span className="cl-err-dot" aria-label="has errors" />
              ) : t.id === "fields" && draft.customFields.length ? (
                draft.customFields.length
              ) : undefined,
          }))}
        />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(4px)" }}
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
        >
          <TabPanel idBase={IDBASE} id={tab} active className="cl-panel">
            {tab === "profile" && <ProfileTab draft={draft} patch={patch} errors={errors} />}
            {tab === "billing" && <BillingTab draft={draft} patch={patch} errors={errors} record={record} />}
            {tab === "funding" && <FundingTab draft={draft} patch={patch} errors={errors} />}
            {tab === "fields" && <CustomFieldsEditor draft={draft} patch={patch} errors={errors} />}
            {tab === "templates" && <TemplatesTab draft={draft} patch={patch} />}
            {tab === "sessions" && <ClientActivity clientRef={clientRef} />}
          </TabPanel>
        </motion.div>
      </AnimatePresence>

      <SaveBar
        dirty={dirty || isNew}
        saving={saving}
        error={saveErr}
        invalid={saving || (showErrors && hasErrors)}
        onSave={() => void save()}
        onDiscard={discard}
        label={isNew ? "Create client" : "Save changes"}
      />
    </div>
  );
}

function zeroStats(): ClientStats {
  return { sessions: 0, completed: 0, needsReview: 0, billedCents: 0, billedMinutes: 0, lastServiceAt: null };
}

function Stat({
  v,
  icon,
  label,
  value,
  foot,
  warn,
}: {
  v: Variants;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  warn?: boolean;
}) {
  return (
    <motion.div variants={v} className={warn ? "u2-stat cl-stat-warn" : "u2-stat"}>
      {icon}
      <span className="u2-stat-label">{label}</span>
      <span className="u2-stat-value u2-stat-big">{value}</span>
      {foot && <span className="u2-muted u2-small">{foot}</span>}
    </motion.div>
  );
}
