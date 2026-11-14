import { useMemo } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { EyeOff, Sparkles } from "lucide-react";
import type { PrivacyOptions } from "../../../contracts";
import { Badge } from "../../design";
import { PRIVACY_SAMPLE, demoRedact } from "./shared";

/** Live before → after illustration of the privacy controller. Regex-based PREVIEW only. */
export function RedactionDemo({ options }: { options: PrivacyOptions }) {
  const reduce = useReducedMotion();
  const segments = useMemo(() => demoRedact(PRIVACY_SAMPLE, options), [options]);
  const count = segments.filter((s) => s.token).length;

  return (
    <div className="u2-redact" aria-labelledby="u2-redact-title">
      <div className="u2-redact-head">
        <span id="u2-redact-title" className="u2-redact-title">
          <Sparkles size={15} aria-hidden="true" /> What the AI provider would see
        </span>
        <Badge tone="info">Preview · illustration only</Badge>
      </div>
      <div className="u2-redact-row">
        <span className="u2-redact-label">Before</span>
        <p className="u2-redact-text u2-redact-before">{PRIVACY_SAMPLE}</p>
      </div>
      <div className="u2-redact-row">
        <span className="u2-redact-label">
          After{" "}
          <motion.span key={count} className="u2-redact-count" initial={reduce ? false : { scale: 1.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            {count} hidden
          </motion.span>
        </span>
        <LayoutGroup>
          <p className="u2-redact-text" aria-live="polite">
            {segments.map((s, i) =>
              s.token ? (
                <span key={`${i}-${s.text}`} className="u2-redact-slot">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={s.token}
                      className="u2-token"
                      title={`Replaced: ${s.text}`}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(6px)", scale: 0.8 }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)", scale: 1 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(6px)" }}
                      transition={{ type: "spring", stiffness: 420, damping: 26, delay: reduce ? 0 : (i % 7) * 0.03 }}
                    >
                      <EyeOff size={11} aria-hidden="true" />
                      {s.token}
                    </motion.span>
                  </AnimatePresence>
                </span>
              ) : (
                <motion.span key={`${i}-${s.text}`} layout={!reduce ? "position" : false}>
                  {s.text}
                </motion.span>
              ),
            )}
          </p>
        </LayoutGroup>
      </div>
      <p className="u2-muted u2-small">
        Tokens are restored in the AI's answer inside the server, so your documents keep the real values. The real
        controller also uses the appointment's known names and ids — this sample uses simple patterns.
      </p>
    </div>
  );
}
