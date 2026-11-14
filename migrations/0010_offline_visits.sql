-- Offline recordings: the phone had no internet, recorded the band's Opus packets to a VXREC1
-- file, and uploads it later (docs/offline-recording.md). One row per offline band visit
-- (band_visits.id). The visit's appointment is created canceled = 1 (invisible to discovery and
-- overlap checks) and un-canceled when the transcript is stored and processing is queued.
--
-- status: awaiting_audio | transcribing | transcribed | failed
-- audio_key: the R2 (AUDIO_TMP) object while it exists; NULL once deleted. Audio is kept only
-- until transcription (deleted right after), or until audio_delete_after after a final failure.
-- Never holds audio or transcript text.
CREATE TABLE IF NOT EXISTS offline_visits (
  visit_id              TEXT PRIMARY KEY,
  provider_id           TEXT NOT NULL,
  device_id             TEXT NOT NULL,
  local_id              TEXT NOT NULL,
  status                TEXT NOT NULL,
  recorded_from         TEXT NOT NULL,
  recorded_to           TEXT NOT NULL,
  consent_confirmed_at  TEXT NOT NULL,
  audio_key             TEXT,
  audio_bytes           INTEGER,
  uploaded_at           TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  error_code            TEXT,
  error_message         TEXT,
  error_retryable       INTEGER,
  audio_delete_after    TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_visits_device_local ON offline_visits (device_id, local_id);
CREATE INDEX IF NOT EXISTS idx_offline_visits_provider ON offline_visits (provider_id, created_at);
CREATE INDEX IF NOT EXISTS idx_offline_visits_status ON offline_visits (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_offline_visits_audio ON offline_visits (audio_delete_after) WHERE audio_key IS NOT NULL;
