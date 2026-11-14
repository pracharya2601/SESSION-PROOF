import { motion, useReducedMotion } from "framer-motion";
import { Download, Eye } from "lucide-react";
import type { CompletedSessionFiles, FileKind } from "../../../contracts";
import { api } from "../../api";
import { cx, fadeOnly, fadeUp, springy, stagger } from "../../design";
import { FILE_ICONS } from "../settings/FileKindChecks";
import { FILE_KINDS, FILE_LABELS } from "../settings/shared";

/** The three PDF tiles for a session, each with one-click Download and inline Preview. */
export function FileTiles({ item, onPreview }: { item: CompletedSessionFiles; onPreview: (k: FileKind) => void }) {
  const reduce = useReducedMotion();
  const v = reduce ? fadeOnly : fadeUp;
  return (
    <motion.ul className="u2-tiles" variants={stagger} initial="hidden" animate="show" aria-label="Session files">
      {FILE_KINDS.map((k) => {
        const f = item.files.find((x) => x.kind === k);
        const Icon = FILE_ICONS[k];
        const available = !!f;
        return (
          <motion.li
            key={k}
            variants={v}
            className={cx("u2-tile", `u2-tile-${k}`, !available && "u2-tile-missing")}
            whileHover={reduce || !available ? undefined : { y: -3, scale: 1.015 }}
            transition={springy}
          >
            <span className="u2-tile-ico" aria-hidden="true">
              <Icon size={20} />
              <span className="u2-tile-ext">PDF</span>
            </span>
            <span className="u2-tile-text">
              <span className="u2-tile-name">{f?.label ?? FILE_LABELS[k]}</span>
              <span className="u2-tile-file" title={f?.filename}>
                {f?.filename ?? "Not available"}
              </span>
            </span>
            {available && (
              <span className="u2-tile-actions">
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm ds-btn-icon"
                  aria-label={`Preview ${FILE_LABELS[k]}`}
                  title="Preview"
                  onClick={() => onPreview(k)}
                >
                  <Eye size={16} aria-hidden="true" />
                </button>
                <a
                  className="ds-btn ds-btn-secondary ds-btn-sm ds-btn-icon"
                  href={api.fileUrl(item.sessionId, k)}
                  download={f.filename}
                  aria-label={`Download ${FILE_LABELS[k]}`}
                  title="Download"
                >
                  <Download size={16} aria-hidden="true" />
                </a>
              </span>
            )}
          </motion.li>
        );
      })}
    </motion.ul>
  );
}

/** Triggers each file download in turn (small gap so browsers don't coalesce them). */
export async function downloadAll(item: CompletedSessionFiles): Promise<void> {
  for (const k of FILE_KINDS) {
    const f = item.files.find((x) => x.kind === k);
    if (!f) continue;
    const a = document.createElement("a");
    a.href = api.fileUrl(item.sessionId, k);
    a.download = f.filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 450));
  }
}
