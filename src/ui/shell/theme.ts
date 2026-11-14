import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "vexo.theme";

export function readTheme(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

function systemDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

/** Theme preference persisted in localStorage (best effort). `resolved` is the theme actually shown. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readTheme);
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    applyTheme(pref);
    try {
      if (pref === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, pref);
    } catch {
      /* storage blocked: preference lasts for this page only */
    }
  }, [pref]);

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const on = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, []);

  const resolved: "light" | "dark" = pref === "system" ? (sysDark ? "dark" : "light") : pref;
  const toggle = useCallback(() => setPref(resolved === "dark" ? "light" : "dark"), [resolved]);
  return { pref, setPref, resolved, toggle };
}
