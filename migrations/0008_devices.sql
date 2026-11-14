-- Paired devices: a phone (GlassCam) paired once with a long-lived device key.
-- Only SHA-256(key) is stored (hex); the key itself is shown once at pairing.
-- Revoking sets revoked_at, and the key stops working immediately.
CREATE TABLE IF NOT EXISTS paired_devices (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_paired_devices_provider ON paired_devices (provider_id, created_at);
