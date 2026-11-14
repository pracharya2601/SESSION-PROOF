import type { DocumentationChecks } from "../../../contracts";

export function ChecksPanel(props: { checks: DocumentationChecks }) {
  const blocking = props.checks.issues.filter((i) => i.blocking);
  const info = props.checks.issues.filter((i) => !i.blocking);
  return (
    <section className="card rv-checks" aria-label="Documentation checks">
      <h2>Documentation checks — not a compliance determination</h2>
      <p className="muted rv-small">Rule version {props.checks.ruleVersion}</p>
      {blocking.length === 0 && info.length === 0 && <p>No issues found.</p>}
      {blocking.length > 0 && (
        <>
          <h3 className="rv-block-h">Blocking — must fix ({blocking.length})</h3>
          <ul className="rv-issues">
            {blocking.map((i, n) => (
              <li key={n} className="rv-issue rv-issue-blocking">
                <strong>{i.field}</strong>: {i.message}
              </li>
            ))}
          </ul>
        </>
      )}
      {info.length > 0 && (
        <>
          <h3>Informational ({info.length})</h3>
          <ul className="rv-issues">
            {info.map((i, n) => (
              <li key={n} className="rv-issue rv-issue-info">
                <strong>{i.field}</strong>: {i.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
