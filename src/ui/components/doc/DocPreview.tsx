import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Maximize2, Printer } from "lucide-react";
import type { DocModel } from "../../../contracts";
import { BlockView, partSelector, type Fragment } from "./DocBlocks";
import { paginate, type BlockMeasure, type Measure } from "./paginate";
import { FONT_STACKS, paperOf } from "./paper";
import "./doc.css";

export interface DocPreviewProps {
  model: DocModel;
  /** Fixed scale (1 = 100%). Omitted = fit to the container width with a zoom control. */
  scale?: number;
  className?: string;
  /** "thumbnail": first page only, fits the container width, no toolbar / animation / print. */
  variant?: "full" | "thumbnail";
  /** Show only the first N pages. */
  maxPages?: number;
}

type Zoom = "fit" | 1 | 1.5;
const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "fit", label: "Fit" },
  { id: 1, label: "100%" },
  { id: 1.5, label: "150%" },
];
const VIEW_PAD = 16;

function bannerTone(text: string): "draft" | "fixture" {
  return /draft/i.test(text) ? "draft" : "fixture";
}

function themeStyle(model: DocModel): CSSProperties {
  const accent = /^#[0-9a-fA-F]{6}$/.test(model.theme?.accentColor ?? "") ? model.theme.accentColor : "#4f46e5";
  return {
    ["--dp-accent" as string]: accent,
    ["--dp-font" as string]: FONT_STACKS[model.theme?.fontFamily ?? "sans"] ?? FONT_STACKS.sans,
  };
}

/** One sheet of paper at natural (100%) size. */
function Page({ model, frags, index, total, measureRef }: { model: DocModel; frags: Fragment[]; index: number; total: number; measureRef?: (el: HTMLDivElement | null) => void }) {
  const paper = paperOf(model.theme);
  const first = index === 0;
  const h = model.header;
  return (
    <div
      className={`dp-page dp-font-${model.theme?.fontFamily ?? "sans"} ${model.theme?.density === "compact" ? "dp-compact" : "dp-comfortable"}`}
      style={{ ...themeStyle(model), width: paper.cssW, height: paper.cssH }}
      aria-label={total > 0 ? `Page ${index + 1} of ${total}` : undefined}
    >
      {first ? (
        <header className="dp-head">
          <div className="dp-head-main">
            {h.logoText && <div className="dp-logo">{h.logoText}</div>}
            <h1 className="dp-title">{model.title}</h1>
            {h.headerNote && <p className="dp-head-note">{h.headerNote}</p>}
          </div>
          {h.meta.length > 0 && (
            <dl className="dp-meta">
              {h.meta.map((m, k) => (
                <div key={k}>
                  <dt>{m.label}</dt>
                  <dd>{m.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </header>
      ) : (
        <header className="dp-runhead">
          <span className="dp-runhead-l">
            {h.logoText && <strong>{h.logoText}</strong>}
            {h.logoText && <span aria-hidden="true"> · </span>}
            {model.title}
          </span>
          <span className="dp-runhead-r">continued</span>
        </header>
      )}
      {model.banner && <div className={`dp-banner dp-banner-${bannerTone(model.banner)}`}>{model.banner}</div>}
      <div className="dp-body" ref={measureRef}>
        {frags.map((f) => {
          const b = model.blocks[f.i];
          if (!b) return null;
          return (
            <div className={`dp-blk dp-blk-${b.type}`} key={`${f.i}:${f.from ?? 0}`} data-mi={measureRef ? f.i : undefined}>
              <BlockView block={b} from={f.from} to={f.to} />
            </div>
          );
        })}
      </div>
      <footer className="dp-foot">
        <span className="dp-foot-note">{model.footer.note}</span>
        <span className="dp-foot-rev">{model.footer.revisionLabel}</span>
        <span className="dp-foot-page">{total > 0 ? `Page ${index + 1} of ${total}` : " "}</span>
      </footer>
    </div>
  );
}

function measureBlocks(body: HTMLElement, model: DocModel): BlockMeasure[] {
  const out: BlockMeasure[] = model.blocks.map((b) => ({ h: 0, base: 0, parts: null, heading: b.type === "heading" }));
  body.querySelectorAll<HTMLElement>("[data-mi]").forEach((el) => {
    const i = Number(el.dataset.mi);
    const b = model.blocks[i];
    const m = out[i];
    if (!b || !m) return;
    m.h = el.getBoundingClientRect().height;
    const sel = partSelector(b);
    if (sel) {
      const parts = Array.from(el.querySelectorAll<HTMLElement>(sel)).map((p) => p.getBoundingClientRect().height);
      const sum = parts.reduce((a, c) => a + c, 0);
      m.parts = parts;
      m.base = Math.max(0, m.h - sum) + 1;
    }
  });
  return out;
}

/**
 * Paged, PDF-like HTML/CSS render of a DocModel: exact paper aspect (Letter / A4),
 * theme accent + font + density, header band, banner, footer with page numbers.
 * Blocks are measured off-screen at 100% and paginated client-side.
 */
export function DocPreview({ model, scale, className, variant = "full", maxPages }: DocPreviewProps) {
  const reduce = useReducedMotion();
  const thumb = variant === "thumbnail";
  const paper = paperOf(model.theme);
  const viewRef = useRef<HTMLDivElement>(null);
  const firstBodyRef = useRef<HTMLDivElement | null>(null);
  const restBodyRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<Fragment[][] | null>(null);
  const [fontsTick, setFontsTick] = useState(0);
  const [viewW, setViewW] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");

  const allFrags = useMemo<Fragment[]>(() => model.blocks.map((_, i) => ({ i })), [model]);

  // Measure + paginate before paint whenever the model (or loaded fonts) change.
  useLayoutEffect(() => {
    const first = firstBodyRef.current;
    const rest = restBodyRef.current;
    if (!first || !rest) return;
    const m: Measure = {
      first: first.clientHeight,
      rest: rest.clientHeight,
      blocks: measureBlocks(first, model),
    };
    if (m.first <= 0 || m.rest <= 0) return;
    setPages(paginate(m));
  }, [model, fontsTick]);

  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    let alive = true;
    void fonts.ready.then(() => alive && setFontsTick((t) => t + 1));
    const onDone = () => alive && setFontsTick((t) => t + 1);
    fonts.addEventListener?.("loadingdone", onDone);
    return () => {
      alive = false;
      fonts.removeEventListener?.("loadingdone", onDone);
    };
  }, []);

  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const update = () => setViewW(el.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = viewW > 0 ? Math.max(0.05, (viewW - (thumb ? 0 : VIEW_PAD * 2)) / paper.w) : 0;
  const s = scale ?? (thumb ? fitScale : zoom === "fit" ? Math.min(fitScale, 1.6) : zoom);
  const limit = thumb ? 1 : maxPages;
  const shown = pages ? (limit ? pages.slice(0, limit) : pages) : [];
  const total = pages?.length ?? 0;

  const print = useCallback(() => window.print(), []);

  return (
    <div className={`dp-root ${thumb ? "dp-root-thumb" : ""} ${className ?? ""}`}>
      {/* Off-screen measurement sheets at 100% */}
      <div className="dp-measure" aria-hidden="true">
        <Page model={model} frags={allFrags} index={0} total={0} measureRef={(el) => (firstBodyRef.current = el)} />
        <Page model={model} frags={[]} index={1} total={0} measureRef={(el) => (restBodyRef.current = el)} />
      </div>

      {!thumb && scale === undefined && (
        <div className="dp-toolbar">
          <span className="dp-count" aria-live="polite">
            {total > 0 ? `${total} page${total === 1 ? "" : "s"}` : "Laying out…"}
            <span className="dp-count-paper"> · {model.theme?.paper === "a4" ? "A4" : "US Letter"}</span>
          </span>
          <div className="dp-zoom" role="group" aria-label="Zoom">
            {ZOOMS.map((z) => (
              <button
                key={String(z.id)}
                type="button"
                className={zoom === z.id ? "dp-zoom-btn on" : "dp-zoom-btn"}
                aria-pressed={zoom === z.id}
                onClick={() => setZoom(z.id)}
              >
                {z.id === "fit" && <Maximize2 size={12} aria-hidden="true" />}
                {z.label}
              </button>
            ))}
          </div>
          <button type="button" className="dp-zoom-btn dp-print-btn" onClick={print} aria-label="Print preview" title="Print">
            <Printer size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <div
        ref={viewRef}
        className="dp-view"
        role={thumb ? undefined : "region"}
        aria-label={thumb ? undefined : `Document preview: ${model.title}`}
        aria-hidden={thumb || undefined}
        tabIndex={thumb ? undefined : 0}
      >
        {s > 0 && (
          <div className="dp-stack" style={{ perspective: thumb ? undefined : 1600 }}>
            {shown.map((frags, p) => (
              <motion.div
                key={p}
                className="dp-slot"
                style={{ width: paper.w * s, height: paper.h * s }}
                initial={thumb || reduce ? { opacity: 0 } : { opacity: 0, y: 28, rotateX: 9, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
                transition={
                  thumb || reduce
                    ? { duration: 0.18 }
                    : { type: "spring", stiffness: 210, damping: 26, delay: Math.min(p, 6) * 0.07 }
                }
              >
                <div className="dp-scaler" style={{ transform: `scale(${s})` }}>
                  <Page model={model} frags={frags} index={p} total={total} />
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {!thumb &&
        pages &&
        createPortal(
          <div className="dp-print" aria-hidden="true">
            <style>{`@page { size: ${paper.pageSize}; margin: 0; }`}</style>
            {pages.map((frags, p) => (
              <Page key={p} model={model} frags={frags} index={p} total={total} />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default DocPreview;
