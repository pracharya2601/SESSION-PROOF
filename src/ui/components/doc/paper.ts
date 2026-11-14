import type { TemplateTheme } from "../../../contracts";

/** CSS px per inch (CSS physical units are fixed at 96px/in). */
const PX_PER_IN = 96;
const PX_PER_MM = PX_PER_IN / 25.4;

export interface PaperSpec {
  /** CSS width/height in physical units, used on the page element. */
  cssW: string;
  cssH: string;
  /** Same size in CSS px (used for scaling math). */
  w: number;
  h: number;
  /** For @page { size } when printing. */
  pageSize: string;
}

export const PAPER: Record<TemplateTheme["paper"], PaperSpec> = {
  letter: { cssW: "8.5in", cssH: "11in", w: 8.5 * PX_PER_IN, h: 11 * PX_PER_IN, pageSize: "letter" },
  a4: { cssW: "210mm", cssH: "297mm", w: 210 * PX_PER_MM, h: 297 * PX_PER_MM, pageSize: "A4" },
};

export const FONT_STACKS: Record<TemplateTheme["fontFamily"], string> = {
  sans: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: '"JetBrains Mono", "Courier New", Courier, monospace',
};

export function paperOf(theme: TemplateTheme | undefined): PaperSpec {
  return PAPER[theme?.paper ?? "letter"] ?? PAPER.letter;
}
