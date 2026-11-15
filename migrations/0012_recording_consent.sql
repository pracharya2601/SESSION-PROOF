-- Recordings: when the provider confirmed recording consent on the phone (offline uploads send
-- consentConfirmedAt; exposed as Recording.consentConfirmedAt). NULL when not recorded.
ALTER TABLE recordings ADD COLUMN consent_confirmed_at TEXT;
