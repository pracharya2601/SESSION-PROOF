import { motion, useReducedMotion } from "framer-motion";
import { Ban, Check } from "lucide-react";
import type { Connection, ConnectionProvider } from "../../../contracts";
import { Badge, cx, springy } from "../../design";
import { CONNECTION_LABELS, CONNECTION_PROVIDERS } from "./shared";

export function connectionTone(c: Connection | undefined) {
  if (!c) return { tone: "neutral" as const, label: "Unknown" };
  switch (c.status) {
    case "connected":
      return { tone: "success" as const, label: "Connected" };
    case "error":
      return { tone: "danger" as const, label: "Needs reconnect" };
    case "not_configured":
      return { tone: "warning" as const, label: "Not configured" };
    default:
      return { tone: "neutral" as const, label: "Not connected" };
  }
}

/** Radio-card picker for Google / Microsoft / none, showing each connection's status. */
export function ProviderChoice({
  value,
  onChange,
  connections,
  kind,
  name,
  legend,
  only,
}: {
  value: ConnectionProvider | null;
  onChange: (p: ConnectionProvider | null) => void;
  connections: Connection[];
  kind: "storage" | "mail";
  name: string;
  legend: string;
  /** Restrict to these providers and hide "None" (e.g. connected accounts in the draft composer). */
  only?: ConnectionProvider[];
}) {
  const reduce = useReducedMotion();
  const options: (ConnectionProvider | null)[] = only
    ? CONNECTION_PROVIDERS.filter((p) => only.includes(p))
    : [...CONNECTION_PROVIDERS, null];
  return (
    <fieldset className="u2-choice">
      <legend className="ds-field-label">{legend}</legend>
      <div className="u2-choice-grid">
        {options.map((p) => {
          const selected = value === p;
          const conn = p ? connections.find((c) => c.provider === p) : undefined;
          const st = connectionTone(conn);
          return (
            <label key={p ?? "none"} className={cx("u2-choice-card", selected && "u2-choice-on")}>
              <input
                type="radio"
                className="sr-only"
                name={name}
                checked={selected}
                onChange={() => onChange(p)}
              />
              {selected && (
                <motion.span
                  layoutId={`${name}-ring`}
                  className="u2-choice-ring"
                  transition={reduce ? { duration: 0 } : springy}
                  aria-hidden="true"
                />
              )}
              <span className={cx("u2-choice-logo", p ? `u2-logo-${p}` : "u2-logo-none")} aria-hidden="true">
                {p ? (p === "google" ? "G" : "M") : <Ban size={16} />}
              </span>
              <span className="u2-choice-text">
                <span className="u2-choice-name">{p ? CONNECTION_LABELS[p][kind] : "None"}</span>
                {p ? (
                  <Badge tone={st.tone} dot>
                    {st.label}
                  </Badge>
                ) : (
                  <span className="u2-muted u2-small">{kind === "storage" ? "Don't upload" : "Pick each time"}</span>
                )}
              </span>
              {selected && (
                <motion.span className="u2-choice-check" initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={springy}>
                  <Check size={14} aria-hidden="true" />
                </motion.span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
