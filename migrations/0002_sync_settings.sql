-- Provider-controlled automatic sync schedule (see SyncSettings in src/contracts).
CREATE TABLE IF NOT EXISTS provider_sync_settings (
  provider_id      TEXT PRIMARY KEY REFERENCES providers(id),
  enabled          INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 15,
  lookback_days    INTEGER NOT NULL DEFAULT 7,
  last_run_at      TEXT,
  updated_at       TEXT NOT NULL
);
