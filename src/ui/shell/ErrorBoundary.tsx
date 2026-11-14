import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadForChunkError } from "./chunkReload";

interface Props {
  children: ReactNode;
  /** "app" covers the whole screen; "page" sits inside the shell so navigation keeps working. */
  scope: "app" | "page";
  /** Changing this (e.g. the route key) clears a caught error. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Catches render errors so one broken component never blanks the app.
 * Logs to the console only (nothing is sent anywhere).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[vexo] ${this.props.scope} render error`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
    // A stale chunk that slipped past the lazy wrapper: reload once.
    reloadForChunkError(error);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, stack: "" });
  }

  private retry = () => this.setState({ error: null, stack: "" });

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkLoadError(error);
    const page = this.props.scope === "page";
    return (
      <div className={page ? "eb eb-page" : "eb eb-app"} role="alert">
        <div className="eb-card">
          <h2 className="eb-title">Something went wrong</h2>
          <p className="eb-text">
            {stale
              ? "A newer version of the app was released. Reload to get it."
              : page
                ? "This page hit an error. Other pages still work, or reload to start fresh."
                : "The app hit an error. Reloading usually fixes it."}
          </p>
          <div className="eb-actions">
            <button type="button" className="ds-btn ds-btn-primary ds-btn-md" onClick={() => window.location.reload()}>
              Reload
            </button>
            {page && !stale && (
              <button type="button" className="ds-btn ds-btn-secondary ds-btn-md" onClick={this.retry}>
                Try again
              </button>
            )}
            {page && (
              <a className="ds-btn ds-btn-ghost ds-btn-md" href="#/">
                Go to Today
              </a>
            )}
          </div>
          <details className="eb-details">
            <summary>Error details</summary>
            <pre className="mono">
              {error.name}: {error.message}
              {stack}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
