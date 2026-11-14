-- Vexo Field Assistant — v3 schema (clients, client snapshots, document templates, run history). Owner: W1.
-- Additive only. Instants are UTC ISO-8601 strings; *_ms columns hold epoch millis for ordering.
-- JSON columns are validated with zod on read (src/db/d1.ts).

-- Provider-scoped clients; client_ref matches appointments.client_ref.
CREATE TABLE IF NOT EXISTS clients (
  provider_id          TEXT NOT NULL,
  client_ref           TEXT NOT NULL,
  display_name         TEXT,
  preferred_name       TEXT,
  hourly_rate_cents    INTEGER,
  funding_source       TEXT,
  authorization_number TEXT,
  fiscal_intermediary  TEXT,
  authorized_hours     REAL,
  case_manager         TEXT,
  custom_fields_json   TEXT NOT NULL,
  templates_json       TEXT NOT NULL,
  notes                TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  rate_version         INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (provider_id, client_ref)
);
CREATE INDEX IF NOT EXISTS idx_clients_provider_active ON clients (provider_id, active);

-- Client snapshot frozen at finalization (immutable; idempotent per session+revision).
CREATE TABLE IF NOT EXISTS client_snapshots (
  session_id      TEXT NOT NULL,
  bundle_revision INTEGER NOT NULL,
  snapshot_json   TEXT NOT NULL,
  captured_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, bundle_revision)
);

-- Custom document templates (built-ins are never stored).
CREATE TABLE IF NOT EXISTS document_templates (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('session_note', 'invoice', 'approval_record')),
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL, -- { theme, sections, text }
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_templates_provider_kind ON document_templates (provider_id, kind);

-- Provider default template per kind (template_id may be a builtin id).
CREATE TABLE IF NOT EXISTS default_templates (
  provider_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  template_id TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, kind)
);

-- Run history events (no transcript text / PII). id is deterministic for dedupe.
CREATE TABLE IF NOT EXISTS run_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  run_kind    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL,
  label       TEXT NOT NULL,
  detail      TEXT,
  meta_json   TEXT NOT NULL,
  at          TEXT NOT NULL,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_provider_at ON run_events (provider_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events (run_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_run_events_session ON run_events (session_id, at_ms);
