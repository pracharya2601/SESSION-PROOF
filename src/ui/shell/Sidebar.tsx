import { motion, useReducedMotion } from "framer-motion";
import { CalendarCheck2, FolderOpen, PanelLeftClose, PanelLeftOpen, PlugZap, Settings2, type LucideIcon } from "lucide-react";
import type { NavKey } from "./routes";
import { Logo } from "./Logo";
import { springy } from "../design/motion";

export const NAV: { key: NavKey; label: string; href: string; icon: LucideIcon }[] = [
  { key: "today", label: "Today", href: "#/", icon: CalendarCheck2 },
  { key: "files", label: "Files", href: "#/files", icon: FolderOpen },
  { key: "connections", label: "Connections", href: "#/connections", icon: PlugZap },
  { key: "settings", label: "Settings", href: "#/settings", icon: Settings2 },
];

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
        <ul>
          {NAV.map((n) => {
            const on = n.key === active;
            const Icon = n.icon;
            return (
              <li key={n.key}>
                <a href={n.href} className={on ? "side-link on" : "side-link"} aria-current={on ? "page" : undefined} title={collapsed ? n.label : undefined}>
                  {on && <motion.span className="side-indicator" layoutId="side-indicator" transition={reduce ? { duration: 0 } : springy} />}
                  <Icon size={18} aria-hidden="true" className="side-ico" />
                  <span className="side-label">{n.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="side-foot">
        <button type="button" className="side-link side-collapse" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}>
          {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" className="side-ico" /> : <PanelLeftClose size={18} aria-hidden="true" className="side-ico" />}
          <span className="side-label">Collapse</span>
        </button>
      </div>
    </motion.aside>
  );
}

export function BottomNav({ active }: { active: NavKey }) {
  const reduce = useReducedMotion();
  return (
    <nav className="bottom-nav" aria-label="Primary">
      <ul>
        {NAV.map((n) => {
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
      </ul>
    </nav>
  );
}
