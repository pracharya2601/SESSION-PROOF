/** renderDocModelPdf: any DocModel → PDF bytes via the shared pdf-lib layout engine. Deterministic. */
import type { DocBlock, DocModel } from "../contracts/v3";
import { C, PdfWriter, hexToRgb, type Column, type Tone } from "../artifacts/layout";
import { toWinAnsi } from "../artifacts/winansi";

const TAG_TONE: Record<string, Tone> = {
  "Provider attestation": "accent",
  "Provider-confirmed (not evidence)": "accent",
  "Provider-written (not evidence)": "accent",
  Refused: "danger",
  Removed: "neutral",
  Pass: "neutral",
  Warn: "warning",
  Fail: "danger",
  Blocking: "danger",
  Advisory: "warning",
  Notice: "neutral",
};

const CALLOUT_TONE: Record<"info" | "warning" | "fixture" | "draft", Tone> = {
  info: "info",
  warning: "warning",
  fixture: "warning",
  draft: "danger",
};

/** Meta items as short display strings; the writer packs them into rows that fit the band. */
function metaParts(meta: { label: string; value: string }[]): string[] {
  return meta.map((m) => (m.label === "Client" ? `Client ${m.value}` : m.label === "Time" || m.label === "Service date" ? m.value : `${m.label} ${m.value}`));
}

function normWidths(cols: { width?: number }[]): number[] {
  const given = cols.map((c) => (typeof c.width === "number" && c.width > 0 ? c.width : 0));
  const missing = given.filter((w) => w === 0).length;
  const sumGiven = given.reduce((a, b) => a + b, 0);
  const fill = missing ? Math.max(0, 1 - Math.min(sumGiven, 1)) / missing || 1 / cols.length : 0;
  const raw = given.map((w) => (w === 0 ? fill : w));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((w) => w / sum);
}

function drawBlock(w: PdfWriter, block: DocBlock) {
  switch (block.type) {
    case "heading":
      w.heading(block.text);
      return;
    case "paragraph":
      if (block.tone === "muted") w.paragraph(block.text, { size: 8.5, font: "italic", color: C.muted });
      else if (block.tone === "notice") w.paragraph(block.text, { size: 9.5, font: "italic", color: C.info });
      else w.paragraph(block.text, { size: 9.5 });
      return;
    case "list":
      if (block.items.length === 0) return;
      for (const it of block.items) {
        const notice = it.tag === "Notice";
        w.bullet(it.text, {
          tag: it.tag && !notice ? { label: it.tag, tone: TAG_TONE[it.tag] ?? "neutral" } : undefined,
          font: notice ? "italic" : "regular",
          color: notice ? C.muted : C.ink,
          refs: it.refs,
        });
      }
      return;
    case "kv":
      if (block.items.length === 0) return;
      w.keyValues(block.items.map((i) => [i.label, i.value]), 0.34, block.columns ?? 1);
      return;
    case "table": {
      if (block.columns.length === 0) return;
      const widths = normWidths(block.columns);
      const cols: Column[] = block.columns.map((c, i) => ({ header: c.label, width: widths[i] ?? 0, align: c.align }));
      const kinds = block.rowKinds;
      const rows = block.rows.map((r, ri) =>
        block.columns.map((_, i) => {
          const text = r[i] ?? "";
          if (!kinds) return text;
          if (kinds[ri] === "sub") return { text: i === 2 && text ? `-  ${text}` : text, color: i === 2 ? C.muted : C.ink };
          return { text, bold: i === 2 };
        }),
      );
      w.table(cols, rows, { size: kinds ? 9 : 9.5, ...(kinds ? { rowKinds: kinds } : {}) });
      return;
    }
    case "parties":
      w.parties(block.parties);
      return;
    case "pagebreak":
      w.pageBreak();
      return;
    case "totals":
      w.totals(block.rows);
      return;
    case "callout": {
      const [title = "", ...rest] = block.text.split("\n");
      w.callout(title, rest.join("\n").trim() || null, CALLOUT_TONE[block.tone] ?? "info");
      return;
    }
    case "signatures":
      w.signatures(block.statement, block.lines);
      return;
    case "divider":
      w.divider();
      return;
  }
}

export async function renderDocModelPdf(model: DocModel): Promise<Uint8Array> {
  const meta = model.header.meta;
  const find = (label: string) => meta.find((m) => m.label === label)?.value;
  const client = find("Client") ?? find("Participant");
  const titleParts = [model.title, find("Invoice #"), client, find("Service date"), find("Revision")].filter((x): x is string => !!x && x !== "Assigned at approval");
  const footerLeft = [model.footer.note, model.footer.revisionLabel].filter((x) => x && x.trim()).join("  ·  ");
  const w = await PdfWriter.create({
    title: model.title,
    logoText: model.header.logoText,
    headerNote: model.header.headerNote,
    metaRows: metaParts(meta),
    banner: model.banner,
    footerLeft,
    letterhead: model.letterhead
      ? {
          name: model.letterhead.name,
          lines: model.letterhead.lines,
          logoDataUrl: model.letterhead.logoDataUrl,
          meta: model.letterhead.meta.map((m) => [m.label, m.value] as [string, string]),
          incomplete: model.letterhead.incomplete,
        }
      : null,
    watermark: model.watermark ?? null,
    metadata: {
      title: titleParts.join(" — "),
      subject: `${model.title}${client ? ` for client ${client}` : ""} (${model.footer.revisionLabel})`,
      keywords: [model.title, model.kind, ...(client ? [client] : []), toWinAnsi(model.filename)],
    },
    theme: {
      accent: hexToRgb(model.theme.accentColor),
      fontFamily: model.theme.fontFamily,
      paper: model.theme.paper,
      density: model.theme.density,
    },
  });
  for (const block of model.blocks) drawBlock(w, block);
  return w.finish();
}
