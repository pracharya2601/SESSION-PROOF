import { AlertOctagon, RotateCw } from "lucide-react";
import { ApiClientError } from "../api";

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** Error box that always shows the correlation ID when the server provided one. */
export function ErrorNotice({ error, title, onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  const cid = error instanceof ApiClientError ? error.correlationId : "";
  const code = error instanceof ApiClientError ? error.code : "";
  return (
    <div className="error-box notice" role="alert">
      <AlertOctagon className="notice-ico" size={18} aria-hidden="true" />
      <div className="stack-sm notice-body">
        <p>
          <strong>{title ?? "Error"}:</strong> {errorMessage(error)}
        </p>
        {(code || cid) && (
          <p className="small muted">
            {code && (
              <>
                Code: <span className="mono">{code}</span>{" "}
              </>
            )}
            {cid && (
              <>
                Correlation ID: <span className="mono">{cid}</span>
              </>
            )}
          </p>
        )}
        {onRetry && (
          <div>
            <button type="button" className="ds-btn ds-btn-secondary ds-btn-sm" onClick={onRetry}>
              <RotateCw size={14} aria-hidden="true" /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
