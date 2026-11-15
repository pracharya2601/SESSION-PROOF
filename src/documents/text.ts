/** Plain text of everything printed on a DocModel (header, letterhead, blocks, footer). Logo bytes excluded. */
import type { DocBlock, DocModel } from "../contracts/v3";

function blockText(b: DocBlock): string[] {
  switch (b.type) {
    case "heading":
    case "paragraph":
    case "callout":
      return [b.text];
    case "list":
      return b.items.map((i) => [i.text, i.tag ?? "", i.refs?.length ? i.refs.map((n) => `[${n}]`).join("") : ""].filter(Boolean).join(" "));
    case "kv":
      return b.items.map((i) => `${i.label}: ${i.value}`);
    case "table":
      return [b.columns.map((c) => c.label).join(" | "), ...b.rows.map((r) => r.join(" | "))];
    case "totals":
      return b.rows.map((r) => `${r.label}: ${r.value}`);
    case "signatures":
      return [b.statement ?? "", ...b.lines.map((l) => [l.label, l.name ?? "", l.signed ?? "", l.date ?? ""].filter(Boolean).join(" · "))];
    case "parties":
      return b.parties.flatMap((p) => [p.label, ...p.lines]);
    default:
      return [];
  }
}

export function docText(m: DocModel): string {
  const out: string[] = [m.title, m.header.logoText, m.header.headerNote, ...m.header.meta.map((x) => `${x.label}: ${x.value}`)];
  if (m.letterhead) out.push(m.letterhead.name, ...m.letterhead.lines, ...m.letterhead.meta.map((x) => `${x.label}: ${x.value}`));
  if (m.banner) out.push(m.banner);
  if (m.watermark) out.push(m.watermark);
  for (const b of m.blocks) out.push(...blockText(b));
  out.push(m.footer.note, m.footer.revisionLabel);
  return out.filter((s) => s && s.length > 0).join("\n");
}
