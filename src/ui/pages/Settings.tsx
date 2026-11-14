import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bot, HardDrive, Mail, RefreshCw, Smartphone } from "lucide-react";
import type { Connection, SettingsBundle } from "../../contracts";
import { api } from "../api";
import { Button, Card, Dialog, ErrorNotice, PageHeader, Skeleton, TabPanel, Tabs, fadeOnly } from "../design";
import { AiTab } from "../components/settings/AiTab";
import { EmailTab } from "../components/settings/EmailTab";
import { StorageTab } from "../components/settings/StorageTab";
import { SyncTab } from "../components/settings/SyncTab";
import { DevicesSection } from "../components/settings/DevicesSection";
import "../components/settings/u2.css";

type TabKey = "sync" | "storage" | "email" | "ai" | "devices";
const TABS: { id: TabKey; label: string; icon: ReactNode }[] = [
  { id: "sync", label: "Sync", icon: <RefreshCw size={15} /> },
  { id: "storage", label: "Storage", icon: <HardDrive size={15} /> },
  { id: "email", label: "Email", icon: <Mail size={15} /> },
  { id: "ai", label: "AI & Privacy", icon: <Bot size={15} /> },
  { id: "devices", label: "Devices", icon: <Smartphone size={15} /> },
];
const IDBASE = "settings";

function tabFromHash(): TabKey {
  const q = window.location.hash.split("?")[1] ?? "";
  const t = new URLSearchParams(q).get("tab");
  return TABS.some((x) => x.id === t) ? (t as TabKey) : "sync";
}

export default function Settings() {
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<TabKey>(tabFromHash);
  const [pending, setPending] = useState<TabKey | null>(null);
  const [dirty, setDirty] = useState(false);
  const [bundle, setBundle] = useState<SettingsBundle | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [err, setErr] = useState<unknown>(null);
  // Remount a tab after "discard" so its draft resets.
  const [epoch, setEpoch] = useState(0);

  const load = useCallback(() => {
    setErr(null);
    api.getSettings().then(setBundle).catch(setErr);
    api
      .listConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const onDirty = useCallback((d: boolean) => setDirty(d), []);

  function requestTab(next: TabKey) {
    if (next === tab) return;
    if (dirty) setPending(next);
    else switchTo(next);
  }
  function switchTo(next: TabKey) {
    setDirty(false);
    setTab(next);
    const base = window.location.hash.split("?")[0] || "#/settings";
    window.history.replaceState(null, "", `${base}?tab=${next}`);
  }

  const needsBundle = tab !== "sync" && tab !== "devices";

  return (
    <div className="u2-page">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        subtitle="Automatic sync, where your files go, email drafts, how AI sees your data, and your paired phones."
      />
      <div className="u2-tabs-bar">
        <Tabs
          aria-label="Settings sections"
          idBase={IDBASE}
          value={tab}
          onChange={requestTab}
          items={TABS.map((t) => ({
            id: t.id,
            label: t.label,
            icon: t.icon,
            badge: dirty && t.id === tab ? <span className="u2-dirty-dot" aria-label="unsaved" /> : undefined,
          }))}
        />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${tab}-${epoch}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(4px)" }}
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
        >
          <TabPanel idBase={IDBASE} id={tab} active>
            {needsBundle && err ? (
              <ErrorNotice title="Couldn't load settings" error={err} onRetry={load} />
            ) : needsBundle && !bundle ? (
              <Card padding="lg" aria-busy="true">
                <Skeleton lines={6} />
              </Card>
            ) : tab === "sync" ? (
              <SyncTab onDirtyChange={onDirty} />
            ) : tab === "devices" ? (
              <DevicesSection />
            ) : tab === "storage" ? (
              <StorageTab bundle={bundle!} connections={connections} onSaved={setBundle} onDirtyChange={onDirty} />
            ) : tab === "email" ? (
              <EmailTab bundle={bundle!} connections={connections} onSaved={setBundle} onDirtyChange={onDirty} />
            ) : (
              <AiTab bundle={bundle!} onSaved={setBundle} onDirtyChange={onDirty} />
            )}
          </TabPanel>
        </motion.div>
      </AnimatePresence>

      <Dialog
        open={pending != null}
        onClose={() => setPending(null)}
        size="sm"
        title="Discard unsaved changes?"
        description={`You have unsaved changes on the ${TABS.find((t) => t.id === tab)?.label} tab.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const next = pending;
                setPending(null);
                setEpoch((e) => e + 1);
                if (next) switchTo(next);
              }}
            >
              Discard & switch
            </Button>
          </>
        }
      />
    </div>
  );
}
