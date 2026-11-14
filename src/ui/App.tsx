import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "framer-motion";
import type { HealthResponse } from "../contracts";
import { api, ApiClientError, SERVER_RECOVERED_EVENT, type MeResponse } from "./api";
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
import { navigationAllowed } from "./shell/navGuard";
import { lazyWithReload as lazy } from "./shell/chunkReload";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ServerBanner } from "./shell/ServerBanner";
import Today from "./pages/Today";

// Route chunks. lazyWithReload reloads the tab once when a chunk is gone after a redeploy.
const Review = lazy(() => import("./pages/Review"));
const Files = lazy(() => import("./pages/Files"));
const Connections = lazy(() => import("./pages/Connections"));
const Settings = lazy(() => import("./pages/Settings"));
const Clients = lazy(() => import("./pages/Clients"));
const ClientDetail = lazy(() => import("./pages/ClientDetail"));
const Templates = lazy(() => import("./pages/Templates"));
const TemplateEditor = lazy(() => import("./pages/TemplateEditor"));
const Runs = lazy(() => import("./pages/Runs"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const RecordVisit = lazy(() => import("./pages/RecordVisit"));
const ReviewLink = lazy(() => import("./pages/ReviewLink"));

/** `/r/<token>` or `#/r/<token>`: a review link opens one visit without signing in (pages/ReviewLink.tsx). */
const REVIEW_LINK_TOKEN = (/^\/r\/(vfrl_[A-Za-z0-9_-]{43})\/?$/.exec(window.location.pathname) ??
  /^#\/r\/(vfrl_[A-Za-z0-9_-]{43})\/?$/.exec(window.location.hash))?.[1];

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
    <ErrorBoundary scope="app">
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <ServerBanner />
          {REVIEW_LINK_TOKEN ? (
            <ErrorBoundary scope="page">
              <Suspense fallback={<PageFallback />}>
                <ReviewLink token={REVIEW_LINK_TOKEN} />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <AppInner />
          )}
        </ToastProvider>
      </MotionConfig>
    </ErrorBoundary>
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
      // A page (Record visit while recording) may block leaving; it restores the URL itself.
      if (!navigationAllowed(window.location.hash)) return;
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
      .catch(() => undefined); // keep the last known health; ServerBanner reports the outage
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

  // Server came back (ServerBanner): retry the account load if it was what failed.
  const authRef = useRef(auth);
  authRef.current = auth;
  useEffect(() => {
    const onRecovered = () => {
      if (authRef.current.kind === "error") void loadMe();
    };
    window.addEventListener(SERVER_RECOVERED_EVENT, onRecovered);
    return () => window.removeEventListener(SERVER_RECOVERED_EVENT, onRecovered);
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
              // Enter-only fade keyed by route. No exit animation: AnimatePresence mode="wait"
              // held the next page back until the old one finished animating out.
              <motion.div key={routeKey(route)} className="page" variants={variants} initial="initial" animate="enter">
                <ErrorBoundary scope="page" resetKey={routeKey(route)}>
                  <Suspense fallback={<PageFallback />}>
                    {route.name === "today" && <Today devMode={devMode} />}
                    {route.name === "session" && <Review sessionId={route.id} onBack={goHome} />}
                    {route.name === "files" && <Files />}
                    {route.name === "connections" && <Connections />}
                    {route.name === "settings" && <Settings />}
                    {route.name === "clients" && <Clients />}
                    {route.name === "client" && <ClientDetail clientRef={route.ref} />}
                    {route.name === "templates" && <Templates />}
                    {route.name === "template" && <TemplateEditor templateId={route.id} />}
                    {route.name === "runs" && <Runs />}
                    {route.name === "run" && <RunDetail runId={route.runId} />}
                    {route.name === "visit" && <RecordVisit visitId={route.id} />}
                  </Suspense>
                </ErrorBoundary>
              </motion.div>
            )}
          </main>
        </div>
        {signedIn && <BottomNav active={navKeyOf(route)} />}
      </div>
    </>
  );
}
