-- Vexo Field Assistant — initial schema (handoff §10.1). Owner: Agent 04.
-- Instants are UTC ISO-8601 strings. Columns suffixed _ms hold epoch millis
-- derived from the ISO value and are used only for range comparisons.
-- JSON snapshot columns are validated with zod on read (src/db/d1.ts).

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Versioned plan + documentation rules + rate snapshot.
CREATE TABLE IF NOT EXISTS service_configs (
  plan_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  rate_version TEXT NOT NULL,
  service_code TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_version, rule_version, rate_version)
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  service_code TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  rate_version TEXT NOT NULL,
  canceled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, occurrence_id)
);
CREATE INDEX IF NOT EXISTS idx_appointments_end ON appointments (end_ms);
CREATE INDEX IF NOT EXISTS idx_appointments_provider_time ON appointments (provider_id, start_ms, end_ms);

-- Logical session = provider + immutable appointment occurrence.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  status TEXT NOT NULL,
  processing_revision INTEGER NOT NULL DEFAULT 0,
  current_bundle_revision INTEGER NOT NULL DEFAULT 0,
  workflow_id TEXT,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, occurrence_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);

-- Necessary excerpts only — never full transcripts.
CREATE TABLE IF NOT EXISTS evidence (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  processing_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  source_id TEXT,
  source_mode TEXT NOT NULL,
  observed_from TEXT,
  observed_to TEXT,
  speaker TEXT,
  excerpt TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  citation_url TEXT,
  PRIMARY KEY (session_id, id)
);

-- Immutable bundle revisions. Summary columns are denormalized from bundle_json.
CREATE TABLE IF NOT EXISTS bundles (
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  processing_revision INTEGER NOT NULL,
  bundle_json TEXT NOT NULL,
  can_approve INTEGER NOT NULL,
  amount_cents INTEGER,
  evidence_mode TEXT NOT NULL,
  extraction_mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, revision)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  bundle_revision INTEGER NOT NULL,
  approver_provider_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  finalization_status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (session_id, bundle_revision),
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_approvals_finalization ON approvals (finalization_status, approved_at);

CREATE TABLE IF NOT EXISTS final_bundles (
  session_id TEXT NOT NULL UNIQUE,
  bundle_revision INTEGER NOT NULL,
  approval_id TEXT NOT NULL UNIQUE,
  finalized_at TEXT NOT NULL,
  bundle_json TEXT NOT NULL
);

-- Durable delivery intent (queue sends, workflow approval events).
CREATE TABLE IF NOT EXISTS pending_deliveries (
  delivery_key TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON pending_deliveries (status, next_attempt_at);

-- Placeholder: no calendar OAuth this sprint. Tokens are only ever stored
-- encrypted (ciphertext + IV); plaintext token columns must never be added.
CREATE TABLE IF NOT EXISTS oauth_connections (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  access_token_ciphertext TEXT,
  access_token_iv TEXT,
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  key_version TEXT,
  scopes TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, provider_kind, account_ref)
);
