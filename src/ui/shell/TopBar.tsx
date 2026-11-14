import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import type { HealthResponse } from "../../contracts";
import { ModeBadges } from "../components/ModeBadges";
import { IdentityMenu } from "./IdentityMenu";
import { Logo } from "./Logo";
import type { ThemePref } from "./theme";

export function TopBar({
  title,
  health,
  who,
  theme,
  resolvedTheme,
  onTheme,
  onToggleTheme,
  onSignOut,
}: {
  title: string;
  health: HealthResponse | null;
  who: string | null;
  theme: ThemePref;
  resolvedTheme: "light" | "dark";
  onTheme: (t: ThemePref) => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="topbar-logo" href="#/" aria-label="Vexo Field Assistant — Today">
          <Logo size={26} />
        </a>
        <div className="topbar-title" aria-hidden="true">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={title}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
            >
              {title}
            </motion.span>
          </AnimatePresence>
        </div>
        <div className="topbar-badges">
          <ModeBadges health={health} />
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon ds-btn-md theme-toggle"
            onClick={onToggleTheme}
            aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={resolvedTheme}
                initial={reduce ? { opacity: 0 } : { opacity: 0, rotate: -90, scale: 0.6 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, rotate: 90, scale: 0.6 }}
                transition={{ duration: 0.2 }}
                style={{ display: "inline-flex" }}
              >
                {resolvedTheme === "dark" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
              </motion.span>
            </AnimatePresence>
          </button>
          {who && <IdentityMenu who={who} theme={theme} onTheme={onTheme} onSignOut={onSignOut} />}
        </div>
      </div>
      <div className="topbar-badges-mobile">
        <ModeBadges health={health} compact />
      </div>
    </header>
  );
}
