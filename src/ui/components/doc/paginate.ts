import type { Fragment } from "./DocBlocks";

export interface BlockMeasure {
  /** Full height incl. trailing gap. */
  h: number;
  /** Splittable blocks: height of everything except the parts (gap, thead, borders, padding). */
  base: number;
  /** Splittable blocks: per-row / per-item heights. */
  parts: number[] | null;
  heading: boolean;
}

export interface Measure {
  /** Body height available on the first page and on continuation pages. */
  first: number;
  rest: number;
  blocks: BlockMeasure[];
}

const EPS = 0.75;

/**
 * Greedy pagination: whole blocks move to the next page; tables/lists split by
 * rows/items (tables repeat their header because `base` includes the thead);
 * headings are kept with the start of the following block.
 */
export function paginate(m: Measure): Fragment[][] {
  const pages: Fragment[][] = [[]];
  let rem = m.first;
  const cur = () => pages[pages.length - 1]!;
  const newPage = () => {
    pages.push([]);
    rem = m.rest;
  };

  for (let i = 0; i < m.blocks.length; i++) {
    const b = m.blocks[i]!;
    if (b.heading) {
      const nb = m.blocks[i + 1];
      const nextMin = nb ? (nb.parts && nb.parts.length ? nb.base + nb.parts[0]! : Math.min(nb.h, m.rest * 0.5)) : 0;
      if (b.h + nextMin > rem + EPS && cur().length) newPage();
      cur().push({ i });
      rem -= b.h;
      continue;
    }
    if (b.h <= rem + EPS) {
      cur().push({ i });
      rem -= b.h;
      continue;
    }
    if (b.parts && b.parts.length > 1) {
      const n = b.parts.length;
      let s = 0;
      while (s < n) {
        let e = s;
        let acc = b.base;
        while (e < n && acc + b.parts[e]! <= rem + EPS) {
          acc += b.parts[e]!;
          e++;
        }
        if (e === s) {
          // Nothing fits here: move to a fresh page; on a fresh page force one part.
          if (cur().length && !onlyHeadings(cur(), m)) {
            newPage();
            continue;
          }
          acc += b.parts[s]!;
          e = s + 1;
        }
        cur().push({ i, from: s, to: e });
        rem -= acc;
        s = e;
        if (s < n) newPage();
      }
      continue;
    }
    if (cur().length) {
      // Keep a trailing heading together with this block.
      const page = cur();
      const last = page[page.length - 1];
      const carry: Fragment[] = [];
      if (last && m.blocks[last.i]?.heading && page.length > 1) carry.push(page.pop()!);
      newPage();
      for (const f of carry) {
        cur().push(f);
        rem -= m.blocks[f.i]!.h;
      }
    }
    cur().push({ i });
    rem -= b.h;
  }
  if (pages.length > 1 && cur().length === 0) pages.pop();
  return pages;
}

function onlyHeadings(page: Fragment[], m: Measure): boolean {
  return page.every((f) => m.blocks[f.i]?.heading);
}
