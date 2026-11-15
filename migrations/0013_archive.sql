-- Archive / delete (src/archive, src/api/archive.ts).
--
-- archived_items: reversible hide. One row per archived item; unarchive deletes the row. Lists
-- (sessions, recordings, runs) skip archived items unless asked to include them. Nothing else
-- about the item changes, so the audit trail stays intact.
--   kind: session | recording | run       item_id: session id | recording id | run id
CREATE TABLE IF NOT EXISTS archived_items (
  provider_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  archived_at  TEXT NOT NULL,
  archived_by  TEXT NOT NULL,
  reason       TEXT,
  PRIMARY KEY (provider_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_archived_items_kind ON archived_items (provider_id, kind, archived_at);

-- dismissed_events: a deleted draft session's calendar event (or appointment occurrence).
-- event_id = the session's occurrence_id (the calendar eventId for appt_cal_*). Discovery and the
-- partitioner's calendar pass skip it, so the deleted session is not recreated from recordings
-- that existed when it was deleted. A recording created after dismissed_at that overlaps the
-- event lifts the dismissal for that partition. last_processing_revision keeps workflow ids
-- unique if the session is ever recreated (processing revisions are never reused).
CREATE TABLE IF NOT EXISTS dismissed_events (
  provider_id               TEXT NOT NULL,
  event_id                  TEXT NOT NULL,
  appointment_id            TEXT NOT NULL,
  session_id                TEXT NOT NULL,
  last_processing_revision  INTEGER NOT NULL DEFAULT 0,
  dismissed_at              TEXT NOT NULL,
  PRIMARY KEY (provider_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_dismissed_events_appointment ON dismissed_events (provider_id, appointment_id);

-- audit_log: who / when / what kind / which id. Never content (no transcript, names, emails).
--   action: archive | unarchive | delete        item_kind: session | recording | run
--   detail_json: counts and codes only (e.g. {"segments":4,"runEvents":7}).
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  item_kind    TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_provider ON audit_log (provider_id, at);
