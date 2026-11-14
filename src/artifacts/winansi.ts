/**
 * WinAnsi (CP1252) sanitizer for pdf-lib StandardFonts. Standard fonts can only
 * encode CP1252, so every string drawn into a PDF passes through `toWinAnsi`.
 * Typographic punctuation is normalized to plain equivalents; characters with
 * no WinAnsi glyph (emoji, CJK, arrows…) become safe ASCII stand-ins or "?".
 * Em dash (—), en dash (–), × and • are kept: WinAnsi encodes them.
 */

const chars = (...codes: number[]) => codes.map((c) => String.fromCodePoint(c));
const REPLACEMENTS: Record<string, string> = Object.fromEntries([
  ...chars(0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x2039, 0x203a).map((c) => [c, "'"]),
  ...chars(0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb).map((c) => [c, '"']),
  [String.fromCodePoint(0x2026), "..."],
  ...chars(0x2010, 0x2011, 0x2012, 0x2043, 0x2212, 0x00ad).map((c) => [c, "-"]),
  [String.fromCodePoint(0x2015), "—"],
  ...([[0x2190, "<-"], [0x2192, "->"], [0x2194, "<->"], [0x21d2, "=>"], [0x21d0, "<="],
    [0x2264, "<="], [0x2265, ">="], [0x2260, "!="], [0x2248, "~"],
    [0x2023, "•"], [0x25cf, "•"], [0x25aa, "•"], [0x2219, "·"],
    [0x2713, "[x]"], [0x2714, "[x]"], [0x2717, "[ ]"], [0x2718, "[ ]"],
    [0x0141, "L"], [0x0142, "l"], [0x0110, "D"], [0x0111, "d"], [0x0131, "i"], [0x0126, "H"], [0x0127, "h"],
  ] as [number, string][]).map(([c, r]) => [String.fromCodePoint(c), r]),
  ...chars(0x00a0, 0x2002, 0x2003, 0x2007, 0x2009, 0x200a, 0x202f).map((c) => [c, " "]),
  ...chars(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xfe0e, 0xfe0f).map((c) => [c, ""]),
]);

/** CP1252 code points 0x80-0x9F mapped to Unicode (the ones that exist). */
const CP1252_EXTRAS = new Set(
  chars(0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
    0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178),
);

function isWinAnsi(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa1 && cp <= 0xff && cp !== 0xad) return true;
  return CP1252_EXTRAS.has(ch);
}

/** Sanitize a single-line string (newlines become spaces). */
export function toWinAnsi(input: unknown): string {
  return toWinAnsiMultiline(input).replace(/\n+/g, " ");
}

/** Sanitize, keeping "\n" line breaks. */
export function toWinAnsiMultiline(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = String(input).normalize("NFC").replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of s) {
    if (ch === "\n") { out += "\n"; continue; }
    if (ch === "\t") { out += "    "; continue; }
    const rep = REPLACEMENTS[ch];
    if (rep !== undefined) { out += rep; continue; }
    if (isWinAnsi(ch)) { out += ch; continue; }
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) { out += " "; continue; }
    // Accented letters outside CP1252: strip combining marks when that yields encodable text.
    const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (base.length > 0 && [...base].every(isWinAnsi)) { out += base; continue; }
    // Variation selectors / combining marks on their own: drop.
    if (/[̀-ͯ︀-️]/.test(ch)) continue;
    out += "?";
  }
  return out;
}
