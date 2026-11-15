-- Provider business profile (Settings → Business profile) + sequential invoice numbers.
--
-- provider_profiles: one row per provider. profile_json holds the ProviderProfileInput fields
-- except the numbering counters, which are columns so they can be bumped atomically.
-- Production starts with no row (= empty profile); the dev seed fills a fictional one.
CREATE TABLE IF NOT EXISTS provider_profiles (
  provider_id          TEXT PRIMARY KEY,
  profile_json         TEXT NOT NULL,
  invoice_prefix       TEXT NOT NULL DEFAULT 'INV',
  next_invoice_number  INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT NOT NULL
);

-- One invoice number per approved revision, assigned at approval/finalization and never reused:
-- (provider_id, seq) and (provider_id, invoice_number) are unique, and next_invoice_number only
-- ever grows. profile_json freezes the business profile printed on that invoice.
CREATE TABLE IF NOT EXISTS invoice_numbers (
  provider_id      TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  bundle_revision  INTEGER NOT NULL,
  seq              INTEGER NOT NULL,
  invoice_number   TEXT NOT NULL,
  profile_json     TEXT NOT NULL,
  assigned_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, bundle_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_numbers_provider_seq ON invoice_numbers (provider_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_numbers_provider_number ON invoice_numbers (provider_id, invoice_number);

-- Client invoice details (UCI, FMS address, authorization override, representative) as JSON.
ALTER TABLE clients ADD COLUMN billing_json TEXT;
