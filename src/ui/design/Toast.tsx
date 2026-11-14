import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cx } from "./cx";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms; 0 = sticky. Default 4500 (danger: 7000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

export interface ToastApi {
  /** Show a toast; returns its id. */
  toast: (opts: ToastOptions) => number;
  success: (title: ReactNode, description?: ReactNode) => number;
  error: (title: ReactNode, description?: ReactNode) => number;
  info: (title: ReactNode, description?: ReactNode) => number;
  warning: (title: ReactNode, description?: ReactNode) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((opts: ToastOptions) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { ...opts, id }]);
    return id;
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ title, description, tone: "success" }),
      error: (title, description) => toast({ title, description, tone: "danger" }),
      info: (title, description) => toast({ title, description, tone: "info" }),
      warning: (title, description) => toast({ title, description, tone: "warning" }),
    }),
    [toast, dismiss],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

/** Must be used under <ToastProvider> (App mounts it). */
export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast() must be used inside <ToastProvider>");
  return ctx;
}

function ToastViewport({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="ds-toasts" aria-live="polite" aria-relevant="additions" role="region" aria-label="Notifications">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const reduce = useReducedMotion();
  const tone = item.tone ?? "info";
  const Icon = ICON[tone];
  const duration = item.duration ?? (tone === "danger" ? 7000 : 4500);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!duration || paused) return;
    const t = window.setTimeout(() => onDismiss(item.id), duration);
    return () => window.clearTimeout(t);
  }, [duration, paused, item.id, onDismiss]);

  return (
    <motion.div
      layout={!reduce}
      className={cx("ds-toast", `ds-toast-${tone}`)}
      role={tone === "danger" ? "alert" : "status"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.95, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className="ds-toast-ico" size={18} aria-hidden="true" />
      <div className="ds-toast-body">
        <div className="ds-toast-title">{item.title}</div>
        {item.description && <div className="ds-toast-desc">{item.description}</div>}
        {item.action && (
          <button
            type="button"
            className="ds-toast-action"
            onClick={() => {
              item.action?.onClick();
              onDismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button type="button" className="ds-toast-x" aria-label="Dismiss notification" onClick={() => onDismiss(item.id)}>
        <X size={14} aria-hidden="true" />
      </button>
      {duration > 0 && !reduce && (
        <motion.span
          className="ds-toast-timer"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: paused ? undefined : 0 }}
          transition={{ duration: duration / 1000, ease: "linear" }}
          aria-hidden="true"
        />
      )}
    </motion.div>
  );
}
