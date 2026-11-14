import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "../contracts";
import { api, ApiClientError, type MeResponse } from "./api";
import { ErrorNotice } from "./components/ErrorNotice";
import { ModeBadges } from "./components/ModeBadges";
import Review from "./pages/Review";
import Today from "./pages/Today";

const DEMO_IDENTITY = "demo.provider@example.invalid";

type Route = { name: "today" } | { name: "session"; id: string };

function parseHash(hash: string): Route {
  const m = /^#\/sessions\/([^/?#]+)\/?$/.exec(hash);
  if (m && m[1]) {
    try {
      return { name: "session", id: decodeURIComponent(m[1]) };
    } catch {
      return { name: "today" };
    }
  }
  return { name: "today" };
}

type Auth =
  | { kind: "loading" }
  | { kind: "signedIn"; me: MeResponse }
  | { kind: "signedOut" }
  | { kind: "error"; error: unknown };

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<unknown>(null);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
      document.getElementById("main")?.focus();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  const devMode = health ? health.authMode === "dev" : true;
  const who =
    auth.kind === "signedIn"
      ? String(auth.me.displayName ?? auth.me.identity ?? auth.me.email ?? auth.me.providerId ?? "Signed in")
      : null;

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="app-title" href="#/">
            Vexo Field Assistant
          </a>
          <ModeBadges health={health} />
          {who && (
            <div className="row">
              <span className="identity">
                Signed in as <strong>{who}</strong>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main id="main" className="app-main" tabIndex={-1}>
        {auth.kind === "loading" && (
          <p className="muted row" role="status">
            <span className="spinner" aria-hidden="true" /> Loading…
          </p>
        )}
        {auth.kind === "error" && (
          <ErrorNotice
            title={
              auth.error instanceof ApiClientError && (auth.error.code === "NETWORK" || auth.error.status >= 500)
                ? "Backend unavailable"
                : "Could not load your account"
            }
            error={auth.error}
            onRetry={() => void loadMe()}
          />
        )}
        {auth.kind === "signedOut" && (
          <section className="card stack signin" aria-labelledby="signin-heading">
            <h1 id="signin-heading">Sign in</h1>
            <p className="muted">
              This is synthetic development authentication. It signs you in as a fictional demo provider
              ({DEMO_IDENTITY}) and is not available in production.
            </p>
            {signInError != null && <ErrorNotice title="Sign-in failed" error={signInError} />}
            <div>
              <button type="button" className="btn btn-primary" onClick={() => void signIn()} disabled={signInBusy}>
                {signInBusy && <span className="spinner" aria-hidden="true" />}
                {signInBusy ? "Signing in…" : "Sign in as demo provider"}
              </button>
            </div>
          </section>
        )}
        {auth.kind === "signedIn" &&
          (route.name === "session" ? (
            <Review key={route.id} sessionId={route.id} onBack={goHome} />
          ) : (
            <Today devMode={devMode} />
          ))}
      </main>
    </>
  );
}
