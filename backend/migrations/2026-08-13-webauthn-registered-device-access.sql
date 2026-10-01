-- 2026-08-13-webauthn-registered-device-access-v1
-- Requires migration: 2026-08-13-split-quantity-precision-v1
-- Requires checksum: eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76
-- Durable WebAuthn credentials, ceremonies, recovery codes, and credential-aware sessions.

SET NAMES utf8mb4;

-- Recreate an empty legacy column on a deliberately replayed migration so the
-- one-time session import remains safe after the first run drops it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_token VARCHAR(128) DEFAULT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS webauthn_user_handle VARBINARY(64) DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_webauthn_user_handle
  ON users (webauthn_user_handle);

CREATE TABLE IF NOT EXISTS webauthn_recovery_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  batch_id CHAR(36) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id INT DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  used_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webauthn_recovery_code_hash (code_hash),
  KEY idx_webauthn_recovery_user_batch (user_id, batch_id, used_at),
  KEY idx_webauthn_recovery_expiry (expires_at, used_at),
  CONSTRAINT fk_webauthn_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_webauthn_recovery_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  credential_lookup BINARY(32) NOT NULL,
  credential_id VARBINARY(1024) NOT NULL,
  public_key BLOB NOT NULL,
  counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
  device_type ENUM('singleDevice','multiDevice') NOT NULL,
  backed_up TINYINT(1) NOT NULL DEFAULT 0,
  authenticator_attachment ENUM('platform','cross-platform') DEFAULT NULL,
  transports VARCHAR(255) DEFAULT NULL,
  aaguid CHAR(36) DEFAULT NULL,
  attestation_format VARCHAR(32) DEFAULT NULL,
  device_label VARCHAR(100) NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  registered_by_user_id INT DEFAULT NULL,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  revoked_by_user_id INT DEFAULT NULL,
  revoke_reason VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webauthn_credential_lookup (credential_lookup),
  KEY idx_webauthn_credentials_user_status (user_id, status),
  KEY idx_webauthn_credentials_last_used (last_used_at),
  CONSTRAINT fk_webauthn_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_webauthn_credentials_registrar FOREIGN KEY (registered_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_credentials_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  user_id INT NOT NULL,
  credential_id BIGINT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idle_expires_at DATETIME NOT NULL,
  absolute_expires_at DATETIME NOT NULL,
  webauthn_verified_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  revoke_reason VARCHAR(100) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_sessions_token_hash (token_hash),
  KEY idx_auth_sessions_user_active (user_id, revoked_at, idle_expires_at),
  KEY idx_auth_sessions_credential_active (credential_id, revoked_at, idle_expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_auth_sessions_credential FOREIGN KEY (credential_id) REFERENCES webauthn_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS webauthn_ceremonies (
  id CHAR(36) NOT NULL,
  flow ENUM('bootstrap_registration','enrollment_registration','authentication','step_up','recovery_registration') NOT NULL,
  user_id INT DEFAULT NULL,
  requesting_user_id INT DEFAULT NULL,
  replacement_credential_id BIGINT UNSIGNED DEFAULT NULL,
  recovery_code_id BIGINT UNSIGNED DEFAULT NULL,
  is_decoy TINYINT(1) NOT NULL DEFAULT 0,
  challenge VARBINARY(128) NOT NULL,
  enrollment_token_hash CHAR(64) DEFAULT NULL,
  enrollment_expires_at DATETIME DEFAULT NULL,
  intended_device_label VARCHAR(100) DEFAULT NULL,
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  terminal_state ENUM('pending','consumed','expired','cancelled','failed') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (id),
  KEY idx_webauthn_ceremonies_flow_user (flow, user_id, terminal_state, expires_at),
  KEY idx_webauthn_ceremonies_challenge (challenge, terminal_state, expires_at),
  KEY idx_webauthn_ceremonies_token (enrollment_token_hash, enrollment_expires_at),
  KEY idx_webauthn_ceremonies_recovery (recovery_code_id, terminal_state),
  CONSTRAINT fk_webauthn_ceremonies_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_ceremonies_requester FOREIGN KEY (requesting_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_ceremonies_replacement FOREIGN KEY (replacement_credential_id) REFERENCES webauthn_credentials(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_ceremonies_recovery FOREIGN KEY (recovery_code_id) REFERENCES webauthn_recovery_codes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO auth_sessions (
  id, token_hash, user_id, credential_id, created_at, last_seen_at,
  idle_expires_at, absolute_expires_at, webauthn_verified_at
)
SELECT UUID(), u.session_token, u.id, NULL, NOW(), NOW(),
       DATE_ADD(NOW(), INTERVAL 30 MINUTE), DATE_ADD(NOW(), INTERVAL 12 HOUR), NULL
  FROM users AS u
 WHERE u.session_token IS NOT NULL
   AND u.session_token REGEXP '^[0-9a-fA-F]{64}$'
   AND u.is_active = 1
   AND NOT EXISTS (
       SELECT 1 FROM auth_sessions AS s WHERE s.token_hash = u.session_token
   );

ALTER TABLE users
  DROP INDEX IF EXISTS idx_users_session_token,
  DROP COLUMN IF EXISTS session_token;

INSERT INTO settings (setting_key, setting_value)
VALUES ('staff_device_auth_mode', 'disabled'), ('webauthn_bootstrap_consumed', '0')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-13-webauthn-registered-device-access-v1',
  '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
