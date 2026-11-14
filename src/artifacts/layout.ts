/**
 * Minimal flowing layout engine on top of pdf-lib (StandardFonts only, so it
 * runs in Workers). US Letter, header band on page 1, continuation header on
 * later pages, footer with "Page n of m" on every page, automatic page breaks.
 * Every string drawn goes through the WinAnsi sanitizer.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { toWinAnsi, toWinAnsiMultiline } from "./winansi";

export const APP_NAME = "Vexo Field Assistant";
export const FIXTURE_BANNER = "SYNTHETIC / FIXTURE DATA — not a real visit";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BAND_H = 118;

export const C = {
  ink: rgb(0.11, 0.13, 0.17),
  muted: rgb(0.40, 0.44, 0.50),
  faint: rgb(0.62, 0.66, 0.71),
  rule: rgb(0.85, 0.87, 0.90),
  band: rgb(0.09, 0.17, 0.31),
  bandText: rgb(0.76, 0.83, 0.93),
  accent: rgb(0.05, 0.52, 0.58),
  accentSoft: rgb(0.89, 0.96, 0.96),
  headerFill: rgb(0.94, 0.95, 0.97),
  zebra: rgb(0.98, 0.985, 0.99),
  white: rgb(1, 1, 1),
  amber: rgb(0.62, 0.36, 0.02),
  amberFill: rgb(1, 0.95, 0.80),
  amberBorder: rgb(0.85, 0.58, 0.10),
  green: rgb(0.08, 0.50, 0.28),
  greenSoft: rgb(0.90, 0.97, 0.92),
  red: rgb(0.70, 0.15, 0.15),
  redSoft: rgb(0.99, 0.92, 0.92),
  info: rgb(0.13, 0.33, 0.62),
  infoSoft: rgb(0.92, 0.95, 1),
};

export type Tone = "info" | "warning" | "success" | "danger" | "accent" | "neutral";
const TONES: Record<Tone, { fg: RGB; bg: RGB }> = {
  info: { fg: C.info, bg: C.infoSoft },
  warning: { fg: C.amber, bg: C.amberFill },
  success: { fg: C.green, bg: C.greenSoft },
  danger: { fg: C.red, bg: C.redSoft },
  accent: { fg: C.accent, bg: C.accentSoft },
  neutral: { fg: C.muted, bg: C.headerFill },
};

export interface Cell {
  text: string;
  color?: RGB;
  bold?: boolean;
  align?: "left" | "right";
}
export interface Column {
  header: string;
  /** Fraction of content width. */
  width: number;
  align?: "left" | "right";
}

export interface WriterOptions {
  title: string;
  /** Up to two short meta rows under the title in the header band. */
  metaRows: string[];
  fixture: boolean;
  fixtureDetail: string;
  footerLeft: string;
  metadata: { title: string; subject: string; keywords: string[]; date: Date };
}

type FontKey = "regular" | "bold" | "italic";

export class PdfWriter {
  private pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  private readonly bottom: number;
  private justHeaded = false;

  private constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Record<FontKey, PDFFont>,
    private readonly opts: WriterOptions,
  ) {
    this.bottom = opts.fixture ? 92 : 72;
    this.newPage();
  }

  static async create(opts: WriterOptions): Promise<PdfWriter> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const [regular, bold, italic] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
      doc.embedFont(StandardFonts.HelveticaOblique),
    ]);
    const m = opts.metadata;
    doc.setTitle(m.title, { showInWindowTitleBar: true });
    doc.setSubject(m.subject);
    doc.setKeywords(m.keywords);
    doc.setAuthor(APP_NAME);
    doc.setCreator(APP_NAME);
    doc.setProducer(`${APP_NAME} (pdf-lib)`);
    doc.setLanguage("en-US");
    doc.setCreationDate(m.date);
    doc.setModificationDate(m.date);
    return new PdfWriter(doc, { regular, bold, italic }, opts);
  }

  // ------------------------------------------------------------ text primitives
  private font(k: FontKey = "regular"): PDFFont {
    return this.fonts[k];
  }

  width(text: string, size: number, k: FontKey = "regular"): number {
    return this.font(k).widthOfTextAtSize(text, size);
  }

  /** Word-wrap sanitized text; splits over-long tokens by character. */
  wrap(raw: string, size: number, maxW: number, k: FontKey = "regular", firstW = maxW): string[] {
    const lines: string[] = [];
    for (const para of toWinAnsiMultiline(raw).split("\n")) {
      const words = para.split(/ +/).filter((w) => w.length > 0);
      let line = "";
      const limit = () => (lines.length === 0 ? firstW : maxW);
      if (words.length === 0) { lines.push(""); continue; }
      for (let word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.width(candidate, size, k) <= limit()) { line = candidate; continue; }
        if (line) { lines.push(line); line = ""; }
        while (this.width(word, size, k) > limit()) {
          let n = word.length - 1;
          while (n > 1 && this.width(word.slice(0, n), size, k) > limit()) n--;
          lines.push(word.slice(0, n));
          word = word.slice(n);
        }
        line = word;
      }
      lines.push(line);
    }
    return lines;
  }

  private fit(raw: string, size: number, maxW: number, k: FontKey = "regular"): string {
    const t = toWinAnsi(raw);
    if (this.width(t, size, k) <= maxW) return t;
    let n = t.length;
    while (n > 0 && this.width(`${t.slice(0, n)}...`, size, k) > maxW) n--;
    return `${t.slice(0, n)}...`;
  }

  private text(t: string, x: number, y: number, size: number, k: FontKey = "regular", color: RGB = C.ink, page = this.page) {
    page.drawText(toWinAnsi(t), { x, y, size, font: this.font(k), color });
  }

  // ------------------------------------------------------------ pages
  private newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    if (this.pages.length === 1) this.drawBand();
    else this.drawContinuationHeader();
  }

  private drawBand() {
    const p = this.page;
    p.drawRectangle({ x: 0, y: PAGE_H - BAND_H, width: PAGE_W, height: BAND_H, color: C.band });
    p.drawRectangle({ x: 0, y: PAGE_H - BAND_H - 3, width: PAGE_W, height: 3, color: C.accent });
    this.text(APP_NAME.toUpperCase(), MARGIN_X, PAGE_H - 34, 8.5, "bold", C.bandText);
    this.text(this.fit(this.opts.title, 22, CONTENT_W, "bold"), MARGIN_X, PAGE_H - 62, 22, "bold", C.white);
    this.opts.metaRows.slice(0, 2).forEach((row, i) => {
      this.text(this.fit(row, 9.5, CONTENT_W), MARGIN_X, PAGE_H - 84 - i * 14, 9.5, "regular", C.bandText);
    });
    this.y = PAGE_H - BAND_H - 3 - 22;
    if (this.opts.fixture) {
      const lines = this.wrap(this.opts.fixtureDetail, 8.5, CONTENT_W - 28);
      const h = 30 + lines.length * 11;
      p.drawRectangle({
        x: MARGIN_X, y: this.y - h, width: CONTENT_W, height: h,
        color: C.amberFill, borderColor: C.amberBorder, borderWidth: 1,
      });
      p.drawRectangle({ x: MARGIN_X, y: this.y - h, width: 4, height: h, color: C.amberBorder });
      this.text(FIXTURE_BANNER, MARGIN_X + 14, this.y - 17, 10.5, "bold", C.amber);
      lines.forEach((l, i) => this.text(l, MARGIN_X + 14, this.y - 31 - i * 11, 8.5, "regular", C.amber));
      this.y -= h + 18;
    }
  }

  private drawContinuationHeader() {
    const top = PAGE_H - 36;
    this.text(APP_NAME.toUpperCase(), MARGIN_X, top, 7.5, "bold", C.accent);
    const right = this.fit(`${this.opts.title} · ${this.opts.metaRows[0] ?? ""}`, 8, CONTENT_W * 0.65);
    this.text(right, PAGE_W - MARGIN_X - this.width(right, 8), top, 8, "regular", C.muted);
    this.page.drawLine({ start: { x: MARGIN_X, y: top - 8 }, end: { x: PAGE_W - MARGIN_X, y: top - 8 }, thickness: 0.6, color: C.rule });
    this.y = top - 30;
  }

  /** Ensure `h` points of vertical space remain, else break the page. */
  ensure(h: number) {
    this.justHeaded = false;
    if (this.y - h < this.bottom) this.newPage();
  }

  space(h: number) {
    this.y -= h;
  }

  // ------------------------------------------------------------ blocks
  heading(title: string, aside?: string) {
    this.ensure(46);
    this.y -= 8;
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - 2, width: 3, height: 13, color: C.accent });
    this.text(this.fit(title, 12.5, CONTENT_W * 0.7, "bold"), MARGIN_X + 10, this.y, 12.5, "bold", C.band);
    if (aside) {
      const a = this.fit(aside, 8, CONTENT_W * 0.3, "italic");
      this.text(a, PAGE_W - MARGIN_X - this.width(a, 8, "italic"), this.y + 1, 8, "italic", C.muted);
    }
    this.y -= 9;
    this.page.drawLine({ start: { x: MARGIN_X, y: this.y }, end: { x: PAGE_W - MARGIN_X, y: this.y }, thickness: 0.6, color: C.rule });
    this.y -= 15;
    this.justHeaded = true;
  }

  paragraph(t: string, o: { size?: number; font?: FontKey; color?: RGB; indent?: number; gap?: number } = {}) {
    const size = o.size ?? 10;
    const lh = size * 1.4;
    const x = MARGIN_X + (o.indent ?? 0);
    for (const line of this.wrap(t, size, CONTENT_W - (o.indent ?? 0), o.font)) {
      this.ensure(lh);
      this.text(line, x, this.y, size, o.font, o.color ?? C.ink);
      this.y -= lh;
    }
    this.y -= o.gap ?? 4;
  }

  private pill(label: string, x: number, baseline: number, tone: Tone): number {
    const t = toWinAnsi(label);
    const size = 7;
    const w = this.width(t, size, "bold") + 10;
    const { fg, bg } = TONES[tone];
    this.page.drawRectangle({ x, y: baseline - 3, width: w, height: 11.5, color: bg, borderColor: fg, borderWidth: 0.5, borderOpacity: 0.5 });
    this.text(t, x + 5, baseline, size, "bold", fg);
    return w;
  }

  bullet(t: string, o: { tag?: { label: string; tone: Tone }; font?: FontKey; color?: RGB } = {}) {
    const size = 10;
    const lh = 14;
    const indent = 16;
    const textW = CONTENT_W - indent;
    const tagW = o.tag ? this.width(toWinAnsi(o.tag.label), 7, "bold") + 16 : 0;
    const lines = this.wrap(t, size, textW, o.font, textW - tagW);
    this.ensure(lh * Math.min(lines.length, 2));
    lines.forEach((line, i) => {
      this.ensure(lh);
      let x = MARGIN_X + indent;
      if (i === 0) {
        this.page.drawCircle({ x: MARGIN_X + 5, y: this.y + 3.3, size: 1.9, color: C.accent });
        if (o.tag) x += this.pill(o.tag.label, x, this.y + 0.5, o.tag.tone) + 6;
      }
      this.text(line, x, this.y, size, o.font, o.color ?? C.ink);
      this.y -= lh;
    });
    this.y -= 3;
  }

  callout(title: string, body: string | null, tone: Tone) {
    const { fg, bg } = TONES[tone];
    const lines = body ? this.wrap(body, 9, CONTENT_W - 28) : [];
    const h = 26 + lines.length * 12 + (lines.length ? 2 : 0);
    this.ensure(h + 8);
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - h + 12, width: CONTENT_W, height: h, color: bg });
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - h + 12, width: 3, height: h, color: fg });
    this.text(this.fit(title, 10, CONTENT_W - 28, "bold"), MARGIN_X + 14, this.y - 4, 10, "bold", fg);
    lines.forEach((l, i) => this.text(l, MARGIN_X + 14, this.y - 18 - i * 12, 9, "regular", C.ink));
    this.y -= h + 10;
  }

  /** Two-column label/value list. */
  keyValues(rows: [string, string | Cell][], labelFrac = 0.32) {
    this.table(
      [
        { header: "", width: labelFrac },
        { header: "", width: 1 - labelFrac },
      ],
      rows.map(([k, v]) => [{ text: k, color: C.muted, bold: true }, typeof v === "string" ? { text: v } : v]),
      { header: false, zebra: false, size: 9.5, padY: 4 },
    );
  }

  table(cols: Column[], rows: (string | Cell)[][], o: { header?: boolean; zebra?: boolean; size?: number; padY?: number } = {}) {
    if (this.justHeaded) this.y += 9;
    this.justHeaded = false;
    const size = o.size ?? 9;
    const lh = size * 1.38;
    const padX = 6;
    const padY = o.padY ?? 5;
    const showHeader = o.header ?? true;
    const widths = cols.map((c) => c.width * CONTENT_W);
    const maxRowH = PAGE_H - 140 - this.bottom;

    const drawHeader = () => {
      if (!showHeader) return;
      const h = size + padY * 2 + 2;
      this.ensure(h + lh + padY * 2);
      this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: CONTENT_W, height: h, color: C.headerFill });
      let x = MARGIN_X;
      cols.forEach((c, i) => {
        const w = widths[i] ?? 0;
        const label = this.fit(c.header.toUpperCase(), size - 1.5, w - padX * 2, "bold");
        const tx = c.align === "right" ? x + w - padX - this.width(label, size - 1.5, "bold") : x + padX;
        this.text(label, tx, this.y - h + padY + 2, size - 1.5, "bold", C.muted);
        x += w;
      });
      this.y -= h;
    };

    drawHeader();
    rows.forEach((row, r) => {
      const cells = row.map((c) => (typeof c === "string" ? { text: c } : c));
      const wrapped = cells.map((c, i) => this.wrap(c.text, size, (widths[i] ?? 0) - padX * 2, c.bold ? "bold" : "regular"));
      let lines = Math.max(1, ...wrapped.map((w) => w.length));
      let h = lines * lh + padY * 2;
      if (h > maxRowH) {
        // Pathological cell: clamp to one page and mark truncation.
        lines = Math.floor((maxRowH - padY * 2) / lh);
        h = lines * lh + padY * 2;
        wrapped.forEach((w, i) => {
          if (w.length > lines) wrapped[i] = [...w.slice(0, lines - 1), "[continued — truncated for print]"];
        });
      }
      if (this.y - h < this.bottom) {
        this.newPage();
        drawHeader();
      }
      if ((o.zebra ?? true) && r % 2 === 1) {
        this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: CONTENT_W, height: h, color: C.zebra });
      }
      let x = MARGIN_X;
      cells.forEach((c, i) => {
        const w = widths[i] ?? 0;
        const align = c.align ?? cols[i]?.align ?? "left";
        const k: FontKey = c.bold ? "bold" : "regular";
        (wrapped[i] ?? []).forEach((line, li) => {
          const tx = align === "right" ? x + w - padX - this.width(line, size, k) : x + padX;
          this.text(line, tx, this.y - padY - size - li * lh + 1.5, size, k, c.color ?? C.ink);
        });
        x += w;
      });
      this.y -= h;
      this.page.drawLine({ start: { x: MARGIN_X, y: this.y }, end: { x: PAGE_W - MARGIN_X, y: this.y }, thickness: 0.5, color: C.rule });
    });
    this.y -= 12;
  }

  /** Right-aligned totals row block (label: value). */
  totals(rows: { label: string; value: string; strong?: boolean }[]) {
    const w = CONTENT_W * 0.45;
    const x0 = PAGE_W - MARGIN_X - w;
    this.ensure(rows.length * 22 + 10);
    for (const r of rows) {
      const size = r.strong ? 12 : 9.5;
      const k: FontKey = r.strong ? "bold" : "regular";
      if (r.strong) {
        this.page.drawRectangle({ x: x0, y: this.y - 8, width: w, height: 24, color: C.accentSoft });
      }
      this.text(r.label, x0 + 8, this.y, size, k, r.strong ? C.band : C.muted);
      const v = toWinAnsi(r.value);
      this.text(v, PAGE_W - MARGIN_X - 8 - this.width(v, size, k), this.y, size, k, r.strong ? C.band : C.ink);
      this.y -= r.strong ? 28 : 18;
    }
    this.y -= 6;
  }

  /** Side-by-side "bill to" style block: left label + lines, right key/values. */
  parties(left: { label: string; lines: string[] }, right: [string, string][]) {
    const h = Math.max(24 + left.lines.length * 14, right.length * 15 + 6);
    this.ensure(h + 10);
    const top = this.y;
    this.text(left.label.toUpperCase(), MARGIN_X, top, 7.5, "bold", C.accent);
    left.lines.forEach((l, i) =>
      this.text(this.fit(l, i === 0 ? 13 : 9.5, CONTENT_W * 0.45, i === 0 ? "bold" : "regular"), MARGIN_X, top - 18 - i * 14, i === 0 ? 13 : 9.5, i === 0 ? "bold" : "regular", i === 0 ? C.ink : C.muted),
    );
    const rx = MARGIN_X + CONTENT_W * 0.5;
    const rw = CONTENT_W * 0.5;
    right.forEach(([k, v], i) => {
      const yy = top - i * 15;
      this.text(k, rx, yy, 9, "regular", C.muted);
      const vv = this.fit(v, 9, rw * 0.6, "bold");
      this.text(vv, rx + rw - this.width(vv, 9, "bold"), yy, 9, "bold", C.ink);
    });
    this.y = top - h - 12;
  }

  // ------------------------------------------------------------ finish
  async finish(): Promise<Uint8Array> {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const lineY = 46;
      if (this.opts.fixture) {
        p.drawRectangle({ x: MARGIN_X, y: lineY + 8, width: CONTENT_W, height: 16, color: C.amberFill, borderColor: C.amberBorder, borderWidth: 0.6 });
        const b = toWinAnsi(FIXTURE_BANNER);
        this.text(b, PAGE_W / 2 - this.width(b, 8, "bold") / 2, lineY + 13, 8, "bold", C.amber, p);
      }
      p.drawLine({ start: { x: MARGIN_X, y: lineY }, end: { x: PAGE_W - MARGIN_X, y: lineY }, thickness: 0.6, color: C.rule });
      const left = this.fit(this.opts.footerLeft, 7.5, CONTENT_W * 0.75);
      this.text(left, MARGIN_X, lineY - 13, 7.5, "regular", C.muted, p);
      const right = `Page ${i + 1} of ${total}`;
      this.text(right, PAGE_W - MARGIN_X - this.width(right, 7.5, "bold"), lineY - 13, 7.5, "bold", C.muted, p);
    });
    return this.doc.save({ useObjectStreams: false });
  }
}
