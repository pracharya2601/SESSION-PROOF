import { useEffect, useRef, useState } from "react";
import { FileWarning } from "lucide-react";
import type { DocModel, DocumentTemplate } from "../../../contracts";
import { api } from "../../api";
import { Skeleton } from "../../design";
import { DocPreview } from "../doc/DocPreview";
import { cachedPreview, toInput } from "./shared";

/** Live mini first-page thumbnail (api.previewTemplate with sample data). Loads when scrolled into view. */
export function TemplateThumb({ template }: { template: DocumentTemplate }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [model, setModel] = useState<DocModel | null>(null);
  const [failed, setFailed] = useState(false);
  const input = toInput(template);
  const key = JSON.stringify(input);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setFailed(false);
    cachedPreview(key, () => api.previewTemplate({ template: JSON.parse(key) }))
      .then((m) => alive && setModel(m))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [visible, key]);

  const ratio = template.theme.paper === "a4" ? "210 / 297" : "8.5 / 11";
  return (
    <div ref={ref} className="tp-thumb" style={{ aspectRatio: ratio }}>
      {model ? (
        <DocPreview model={model} variant="thumbnail" />
      ) : failed ? (
        <div className="tp-thumb-fail">
          <FileWarning size={20} aria-hidden="true" />
          <span>Preview unavailable</span>
        </div>
      ) : (
        <div className="tp-thumb-skel" aria-hidden="true">
          <Skeleton height={10} width="40%" />
          <Skeleton height={16} width="70%" />
          <Skeleton lines={3} height={6} />
          <Skeleton height={36} radius={3} />
          <Skeleton lines={4} height={6} />
        </div>
      )}
    </div>
  );
}
