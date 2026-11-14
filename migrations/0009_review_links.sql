-- Review links + notifications (approval hand-off).
--
-- review_links: a link `/r/<token>` that opens one session's full review UI without a cookie.
-- Only SHA-256(token) is stored (hex). The token itself is an HMAC of the link id under a key
-- derived from SESSION_SECRET, so the server (never the DB alone) can show the same URL again
-- (phone inbox). Scoped to one provider + one session; 7-day expiry; revocable; closed once the
-- session completes (closed_at), after which it shows "already approved".
CREATE TABLE IF NOT EXISTS review_links (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  closed_at       TEXT,
  used_at         TEXT,
  last_opened_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_links_session ON review_links (provider_id, session_id, created_at);

-- In-app inbox. Titles are fixed templates with the client REF only (never names or transcript).
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  session_id  TEXT,
  client_ref  TEXT,
  title       TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_provider ON notifications (provider_id, created_at);

-- Per-provider notification preferences. Email is opt-in (NULL address = no email).
CREATE TABLE IF NOT EXISTS notification_settings (
  provider_id        TEXT PRIMARY KEY,
  email              TEXT,
  email_on_ready     INTEGER NOT NULL DEFAULT 0,
  email_on_approved  INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL
);

-- Outbound delivery log: ids, channel, status and reason codes only (no address, no content).
-- id is deterministic (`email:<notification id>`) so one notification is emailed at most once.
CREATE TABLE IF NOT EXISTS notification_log (
  id               TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL,
  notification_id  TEXT,
  channel          TEXT NOT NULL,
  sender           TEXT,
  status           TEXT NOT NULL,
  code             TEXT,
  message_id       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_log_provider ON notification_log (provider_id, created_at);
