-- 2026-09-20-order-intake-requests-v1
-- Requires migration: 2026-09-19-customer-phone-index-v1
-- Requires checksum: 3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a
-- Keep external request identity after a held order is completed or canceled.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS order_intake_requests (
  client_id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  external_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  held_order_id INT NOT NULL,
  result_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, external_request_id),
  KEY idx_order_intake_held_order (held_order_id),
  KEY idx_order_intake_created_at (created_at),
  CONSTRAINT chk_order_intake_result_json CHECK (JSON_VALID(result_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-20-order-intake-requests-v1', '8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
