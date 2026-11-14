-- Vexo Field Assistant — v2 schema (files, cloud connections, deliveries, settings). Owner: V1.
-- Instants are UTC ISO-8601 strings. JSON columns are validated with zod on read (src/db/d1.ts).

-- Per-provider settings documents (StorageSettings / EmailSettings / AiSettings as JSON).
CREATE TABLE IF NOT EXISTS provider_settings (
  provider_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('storage', 'email', 'ai')),
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, kind)
);

-- Cloud connections (Google / Microsoft). Tokens are an opaque encrypted blob
-- produced by the caller (encryptToken); plaintext token columns must never be added.
CREATE TABLE IF NOT EXISTS connections (
  provider_id             TEXT NOT NULL,
  provider                TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_email           TEXT,
  scopes_json             TEXT NOT NULL,
  encrypted_tokens        TEXT NOT NULL,
  access_token_expires_at TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('connected', 'error')),
  last_error              TEXT,
  connected_at            TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (provider_id, provider)
);

-- One-time OAuth state (PKCE verifier + return path), consumed atomically.
CREATE TABLE IF NOT EXISTS oauth_pending (
  nonce         TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending (expires_at);

-- Drive uploads and email drafts for completed sessions.
CREATE TABLE IF NOT EXISTS file_deliveries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  bundle_revision INTEGER NOT NULL,
  target          TEXT NOT NULL,
  provider        TEXT NOT NULL,
  files_json      TEXT NOT NULL,
  status          TEXT NOT NULL,
  external_id     TEXT,
  web_url         TEXT,
  recipients_json TEXT NOT NULL,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_deliveries_session ON file_deliveries (session_id, created_at);

-- Files dashboard: COMPLETED sessions per provider.
CREATE INDEX IF NOT EXISTS idx_sessions_provider_status ON sessions (provider_id, status);
