import type { DocumentSection } from "../../../contracts";
import { originLabel } from "./format";

const SHOWN: DocumentSection["key"][] = ["session_note", "progress_record", "follow_ups", "missing_information"];

export function DocumentSections(props: { sections: DocumentSection[]; onEvidence: (id: string) => void }) {
  const sections = SHOWN.map((k) => props.sections.find((s) => s.key === k)).filter(
    (s): s is DocumentSection => !!s,
  );
  return (
    <section className="card rv-docs" aria-label="Documents">
      <h2>Documents</h2>
      {sections.map((s) => (
        <div key={s.key} className="rv-doc-section">
          <h3>
            {s.title}
            {s.key === "follow_ups" && <span className="badge rv-not-sent">Recorded only — not sent</span>}
          </h3>
          {s.lines.length === 0 ? (
            <p className="muted">No entries.</p>
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
                            className="rv-ev-link"
                            onClick={() => props.onEvidence(id)}
                            aria-label={`Show evidence ${id}`}
                          >
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
    </section>
  );
}
