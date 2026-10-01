ALTER TABLE users
  ADD COLUMN IF NOT EXISTS xyz TINYINT(1) NOT NULL DEFAULT 0
  COMMENT 'When 1, actions by this user are not written to audit_events';
