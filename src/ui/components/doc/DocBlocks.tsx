import type { DocBlock } from "../../../contracts";

/** A block, or a row/item range of a splittable block (table rows, list items). */
export interface Fragment {
  i: number;
  from?: number;
  to?: number;
}

const CALLOUT_LABEL: Record<"info" | "warning" | "fixture" | "draft", string> = {
  info: "Note",
  warning: "Attention",
  fixture: "Synthetic data",
  draft: "Draft",
};

function colWidths(cols: { width?: number }[]): (string | undefined)[] {
  const given = cols.map((c) => (typeof c.width === "number" && c.width > 0 ? c.width : null));
  const known = given.filter((w): w is number => w !== null);
  if (known.length === 0) return cols.map(() => undefined);
  const avg = known.reduce((a, b) => a + b, 0) / known.length;
  const all = given.map((w) => w ?? avg);
  const sum = all.reduce((a, b) => a + b, 0);
  return all.map((w) => `${((w / sum) * 100).toFixed(3)}%`);
}

/** Renders one DocBlock (or a slice of it) as paper HTML. Text only — never HTML injection. */
export function BlockView({ block, from, to }: { block: DocBlock; from?: number; to?: number }) {
  switch (block.type) {
    case "heading":
      return (
        <h2 className="dp-h" data-section={block.section}>
          {block.text}
        </h2>
      );
    case "paragraph":
      return <p className={`dp-p dp-p-${block.tone ?? "default"}`}>{block.text}</p>;
    case "list": {
      const items = block.items.slice(from ?? 0, to ?? block.items.length);
      return (
        <ul className="dp-list">
          {items.map((it, k) => (
            <li key={k}>
              <span className="dp-li-text">{it.text}</span>
              {it.tag && <span className="dp-tag">{it.tag}</span>}
            </li>
          ))}
        </ul>
      );
    }
    case "kv":
      return (
        <dl className={`dp-kv dp-kv-${block.columns ?? 1}`}>
          {block.items.map((it, k) => (
            <div className="dp-kv-item" key={k}>
              <dt>{it.label}</dt>
              <dd>{it.value || "—"}</dd>
            </div>
          ))}
        </dl>
      );
    case "table": {
      const widths = colWidths(block.columns);
      const rows = block.rows.slice(from ?? 0, to ?? block.rows.length);
      const continued = (from ?? 0) > 0;
      return (
        <table className={continued ? "dp-table dp-table-cont" : "dp-table"}>
          <colgroup>
            {block.columns.map((_, k) => (
              <col key={k} style={widths[k] ? { width: widths[k] } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {block.columns.map((c, k) => (
                <th key={k} scope="col" className={c.align === "right" ? "dp-r" : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {block.columns.map((c, k) => (
                  <td key={k} className={c.align === "right" ? "dp-r" : undefined}>
                    {r[k] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "totals":
      return (
        <div className="dp-totals">
          <table>
            <tbody>
              {block.rows.map((r, k) => (
                <tr key={k} className={r.strong ? "dp-tot-strong" : undefined}>
                  <th scope="row">{r.label}</th>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout":
      return (
        <div className={`dp-callout dp-callout-${block.tone}`} role="note">
          <span className="dp-callout-label">{CALLOUT_LABEL[block.tone] ?? "Note"}</span>
          <p>{block.text}</p>
        </div>
      );
    case "signatures":
      return (
        <div className="dp-sigs-wrap">
          {block.statement && <p className="dp-sig-statement">{block.statement}</p>}
          <div className="dp-sigs">
            {block.lines.map((l, k) => (
              <div className="dp-sig" key={k}>
                <div className="dp-sig-main">
                  <div className="dp-sig-name">{l.name || " "}</div>
                  <div className="dp-sig-line" />
                  <div className="dp-sig-label">{l.label}</div>
                </div>
                <div className="dp-sig-date">
                  <div className="dp-sig-name">{" "}</div>
                  <div className="dp-sig-line" />
                  <div className="dp-sig-label">Date</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    case "divider":
      return <hr className="dp-hr" />;
    default:
      return null;
  }
}

/** Selector for the measurable parts of a splittable block, or null. */
export function partSelector(block: DocBlock): string | null {
  if (block.type === "table" && block.rows.length > 1) return "tbody > tr";
  if (block.type === "list" && block.items.length > 1) return "li";
  return null;
}
