import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  CalendarCheck2,
  Ellipsis,
  FolderOpen,
  LayoutTemplate,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Settings2,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { NavKey } from "./routes";
import { Logo } from "./Logo";
import { springy } from "../design/motion";
import { Dialog } from "../design/Dialog";
import "./nav.css";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  icon: LucideIcon;
}

export const NAV_GROUPS: { id: string; label: string; items: NavItem[] }[] = [
  {
    id: "work",
    label: "Work",
    items: [
      { key: "today", label: "Today", href: "#/", icon: CalendarCheck2 },
      { key: "visit", label: "Record visit", href: "#/visit", icon: Mic },
      { key: "runs", label: "Runs", href: "#/runs", icon: Activity },
      { key: "files", label: "Files", href: "#/files", icon: FolderOpen },
    ],
  },
  {
    id: "records",
    label: "Records",
    items: [
      { key: "clients", label: "Clients", href: "#/clients", icon: Users },
      { key: "templates", label: "Templates", href: "#/templates", icon: LayoutTemplate },
    ],
  },
  {
    id: "setup",
    label: "Setup",
    items: [
      { key: "connections", label: "Connections", href: "#/connections", icon: PlugZap },
      { key: "settings", label: "Settings", href: "#/settings", icon: Settings2 },
    ],
  },
];

export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Items shown directly in the mobile bottom nav; the rest go in the "More" sheet. */
const BOTTOM_KEYS: NavKey[] = ["today", "visit", "runs", "clients"];
const BOTTOM = BOTTOM_KEYS.map((k) => NAV.find((n) => n.key === k)!);
const MORE = NAV.filter((n) => !BOTTOM_KEYS.includes(n.key));

export function Sidebar({ active, collapsed, onToggle }: { active: NavKey; collapsed: boolean; onToggle: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.aside
      className="sidebar"
      data-collapsed={collapsed || undefined}
      animate={{ width: collapsed ? 72 : 248 }}
      initial={false}
      transition={reduce ? { duration: 0 } : springy}
    >
      <a className="brand" href="#/" aria-label="Vexo Field Assistant — Today">
        <Logo />
        <motion.span className="brand-text" animate={{ opacity: collapsed ? 0 : 1 }} transition={{ duration: 0.15 }}>
          <span className="brand-name">Vexo</span>
          <span className="brand-sub">Field Assistant</span>
        </motion.span>
      </a>
      <nav aria-label="Primary" className="side-nav">
        {NAV_GROUPS.map((g) => (
          <div key={g.id} className="side-group" role="group" aria-labelledby={`side-group-${g.id}`}>
            <div className="side-group-label" id={`side-group-${g.id}`}>
              <span>{g.label}</span>
            </div>
            <ul>
              {g.items.map((n) => {
                const on = n.key === active;
                const Icon = n.icon;
                return (
                  <li key={n.key}>
                    <a
                      href={n.href}
                      className={on ? "side-link on" : "side-link"}
                      aria-current={on ? "page" : undefined}
                      title={collapsed ? n.label : undefined}
                    >
                      {on && (
                        <motion.span className="side-indicator" layoutId="side-indicator" transition={reduce ? { duration: 0 } : springy} />
                      )}
                      <Icon size={18} aria-hidden="true" className="side-ico" />
                      <span className="side-label">{n.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <button
          type="button"
          className="side-link side-collapse"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} aria-hidden="true" className="side-ico" />
          ) : (
            <PanelLeftClose size={18} aria-hidden="true" className="side-ico" />
          )}
          <span className="side-label">Collapse</span>
        </button>
      </div>
    </motion.aside>
  );
}

export function BottomNav({ active }: { active: NavKey }) {
  const reduce = useReducedMotion();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE.some((n) => n.key === active);

  // Close the sheet whenever navigation happens.
  useEffect(() => {
    const h = () => setMoreOpen(false);
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  return (
    <nav className="bottom-nav" aria-label="Primary">
      <ul className="bn-list">
        {BOTTOM.map((n) => {
          const on = n.key === active;
          const Icon = n.icon;
          return (
            <li key={n.key}>
              <a href={n.href} className={on ? "bn-link on" : "bn-link"} aria-current={on ? "page" : undefined}>
                {on && <motion.span className="bn-indicator" layoutId="bn-indicator" transition={reduce ? { duration: 0 } : springy} />}
                <Icon size={20} aria-hidden="true" />
                <span>{n.label}</span>
              </a>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            className={moreActive ? "bn-link bn-more on" : "bn-link bn-more"}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            {moreActive && (
              <motion.span className="bn-indicator" layoutId="bn-indicator" transition={reduce ? { duration: 0 } : springy} />
            )}
            <Ellipsis size={20} aria-hidden="true" />
            <span>{moreActive ? MORE.find((n) => n.key === active)?.label : "More"}</span>
          </button>
        </li>
      </ul>
      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More" size="sm">
        <ul className="bn-sheet">
          {MORE.map((n) => {
            const on = n.key === active;
            const Icon = n.icon;
            return (
              <li key={n.key}>
                <a
                  href={n.href}
                  className={on ? "bn-sheet-link on" : "bn-sheet-link"}
                  aria-current={on ? "page" : undefined}
                  onClick={() => setMoreOpen(false)}
                >
                  <span className="bn-sheet-ico">
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span>{n.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </Dialog>
    </nav>
  );
}
