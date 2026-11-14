-- Band visits: a provider records a visit with a Vexo Open band. The browser or a
-- native bridge (GlassCam on iPhone) streams the band's audio; the Worker stores
-- only FINAL transcript segments (no audio). Segments are the visit's evidence.
CREATE TABLE IF NOT EXISTS band_visits (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  appointment_id    TEXT NOT NULL,
  client_ref        TEXT NOT NULL,
  band_number       INTEGER,
  transport         TEXT NOT NULL,
  transcriber       TEXT NOT NULL,
  status            TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  audio_started_at  TEXT,
  packets           INTEGER NOT NULL DEFAULT 0,
  lost_packets      INTEGER NOT NULL DEFAULT 0,
  session_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_band_visits_provider ON band_visits (provider_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_band_visits_appointment ON band_visits (appointment_id);

CREATE TABLE IF NOT EXISTS band_segments (
  visit_id       TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  provider_id    TEXT NOT NULL,
  observed_from  TEXT NOT NULL,
  observed_to    TEXT NOT NULL,
  speaker        TEXT,
  text           TEXT NOT NULL,
  source_mode    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (visit_id, idx)
);
