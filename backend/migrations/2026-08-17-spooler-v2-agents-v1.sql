-- 2026-08-17-spooler-v2-agents-v1
-- Requires migration: 2026-08-13-webauthn-registered-device-access-v1
-- Requires checksum: 20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09
-- Requires normalized SQL SHA-256: 4d29b2be29029f32b402ff5fc923938c04ab8eae74501c55607bc481a3157619
-- Durable V2 station ownership, agent identity history, and queue lifecycle state.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS spooler_stations (
  spooler_id VARCHAR(96) NOT NULL,
  delivery_protocol ENUM('v1','transitioning','v2') NOT NULL DEFAULT 'v1',
  v2_activated_at DATETIME DEFAULT NULL,
  first_v2_accepted_at DATETIME DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (spooler_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS spooler_agents (
  agent_id CHAR(36) NOT NULL,
  spooler_id VARCHAR(96) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL DEFAULT '',
  agent_version VARCHAR(40) DEFAULT NULL,
  protocol_version INT NOT NULL DEFAULT 2,
  status ENUM('active','draining','revoked','decommissioned') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME DEFAULT NULL,
  last_sync_at DATETIME DEFAULT NULL,
  last_error VARCHAR(255) DEFAULT NULL,
  local_queue_depth INT DEFAULT NULL,
  health_summary VARCHAR(255) DEFAULT NULL,
  active_station_key VARCHAR(96) GENERATED ALWAYS AS
    (CASE WHEN status IN ('active','draining') THEN spooler_id ELSE NULL END) STORED,
  PRIMARY KEY (agent_id),
  UNIQUE KEY uq_spooler_agents_active_station (active_station_key),
  KEY idx_spooler_agents_station (spooler_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Isolated statement. Fail closed if INSTANT is unavailable; never use INPLACE/COPY.
ALTER TABLE print_queue
  MODIFY COLUMN status ENUM('pending','processing','sent','acknowledged','failed',
    'dead_letter','canceled','local_accepted','cancel_requested') NOT NULL DEFAULT 'pending',
  ALGORITHM=INSTANT, LOCK=NONE;

-- Separate statement: nullable trailing columns (INSTANT-eligible).
ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS agent_id CHAR(36) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS accepted_at DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_failure_class ENUM('transient_safe','permanent_safe','uncertain') DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS artifact_hash CHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS artifact_bytes INT UNSIGNED DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

-- Separate statement: index build (INPLACE is the proven-safe algorithm for ADD INDEX).
ALTER TABLE print_queue
  ADD KEY IF NOT EXISTS idx_print_queue_agent_claim (agent_id, status, locked_until, id),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-17-spooler-v2-agents-v1',
  'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
