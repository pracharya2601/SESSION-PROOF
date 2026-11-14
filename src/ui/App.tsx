import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "framer-motion";
import type { HealthResponse } from "../contracts";
import { api, ApiClientError, type MeResponse } from "./api";
import { ErrorNotice } from "./components/ErrorNotice";
import { ToastProvider } from "./design/Toast";
import { Skeleton } from "./design/Skeleton";
import { fadeOnly, pageTransition } from "./design/motion";
import { Aurora } from "./shell/Aurora";
import { BottomNav, Sidebar } from "./shell/Sidebar";
import { SignIn } from "./shell/SignIn";
import { TopBar } from "./shell/TopBar";
import { navKeyOf, parseHash, ROUTE_TITLES, routeKey, type Route } from "./shell/routes";
import { useTheme } from "./shell/theme";
import Today from "./pages/Today";

const Review = lazy(() => import("./pages/Review"));
const Files = lazy(() => import("./pages/Files"));
const Connections = lazy(() => import("./pages/Connections"));
const Settings = lazy(() => import("./pages/Settings"));

const DEMO_IDENTITY = "demo.provider@example.invalid";
const COLLAPSE_KEY = "vexo.sidebar.collapsed";

type Auth =
  | { kind: "loading" }
  | { kind: "signedIn"; me: MeResponse }
  | { kind: "signedOut" }
  | { kind: "error"; error: unknown };

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function PageFallback() {
  return (
    <div className="page-fallback" aria-busy="true" aria-label="Loading page">
      <Skeleton width="40%" height={34} radius={10} />
      <Skeleton width="65%" height={14} />
      <div className="page-fallback-grid">
        <Skeleton height={140} radius={16} />
        <Skeleton height={140} radius={16} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </MotionConfig>
  );
}

function AppInner() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<unknown>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const theme = useTheme();
  const reduce = useReducedMotion();

  useEffect(() => {
    const onHash = () => {
      const next = parseHash(window.location.hash);
      setRoute((prev) => {
        if (routeKey(prev) !== routeKey(next)) {
          window.scrollTo(0, 0);
          window.setTimeout(() => document.getElementById("main")?.focus({ preventScroll: true }), 0);
        }
        return next;
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const t = ROUTE_TITLES[route.name];
    document.title = t === "Today" ? "Vexo Field Assistant" : `${t} · Vexo Field Assistant`;
  }, [route.name]);

  const loadMe = useCallback(async () => {
    setAuth({ kind: "loading" });
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
    try {
      const me = await api.me();
      setAuth({ kind: "signedIn", me });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) setAuth({ kind: "signedOut" });
      else setAuth({ kind: "error", error: err });
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function signIn() {
    setSignInBusy(true);
    setSignInError(null);
    try {
      await api.devLogin(DEMO_IDENTITY);
      await loadMe();
    } catch (err) {
      setSignInError(err);
    } finally {
      setSignInBusy(false);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      /* session cookie may already be gone; treat as signed out */
    }
    setAuth({ kind: "signedOut" });
    window.location.hash = "#/";
  }

  const goHome = useCallback(() => {
    window.location.hash = "#/";
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  }

  const devMode = health ? health.authMode === "dev" : true;
  const who =
    auth.kind === "signedIn"
      ? String(auth.me.displayName ?? auth.me.identity ?? auth.me.email ?? auth.me.providerId ?? "Signed in")
      : null;
  const signedIn = auth.kind === "signedIn";
  const variants = reduce ? fadeOnly : pageTransition;

  return (
    <>
      <Aurora />
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className={signedIn ? "shell" : "shell shell-bare"} data-collapsed={collapsed || undefined}>
        {signedIn && <Sidebar active={navKeyOf(route)} collapsed={collapsed} onToggle={toggleCollapsed} />}
        <div className="shell-main">
          <TopBar
            title={signedIn ? ROUTE_TITLES[route.name] : "Welcome"}
            health={health}
            who={who}
            theme={theme.pref}
            resolvedTheme={theme.resolved}
            onTheme={theme.setPref}
            onToggleTheme={theme.toggle}
            onSignOut={() => void signOut()}
          />
          <main id="main" className="content" tabIndex={-1}>
            {auth.kind === "loading" && <PageFallback />}
            {auth.kind === "error" && (
              <div className="content-narrow">
                <ErrorNotice
                  title={
                    auth.error instanceof ApiClientError && (auth.error.code === "NETWORK" || auth.error.status >= 500)
                      ? "Backend unavailable"
                      : "Could not load your account"
                  }
                  error={auth.error}
                  onRetry={() => void loadMe()}
                />
              </div>
            )}
            {auth.kind === "signedOut" && (
              <SignIn identity={DEMO_IDENTITY} busy={signInBusy} error={signInError} onSignIn={() => void signIn()} />
            )}
            {signedIn && (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={routeKey(route)} className="page" variants={variants} initial="initial" animate="enter" exit="exit">
                  <Suspense fallback={<PageFallback />}>
                    {route.name === "today" && <Today devMode={devMode} />}
                    {route.name === "session" && <Review sessionId={route.id} onBack={goHome} />}
                    {route.name === "files" && <Files />}
                    {route.name === "connections" && <Connections />}
                    {route.name === "settings" && <Settings />}
                  </Suspense>
                </motion.div>
              </AnimatePresence>
            )}
          </main>
        </div>
        {signedIn && <BottomNav active={navKeyOf(route)} />}
      </div>
    </>
  );
}
