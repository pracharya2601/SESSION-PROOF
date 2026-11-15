-- Recordings (contract src/contracts/schedule.ts, docs/recordings.md): the phone records the band
-- with NO client; the server partitions the transcript into sessions by the provider's calendar.
--
-- Transcript segments of a recording live in band_segments with visit_id = the recording id
-- ("rec_…"), so CaptureSession and the offline job write them exactly as for a visit.
--
-- status: recording | stopped | partitioned | failed
-- origin: live (streamed) | offline (VXREC1 upload, offline_visits.target = 'recording')
CREATE TABLE IF NOT EXISTS recordings (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  device_id         TEXT,
  band_number       INTEGER,
  transport         TEXT NOT NULL,
  transcriber       TEXT NOT NULL,
  status            TEXT NOT NULL,
  origin            TEXT NOT NULL DEFAULT 'live',
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  audio_started_at  TEXT,
  packets           INTEGER NOT NULL DEFAULT 0,
  lost_packets      INTEGER NOT NULL DEFAULT 0,
  timezone          TEXT,
  scenario          TEXT,
  -- Recording.partition as JSON (sessions + counts), written by the partition job.
  partition_json    TEXT,
  partitioned_at    TEXT,
  error_code        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recordings_provider ON recordings (provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status, updated_at);

-- One row per segment once partitioned. status: assigned | unassigned | ambiguous.
-- assigned: event_id/appointment_id set. ambiguous: candidate_appointment_ids (JSON array) set.
-- Unassigned segments' TEXT (the band_segments row) is deleted 24 h after partitioning; this row
-- (times only, never text) stays so counts survive.
CREATE TABLE IF NOT EXISTS recording_segment_assignments (
  recording_id              TEXT NOT NULL,
  idx                       INTEGER NOT NULL,
  provider_id               TEXT NOT NULL,
  status                    TEXT NOT NULL,
  event_id                  TEXT,
  appointment_id            TEXT,
  candidate_event_ids       TEXT,
  candidate_appointment_ids TEXT,
  observed_from             TEXT NOT NULL,
  observed_to               TEXT NOT NULL,
  partitioned_at            TEXT NOT NULL,
  text_deleted_at           TEXT,
  PRIMARY KEY (recording_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_rsa_appointment ON recording_segment_assignments (provider_id, appointment_id, status);
CREATE INDEX IF NOT EXISTS idx_rsa_unassigned ON recording_segment_assignments (status, partitioned_at) WHERE text_deleted_at IS NULL;

-- Hand-off of one recording's segments to one event's session (written AFTER the session was
-- ensured + enqueued, so a crashed partition re-does the hand-off on retry).
CREATE TABLE IF NOT EXISTS recording_sessions (
  recording_id    TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  appointment_id  TEXT NOT NULL,
  client_ref      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  segment_count   INTEGER NOT NULL,
  handed_off_at   TEXT NOT NULL,
  PRIMARY KEY (recording_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_session ON recording_sessions (session_id);

-- Offline uploads can target a recording (no client) instead of a band visit.
ALTER TABLE offline_visits ADD COLUMN target TEXT NOT NULL DEFAULT 'visit';
