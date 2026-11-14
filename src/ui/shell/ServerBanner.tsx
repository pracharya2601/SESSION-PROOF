import { useCallback, useEffect, useRef, useState } from "react";
import { api, SERVER_RECOVERED_EVENT, SERVER_TROUBLE_EVENT } from "../api";

/** Health re-check delays while the server is down (ms); the last one repeats. */
export const HEALTH_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export function backoffDelay(attempt: number): number {
  return HEALTH_BACKOFF_MS[Math.min(Math.max(attempt, 0), HEALTH_BACKOFF_MS.length - 1)]!;
}

/**
 * "Server unavailable — retrying" strip. Wakes up when any API call fails with a network
 * error or 5xx (api.ts dispatches SERVER_TROUBLE_EVENT), confirms with /api/health, and
 * re-checks with backoff (paused while the tab is hidden) until health answers again.
 * Health-confirmed only, so a single failing endpoint does not raise a false alarm.
 */
export function ServerBanner() {
  const [down, setDown] = useState(false);
  const [checking, setChecking] = useState(false);
  const state = useRef({ checking: false, down: false, attempt: 0, timer: 0 as number | undefined });

  const check = useCallback(async () => {
    const s = state.current;
    if (s.checking) return;
    if (s.timer) window.clearTimeout(s.timer);
    s.timer = undefined;
    s.checking = true;
    setChecking(true);
    let ok = false;
    try {
      ok = (await api.health({ silent: true })).ok !== false;
    } catch {
      ok = false;
    }
    s.checking = false;
    setChecking(false);
    if (ok) {
      const wasDown = s.down;
      s.down = false;
      s.attempt = 0;
      setDown(false);
      if (wasDown) window.dispatchEvent(new Event(SERVER_RECOVERED_EVENT));
      return;
    }
    s.down = true;
    setDown(true);
    const delay = backoffDelay(s.attempt++);
    s.timer = window.setTimeout(() => {
      s.timer = undefined;
      if (document.visibilityState === "hidden") return; // resumed by visibilitychange
      void check();
    }, delay);
  }, []);

  useEffect(() => {
    const s = state.current;
    const onTrouble = () => {
      if (!s.down && !s.checking) void check();
    };
    const onVis = () => {
      if (document.visibilityState === "visible" && s.down && !s.timer && !s.checking) void check();
    };
    window.addEventListener(SERVER_TROUBLE_EVENT, onTrouble);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener(SERVER_TROUBLE_EVENT, onTrouble);
      document.removeEventListener("visibilitychange", onVis);
      if (s.timer) window.clearTimeout(s.timer);
    };
  }, [check]);

  if (!down) return null;
  return (
    <div className="server-banner" role="status" aria-live="polite">
      <span className="server-banner-dot" aria-hidden="true" />
      <span>Server unavailable — retrying{checking ? "…" : " automatically"}.</span>
      <button type="button" className="server-banner-btn" onClick={() => void check()} disabled={checking}>
        Retry now
      </button>
    </div>
  );
}
