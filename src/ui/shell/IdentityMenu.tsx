import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, LogOut, Monitor, Moon, Sun } from "lucide-react";
import type { ThemePref } from "./theme";

function initials(name: string): string {
  const base = name.split("@")[0] ?? name;
  const parts = base.split(/[.\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function IdentityMenu({
  who,
  theme,
  onTheme,
  onSignOut,
}: {
  who: string;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    const t = window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>("[role=menuitem],[role=menuitemradio]")?.focus(), 30);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.clearTimeout(t);
    };
  }, [open]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem],[role=menuitemradio]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const themes: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
    { id: "system", label: "System", icon: Monitor },
  ];

  return (
    <div className="idmenu" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="idmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="identity-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(who)}
        </span>
        <span className="idmenu-name">{who}</span>
        <ChevronDown size={14} aria-hidden="true" className="idmenu-chev" />
        <span className="sr-only">Account menu</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id="identity-menu"
            role="menu"
            aria-label="Account"
            className="idmenu-pop"
            onKeyDown={onMenuKey}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
          >
            <div className="idmenu-head" role="none">
              <span className="avatar avatar-lg" aria-hidden="true">
                {initials(who)}
              </span>
              <div className="idmenu-who">
                <span className="tiny subtle">Signed in as</span>
                <strong>{who}</strong>
              </div>
            </div>
            <div className="idmenu-sep" role="separator" />
            <div className="idmenu-label tiny subtle" role="none">
              Theme
            </div>
            <div className="idmenu-themes" role="group" aria-label="Theme">
              {themes.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === t.id}
                    className={theme === t.id ? "idmenu-theme on" : "idmenu-theme"}
                    onClick={() => onTheme(t.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {t.label}
                  </button>
                );
              })}
            </div>
            <div className="idmenu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="idmenu-item danger"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <LogOut size={16} aria-hidden="true" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
