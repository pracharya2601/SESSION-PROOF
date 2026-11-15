-- Content suggestions (pass 2 of the recording partition, docs/recordings.md "Content suggestions").
--
-- Pass 1 (time rule) is the only automatic assignment. Pass 2 proposes a client for blocks of
-- unassigned / ambiguous segments from their CONTENT; nothing is assigned until the provider
-- accepts. Rows hold ids, indexes, times, scores and a short rationale: never transcript text
-- or names.

-- How an assigned segment got its assignment. calendar_time: pass 1. provider_confirmed_content:
-- the provider accepted a content suggestion (pass 1 re-runs never overwrite those rows).
ALTER TABLE recording_segment_assignments ADD COLUMN method TEXT NOT NULL DEFAULT 'calendar_time';

-- status: pending | accepted | rejected. kind: event | unscheduled. method: rules | ai+rules.
-- segment_indexes / candidate_client_refs: JSON arrays. suggested_client_ref NULL = "none".
CREATE TABLE IF NOT EXISTS recording_assignment_suggestions (
  id                    TEXT PRIMARY KEY,
  recording_id          TEXT NOT NULL,
  provider_id           TEXT NOT NULL,
  segment_indexes       TEXT NOT NULL,
  observed_from         TEXT NOT NULL,
  observed_to           TEXT NOT NULL,
  suggested_client_ref  TEXT,
  event_id              TEXT,
  kind                  TEXT NOT NULL,
  confidence            REAL NOT NULL,
  method                TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  candidate_client_refs TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  created_at            TEXT NOT NULL,
  decided_at            TEXT,
  accepted_client_ref   TEXT,
  appointment_id        TEXT,
  session_id            TEXT
);
CREATE INDEX IF NOT EXISTS idx_ras_recording ON recording_assignment_suggestions (recording_id, observed_from);
CREATE INDEX IF NOT EXISTS idx_ras_pending ON recording_assignment_suggestions (status, recording_id);

-- Conversation type per block (docs/recordings.md "Conversation type"): one row per
-- (recording, scope) where scope_key = 'event:<eventId>' (a pass 1 / accepted session block) or
-- 'suggestion:<id>' (a pass 2 block). signals_json holds counts / booleans only (no text, names
-- or client refs). provider_decision: NULL | 'client_session' (confirmed) | 'dismissed'; a re-run
-- never overwrites it.
CREATE TABLE IF NOT EXISTS recording_conversations (
  recording_id       TEXT NOT NULL,
  scope_key          TEXT NOT NULL,
  provider_id        TEXT NOT NULL,
  appointment_id     TEXT,
  segment_count      INTEGER NOT NULL,
  conversation_type  TEXT NOT NULL,
  confidence         REAL NOT NULL,
  method             TEXT NOT NULL,
  signals_json       TEXT NOT NULL,
  provider_decision  TEXT,
  decided_at         TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (recording_id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_rconv_appointment ON recording_conversations (provider_id, appointment_id);
