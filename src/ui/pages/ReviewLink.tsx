/**
 * Review link page: `/r/<token>` (path route; the assets SPA fallback serves index.html for it,
 * and `#/r/<token>` works too). No sign-in: the token opens ONE visit's full review page — the
 * same Review component with the approval checklist, corrections and Approve. Nothing is approved
 * by opening the link. Expired, revoked and already-approved links get a clear explanation.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Link2Off, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { ApiClientError, reviewLinkApi } from "../api";
import { Button, Card, Skeleton } from "../design";
import { Aurora } from "../shell/Aurora";
import { Logo } from "../shell/Logo";
import type { ReviewSource } from "./Review";

const Review = lazy(() => import("./Review"));

type State = { kind: "loading" } | { kind: "ready"; sessionId: string } | { kind: "error"; code: string; message: string };

const COPY: Record<string, { title: string; icon: ReactNode; body: string }> = {
  REVIEW_LINK_EXPIRED: {
    title: "This review link has expired",
    icon: <Clock size={28} />,
    body: "Review links work for 7 days. Open the app to review and approve the visit.",
  },
  REVIEW_LINK_REVOKED: {
    title: "This review link was turned off",
    icon: <Link2Off size={28} />,
    body: "It was revoked in the app. Open the app to review and approve the visit.",
  },
  REVIEW_LINK_USED: {
    title: "This visit is already approved",
    icon: <CheckCircle2 size={28} />,
    body: "Nothing more to do here. The session note, invoice and approval record are in the app.",
  },
  INVALID_REVIEW_LINK: {
    title: "This review link isn't valid",
    icon: <ShieldAlert size={28} />,
    body: "Check that the whole link was copied, or open the app to review the visit.",
  },
};

function goToApp() {
  window.location.href = "/";
}

export default function ReviewLink({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const client = useMemo(() => reviewLinkApi(token), [token]);
  const source = useMemo<ReviewSource>(() => ({ ...client, linkMode: true }), [client]);

  useEffect(() => {
    // The URL carries a credential: never send it as a referrer.
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    document.title = "Review visit · Vexo Field Assistant";
    return () => {
      meta.remove();
    };
  }, []);

  useEffect(() => {
    let live = true;
    client
      .getSession("")
      .then((d) => live && setState({ kind: "ready", sessionId: d.session.id }))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiClientError) setState({ kind: "error", code: e.code, message: e.message });
        else setState({ kind: "error", code: "NETWORK", message: "The server could not be reached." });
      });
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <>
      <Aurora />
      <div className="shell shell-bare">
        <div className="shell-main">
          <header className="topbar" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px" }}>
            <Logo size={28} />
            <strong>Vexo Field Assistant</strong>
            <span className="subtle small" style={{ marginLeft: "auto" }}>
              Review link · one visit
            </span>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            {state.kind === "loading" && (
              <div className="content-narrow" aria-busy="true">
                <Skeleton width="50%" height={28} />
                <Skeleton lines={4} />
              </div>
            )}
            {state.kind === "error" && <LinkProblem code={state.code} message={state.message} />}
            {state.kind === "ready" && (
              <Suspense fallback={<Skeleton lines={6} />}>
                <Review sessionId={state.sessionId} onBack={goToApp} source={source} />
              </Suspense>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

function LinkProblem({ code, message }: { code: string; message: string }) {
  const copy = COPY[code] ?? {
    title: "Couldn't open this visit",
    icon: <ShieldAlert size={28} />,
    body: message || "Please try again, or open the app.",
  };
  return (
    <div className="content-narrow">
      <Card padding="lg">
        <div role="alert" style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <span aria-hidden="true" style={{ color: "var(--accent, #8d7dff)", flex: "none" }}>
            {copy.icon}
          </span>
          <div>
            <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{copy.title}</h1>
            <p className="subtle" style={{ margin: "0 0 16px" }}>
              {copy.body}
            </p>
            <Button variant="primary" onClick={goToApp}>
              Open the app
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
