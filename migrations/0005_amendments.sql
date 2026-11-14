-- Amendments: a COMPLETED session can be reopened as a new revision.
-- The previously approved final bundle is moved here (never deleted) for audit.
CREATE TABLE IF NOT EXISTS superseded_finals (
  session_id               TEXT NOT NULL,
  bundle_revision          INTEGER NOT NULL,
  approval_id              TEXT NOT NULL,
  finalized_at             TEXT NOT NULL,
  bundle_json              TEXT NOT NULL,
  superseded_at            TEXT NOT NULL,
  superseded_by_revision   INTEGER NOT NULL,
  reason                   TEXT NOT NULL,
  actor_provider_id        TEXT NOT NULL,
  PRIMARY KEY (session_id, bundle_revision)
);
CREATE INDEX IF NOT EXISTS idx_superseded_finals_session ON superseded_finals (session_id);
