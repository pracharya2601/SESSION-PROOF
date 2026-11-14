/**
 * Minimal flowing layout engine on top of pdf-lib (StandardFonts only, so it
 * runs in Workers). Themeable (accent color, font family, paper, density):
 * header band on page 1, continuation header on later pages, footer with
 * "Page n of m" on every page, automatic page breaks, table headers repeated
 * after page breaks. Every string drawn goes through the WinAnsi sanitizer.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { toWinAnsi, toWinAnsiMultiline } from "./winansi";

export const APP_NAME = "Vexo Field Assistant";
export const FIXTURE_BANNER = "SYNTHETIC / FIXTURE DATA — not a real visit";
export const DRAFT_BANNER = "DRAFT — not approved";

export const PAPER_SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;
const MARGIN_X = 54;

export const C = {
  ink: rgb(0.11, 0.13, 0.17),
  muted: rgb(0.40, 0.44, 0.50),
  faint: rgb(0.62, 0.66, 0.71),
  rule: rgb(0.85, 0.87, 0.90),
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

/** "#RRGGBB" → RGB; invalid input falls back to the default indigo. */
export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const n = m ? parseInt(m[1] ?? "4338CA", 16) : 0x4338ca;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return rgb(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t);
}

export type Tone = "info" | "warning" | "success" | "danger" | "accent" | "neutral";

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

export type FontFamily = "sans" | "serif" | "mono";
export interface WriterTheme {
  accent: RGB;
  fontFamily: FontFamily;
  paper: keyof typeof PAPER_SIZES;
  density: "comfortable" | "compact";
}

export interface WriterOptions {
  title: string;
  /** Small caps label at the top of the band; empty = none. */
  logoText: string;
  /** Short note at the top right of the band; empty = none. */
  headerNote: string;
  /** Meta items ("Client C-104", …) packed into at most three rows under the title. */
  metaRows: string[];
  /** Strip drawn in every page footer (fixture / draft); null = none. */
  banner: string | null;
  footerLeft: string;
  metadata: { title: string; subject: string; keywords: string[]; date?: Date };
  theme?: Partial<WriterTheme>;
}

type FontKey = "regular" | "bold" | "italic";

const FONT_SETS: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique],
};

export class PdfWriter {
  private pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  private readonly bottom: number;
  private justHeaded = false;
  private readonly pageW: number;
  private readonly pageH: number;
  private readonly contentW: number;
  /** Vertical spacing scale (compact < 1). */
  private readonly k: number;
  private readonly pal: { band: RGB; bandText: RGB; accent: RGB; accentSoft: RGB };
  private readonly tones: Record<Tone, { fg: RGB; bg: RGB }>;

  private constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Record<FontKey, PDFFont>,
    private readonly opts: WriterOptions,
    theme: WriterTheme,
  ) {
    const [w, h] = PAPER_SIZES[theme.paper];
    this.pageW = w;
    this.pageH = h;
    this.contentW = w - MARGIN_X * 2;
    this.k = theme.density === "compact" ? 0.8 : 1;
    const a = theme.accent;
    this.pal = {
      accent: a,
      band: mix(a, rgb(0, 0, 0), 0.55),
      bandText: mix(a, rgb(1, 1, 1), 0.78),
      accentSoft: mix(a, rgb(1, 1, 1), 0.9),
    };
    this.tones = {
      info: { fg: C.info, bg: C.infoSoft },
      warning: { fg: C.amber, bg: C.amberFill },
      success: { fg: C.green, bg: C.greenSoft },
      danger: { fg: C.red, bg: C.redSoft },
      accent: { fg: this.pal.accent, bg: this.pal.accentSoft },
      neutral: { fg: C.muted, bg: C.headerFill },
    };
    this.bottom = opts.banner ? 92 : 72;
    this.newPage();
  }

  static async create(opts: WriterOptions): Promise<PdfWriter> {
    const theme: WriterTheme = {
      accent: opts.theme?.accent ?? hexToRgb("#4338CA"),
      fontFamily: opts.theme?.fontFamily ?? "sans",
      paper: opts.theme?.paper ?? "letter",
      density: opts.theme?.density ?? "comfortable",
    };
    const doc = await PDFDocument.create({ updateMetadata: false });
    const [r, b, i] = FONT_SETS[theme.fontFamily];
    const [regular, bold, italic] = await Promise.all([doc.embedFont(r), doc.embedFont(b), doc.embedFont(i)]);
    const m = opts.metadata;
    doc.setTitle(toWinAnsi(m.title), { showInWindowTitleBar: true });
    doc.setSubject(toWinAnsi(m.subject));
    doc.setKeywords(m.keywords.map((x) => toWinAnsi(x)));
    doc.setAuthor(APP_NAME);
    doc.setCreator(APP_NAME);
    doc.setProducer(`${APP_NAME} (pdf-lib)`);
    doc.setLanguage("en-US");
    if (m.date) {
      doc.setCreationDate(m.date);
      doc.setModificationDate(m.date);
    }
    return new PdfWriter(doc, { regular, bold, italic }, opts, theme);
  }

  /** Scaled vertical spacing. */
  private sp(n: number): number {
    return n * this.k;
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

  private rule(y: number, x0 = MARGIN_X, x1 = this.pageW - MARGIN_X, thickness = 0.6, color: RGB = C.rule) {
    this.page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color });
  }

  // ------------------------------------------------------------ pages
  private newPage() {
    this.page = this.doc.addPage([this.pageW, this.pageH]);
    this.pages.push(this.page);
    if (this.pages.length === 1) this.drawBand();
    else this.drawContinuationHeader();
  }

  private drawBand() {
    const p = this.page;
    const H = this.pageH;
    const rows = this.packMeta(this.opts.metaRows, 9.5, this.contentW);
    const bandH = Math.round(this.sp(88) + rows.length * 14);
    p.drawRectangle({ x: 0, y: H - bandH, width: this.pageW, height: bandH, color: this.pal.band });
    p.drawRectangle({ x: 0, y: H - bandH - 3, width: this.pageW, height: 3, color: this.pal.accent });
    const top = H - this.sp(34);
    if (this.opts.logoText) {
      this.text(this.fit(this.opts.logoText.toUpperCase(), 8.5, this.contentW * 0.5, "bold"), MARGIN_X, top, 8.5, "bold", this.pal.bandText);
    }
    if (this.opts.headerNote) {
      const note = this.fit(this.opts.headerNote, 8, this.contentW * 0.45);
      this.text(note, this.pageW - MARGIN_X - this.width(note, 8), top, 8, "regular", this.pal.bandText);
    }
    const titleY = top - this.sp(28);
    this.text(this.fit(this.opts.title, 22, this.contentW, "bold"), MARGIN_X, titleY, 22, "bold", C.white);
    rows.forEach((row, i) => {
      this.text(this.fit(row, 9.5, this.contentW), MARGIN_X, titleY - 22 - i * 14, 9.5, "regular", this.pal.bandText);
    });
    this.y = H - bandH - 3 - this.sp(22);
  }

  private packMeta(parts: string[], size: number, maxW: number): string[] {
    const sep = "   |   ";
    const rows: string[] = [];
    let cur = "";
    for (const p of parts.map((x) => toWinAnsi(x)).filter((x) => x.length > 0)) {
      const next = cur ? `${cur}${sep}${p}` : p;
      if (cur && this.width(next, size) > maxW) {
        rows.push(cur);
        cur = p;
      } else cur = next;
    }
    if (cur) rows.push(cur);
    if (rows.length > 3) rows.splice(2, rows.length - 2, rows.slice(2).join(sep));
    return rows;
  }

  private drawContinuationHeader() {
    const top = this.pageH - 36;
    if (this.opts.logoText) {
      this.text(this.fit(this.opts.logoText.toUpperCase(), 7.5, this.contentW * 0.3, "bold"), MARGIN_X, top, 7.5, "bold", this.pal.accent);
    }
    const right = this.fit([this.opts.title, ...this.opts.metaRows.slice(0, 2)].join(" · "), 8, this.contentW * 0.65);
    this.text(right, this.pageW - MARGIN_X - this.width(right, 8), top, 8, "regular", C.muted);
    this.rule(top - 8);
    this.y = top - 30;
  }

  /** Ensure `h` points of vertical space remain, else break the page. */
  ensure(h: number) {
    this.justHeaded = false;
    if (this.y - h < this.bottom) this.newPage();
  }

  space(h: number) {
    this.y -= this.sp(h);
  }

  // ------------------------------------------------------------ blocks
  heading(title: string, aside?: string) {
    // Keep the heading with at least a few lines of its section.
    this.ensure(96);
    this.y -= this.sp(8);
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - 2, width: 3, height: 13, color: this.pal.accent });
    this.text(this.fit(title, 12.5, this.contentW * (aside ? 0.7 : 0.96), "bold"), MARGIN_X + 10, this.y, 12.5, "bold", this.pal.band);
    if (aside) {
      const a = this.fit(aside, 8, this.contentW * 0.3, "italic");
      this.text(a, this.pageW - MARGIN_X - this.width(a, 8, "italic"), this.y + 1, 8, "italic", C.muted);
    }
    this.y -= 9;
    this.rule(this.y);
    this.y -= this.sp(15);
    this.justHeaded = true;
  }

  paragraph(t: string, o: { size?: number; font?: FontKey; color?: RGB; indent?: number; gap?: number } = {}) {
    const size = o.size ?? 10;
    const lh = size * (this.k < 1 ? 1.3 : 1.4);
    const x = MARGIN_X + (o.indent ?? 0);
    for (const line of this.wrap(t, size, this.contentW - (o.indent ?? 0), o.font)) {
      this.ensure(lh);
      this.text(line, x, this.y, size, o.font, o.color ?? C.ink);
      this.y -= lh;
    }
    this.y -= this.sp(o.gap ?? 4);
  }

  private pill(label: string, x: number, baseline: number, tone: Tone): number {
    const t = toWinAnsi(label);
    const size = 7;
    const w = this.width(t, size, "bold") + 10;
    const { fg, bg } = this.tones[tone];
    this.page.drawRectangle({ x, y: baseline - 3, width: w, height: 11.5, color: bg, borderColor: fg, borderWidth: 0.5, borderOpacity: 0.5 });
    this.text(t, x + 5, baseline, size, "bold", fg);
    return w;
  }

  bullet(t: string, o: { tag?: { label: string; tone: Tone }; font?: FontKey; color?: RGB } = {}) {
    const size = 10;
    const lh = this.sp(14);
    const indent = 16;
    const textW = this.contentW - indent;
    const tagW = o.tag ? this.width(toWinAnsi(o.tag.label), 7, "bold") + 16 : 0;
    const lines = this.wrap(t, size, textW, o.font, textW - tagW);
    this.ensure(lh * Math.min(lines.length, 2));
    lines.forEach((line, i) => {
      this.ensure(lh);
      let x = MARGIN_X + indent;
      if (i === 0) {
        this.page.drawCircle({ x: MARGIN_X + 5, y: this.y + 3.3, size: 1.9, color: this.pal.accent });
        if (o.tag) x += this.pill(o.tag.label, x, this.y + 0.5, o.tag.tone) + 6;
      }
      this.text(line, x, this.y, size, o.font, o.color ?? C.ink);
      this.y -= lh;
    });
    this.y -= this.sp(3);
  }

  callout(title: string, body: string | null, tone: Tone) {
    const { fg, bg } = this.tones[tone];
    const titleLines = this.wrap(title, 10, this.contentW - 28, "bold");
    const lines = body ? this.wrap(body, 9, this.contentW - 28) : [];
    const h = 14 + titleLines.length * 13 + lines.length * 12 + (lines.length ? 2 : 0);
    this.ensure(h + 8);
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - h + 12, width: this.contentW, height: h, color: bg });
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - h + 12, width: 3, height: h, color: fg });
    titleLines.forEach((l, i) => this.text(l, MARGIN_X + 14, this.y - 4 - i * 13, 10, "bold", fg));
    const bodyTop = this.y - 4 - titleLines.length * 13 - 1;
    lines.forEach((l, i) => this.text(l, MARGIN_X + 14, bodyTop - i * 12, 9, "regular", C.ink));
    this.y -= h + this.sp(10);
  }

  /** Label/value list; `columns: 2` lays out two pairs per row. */
  keyValues(rows: [string, string | Cell][], labelFrac = 0.32, columns: 1 | 2 = 1) {
    const label = (k: string): Cell => ({ text: k, color: C.muted, bold: true });
    const val = (v: string | Cell): Cell => (typeof v === "string" ? { text: v } : v);
    if (columns === 2) {
      const out: Cell[][] = [];
      for (let i = 0; i < rows.length; i += 2) {
        const a = rows[i];
        const b = rows[i + 1];
        if (!a) continue;
        out.push([label(a[0]), val(a[1]), b ? label(b[0]) : { text: "" }, b ? val(b[1]) : { text: "" }]);
      }
      this.table(
        [{ header: "", width: 0.21 }, { header: "", width: 0.29 }, { header: "", width: 0.21 }, { header: "", width: 0.29 }],
        out,
        { header: false, zebra: false, size: 9.5, padY: 4 },
      );
      return;
    }
    this.table(
      [{ header: "", width: labelFrac }, { header: "", width: 1 - labelFrac }],
      rows.map(([k, v]) => [label(k), val(v)]),
      { header: false, zebra: false, size: 9.5, padY: 4 },
    );
  }

  table(cols: Column[], rows: (string | Cell)[][], o: { header?: boolean; zebra?: boolean; size?: number; padY?: number } = {}) {
    if (this.justHeaded) this.y += this.sp(9);
    this.justHeaded = false;
    const size = o.size ?? 9;
    const lh = size * (this.k < 1 ? 1.28 : 1.38);
    const padX = 6;
    const padY = this.sp(o.padY ?? 5);
    const showHeader = o.header ?? true;
    const widths = cols.map((c) => c.width * this.contentW);
    const maxRowH = this.pageH - 140 - this.bottom;

    const drawHeader = () => {
      if (!showHeader) return;
      const h = size + padY * 2 + 2;
      this.ensure(h + lh + padY * 2);
      this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: this.contentW, height: h, color: C.headerFill });
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
        this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: this.contentW, height: h, color: C.zebra });
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
      this.rule(this.y, MARGIN_X, this.pageW - MARGIN_X, 0.5);
    });
    this.y -= this.sp(12);
  }

  /** Right-aligned totals row block (label: value). */
  totals(rows: { label: string; value: string; strong?: boolean }[]) {
    const w = this.contentW * 0.45;
    const x0 = this.pageW - MARGIN_X - w;
    this.ensure(rows.length * 22 + 10);
    for (const r of rows) {
      const size = r.strong ? 12 : 9.5;
      const k: FontKey = r.strong ? "bold" : "regular";
      if (r.strong) {
        this.page.drawRectangle({ x: x0, y: this.y - 8, width: w, height: 24, color: this.pal.accentSoft });
      }
      const v = toWinAnsi(r.value);
      const vw = this.width(v, size, k);
      this.text(this.fit(r.label, size, w - vw - 24, k), x0 + 8, this.y, size, k, r.strong ? this.pal.band : C.muted);
      this.text(v, this.pageW - MARGIN_X - 8 - vw, this.y, size, k, r.strong ? this.pal.band : C.ink);
      this.y -= r.strong ? 28 : 18;
    }
    this.y -= this.sp(6);
  }

  /** Signature lines (two per row): a signature rule + a date rule, label (and name) underneath. */
  signatures(statement: string | null, lines: { label: string; name?: string | null }[]) {
    if (statement) this.paragraph(statement, { size: 9.5, gap: 6 });
    const gutter = 24;
    const colW = (this.contentW - gutter) / 2;
    for (let i = 0; i < lines.length; i += 2) {
      const row = lines.slice(i, i + 2);
      const rowH = this.sp(36) + 26;
      this.ensure(rowH);
      this.y -= this.sp(36);
      row.forEach((l, j) => {
        const x0 = MARGIN_X + j * (colW + gutter);
        const sigEnd = x0 + colW * 0.68;
        const dateStart = x0 + colW * 0.74;
        this.rule(this.y, x0, sigEnd, 0.8, C.ink);
        this.rule(this.y, dateStart, x0 + colW, 0.8, C.ink);
        this.text(this.fit(l.label, 8.5, sigEnd - x0, "bold"), x0, this.y - 11, 8.5, "bold", C.muted);
        this.text("Date", dateStart, this.y - 11, 8.5, "bold", C.muted);
        if (l.name) this.text(this.fit(l.name, 8.5, sigEnd - x0), x0, this.y - 22, 8.5, "regular", C.ink);
      });
      this.y -= 26;
    }
    this.y -= this.sp(18);
  }

  divider() {
    this.ensure(14);
    this.y -= this.sp(4);
    this.rule(this.y);
    this.y -= this.sp(10);
  }

  // ------------------------------------------------------------ finish
  async finish(): Promise<Uint8Array> {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const lineY = 46;
      if (this.opts.banner) {
        p.drawRectangle({ x: MARGIN_X, y: lineY + 8, width: this.contentW, height: 16, color: C.amberFill, borderColor: C.amberBorder, borderWidth: 0.6 });
        const b = this.fit(this.opts.banner, 8, this.contentW - 12, "bold");
        this.text(b, this.pageW / 2 - this.width(b, 8, "bold") / 2, lineY + 13, 8, "bold", C.amber, p);
      }
      p.drawLine({ start: { x: MARGIN_X, y: lineY }, end: { x: this.pageW - MARGIN_X, y: lineY }, thickness: 0.6, color: C.rule });
      const left = this.fit(this.opts.footerLeft, 7.5, this.contentW * 0.75);
      this.text(left, MARGIN_X, lineY - 13, 7.5, "regular", C.muted, p);
      const right = `Page ${i + 1} of ${total}`;
      this.text(right, this.pageW - MARGIN_X - this.width(right, 7.5, "bold"), lineY - 13, 7.5, "bold", C.muted, p);
    });
    return this.doc.save({ useObjectStreams: false });
  }
}
