import { FileText, Link2 } from "lucide-react";
import type { DocumentSection } from "../../../contracts";
import { originLabel } from "./format";
import { Section } from "./Section";

const SHOWN: DocumentSection["key"][] = ["session_note", "progress_record", "follow_ups", "missing_information"];

export function DocumentSections(props: {
  sections: DocumentSection[];
  onEvidence: (id: string) => void;
  activeEvidence?: string | null;
}) {
  const sections = SHOWN.map((k) => props.sections.find((s) => s.key === k)).filter(
    (s): s is DocumentSection => !!s,
  );
  return (
    <Section label="Documents" title="Documents" icon={<FileText size={18} />} className="rv-docs">
      {sections.map((s) => (
        <div key={s.key} className="rv-doc-section">
          <h3 className="rv-doc-h">
            {s.title}
            {s.key === "follow_ups" && <span className="rv-chip rv-not-sent">Recorded only — not sent</span>}
          </h3>
          {s.lines.length === 0 ? (
            <p className="rv-muted">No entries.</p>
          ) : (
            <ul className="rv-lines">
              {s.lines.map((l, i) => {
                const tag = originLabel(l.origin);
                return (
                  <li key={i} className="rv-line">
                    <span className={`rv-tag ${tag.cls}`}>{tag.label}</span>
                    <span className="rv-line-text">{l.text}</span>
                    {l.evidenceIds.length > 0 && (
                      <span className="rv-ev-refs">
                        {l.evidenceIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className={`rv-ev-link${props.activeEvidence === id ? " is-active" : ""}`}
                            onClick={() => props.onEvidence(id)}
                            aria-label={`Show evidence ${id}`}
                          >
                            <Link2 size={11} aria-hidden="true" />
                            {id}
                          </button>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </Section>
  );
}
