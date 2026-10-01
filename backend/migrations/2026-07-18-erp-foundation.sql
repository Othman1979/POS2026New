-- POS ERP foundation migration (phpMyAdmin-safe).
-- 1. Back up the selected client database.
-- 2. Run 2026-07-18-erp-foundation-preflight.sql and require blocking_findings = 0.
-- 3. Import this whole file from phpMyAdmin's Import tab. Do not paste fragments into SQL.
-- 4. Run 2026-07-18-erp-foundation-verify.sql and require verification_failures = 0.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260718_erp_foundation`$$
CREATE PROCEDURE `_ps_20260718_erp_foundation`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_conflicts INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('products', 'product_bundle_items', 'print_queue', 'printers');
    IF v_count <> 4 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required POS tables are missing';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-18-erp-foundation-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8' THEN
        LEAVE migration;
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM product_bundle_items
     WHERE NOT (qty > 0);
    IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: non-positive bundle quantities require manual correction';
    END IF;

    SELECT COUNT(*) INTO v_conflicts
      FROM information_schema.KEY_COLUMN_USAGE kcu
      LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
       AND kcu.TABLE_NAME = 'product_bundle_items'
       AND kcu.CONSTRAINT_NAME IN ('fk_pbi_bundle', 'fk_pbi_product')
       AND NOT (
           (kcu.CONSTRAINT_NAME = 'fk_pbi_bundle' AND kcu.COLUMN_NAME = 'bundle_id'
            AND kcu.REFERENCED_TABLE_NAME = 'products' AND kcu.REFERENCED_COLUMN_NAME = 'id'
            AND rc.DELETE_RULE = 'CASCADE')
           OR
           (kcu.CONSTRAINT_NAME = 'fk_pbi_product' AND kcu.COLUMN_NAME = 'product_id'
            AND kcu.REFERENCED_TABLE_NAME = 'products' AND kcu.REFERENCED_COLUMN_NAME = 'id'
            AND rc.DELETE_RULE = 'RESTRICT')
       );
    IF v_conflicts <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: conflicting product bundle foreign-key name';
    END IF;

    SELECT COUNT(*) INTO v_conflicts FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'print_queue'
           AND INDEX_NAME IN (
               'uq_print_queue_idempotency', 'idx_print_queue_claim', 'idx_print_queue_state_locked',
               'idx_print_queue_state_created', 'idx_print_queue_reprint_of'
           )
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) <> CASE INDEX_NAME
            WHEN 'uq_print_queue_idempotency' THEN 'idempotency_key'
            WHEN 'idx_print_queue_claim' THEN 'status,locked_until,id'
            WHEN 'idx_print_queue_state_locked' THEN 'status,locked_until'
            WHEN 'idx_print_queue_state_created' THEN 'status,created_at'
            WHEN 'idx_print_queue_reprint_of' THEN 'reprint_of_queue_id'
        END
           OR (INDEX_NAME = 'uq_print_queue_idempotency' AND MIN(NON_UNIQUE) <> 0)
    ) conflicting_indexes;
    IF v_conflicts <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: conflicting print queue index name';
    END IF;

    -- These are catalog definitions whose parent/component product no longer exists.
    -- Historical order rows are not touched.
    DELETE definition
      FROM product_bundle_items definition
      LEFT JOIN products bundle ON bundle.id = definition.bundle_id
      LEFT JOIN products component ON component.id = definition.product_id
     WHERE bundle.id IS NULL OR component.id IS NULL;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'product_bundle_items'
       AND CONSTRAINT_NAME = 'fk_pbi_bundle'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY';
    IF v_count = 0 THEN
        ALTER TABLE product_bundle_items
            ADD CONSTRAINT fk_pbi_bundle FOREIGN KEY (bundle_id) REFERENCES products (id) ON DELETE CASCADE;
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'product_bundle_items'
       AND CONSTRAINT_NAME = 'fk_pbi_product'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY';
    IF v_count = 0 THEN
        ALTER TABLE product_bundle_items
            ADD CONSTRAINT fk_pbi_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT;
    END IF;

    ALTER TABLE print_queue
        MODIFY status enum('pending','processing','sent','acknowledged','failed','dead_letter','canceled') NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS idempotency_key varchar(160) DEFAULT NULL AFTER id,
        ADD COLUMN IF NOT EXISTS payload_hash char(64) DEFAULT NULL AFTER payload,
        ADD COLUMN IF NOT EXISTS printer_id varchar(128) DEFAULT NULL AFTER payload_hash,
        ADD COLUMN IF NOT EXISTS print_type varchar(64) DEFAULT NULL AFTER printer_id,
        ADD COLUMN IF NOT EXISTS claimed_by varchar(128) DEFAULT NULL AFTER status,
        ADD COLUMN IF NOT EXISTS locked_until datetime DEFAULT NULL AFTER claimed_by,
        ADD COLUMN IF NOT EXISTS attempts int(11) NOT NULL DEFAULT 0 AFTER locked_until,
        ADD COLUMN IF NOT EXISTS last_error text DEFAULT NULL AFTER attempts,
        ADD COLUMN IF NOT EXISTS spooler_id varchar(128) DEFAULT NULL AFTER claimed_by,
        ADD COLUMN IF NOT EXISTS spooler_version varchar(64) DEFAULT NULL AFTER spooler_id,
        ADD COLUMN IF NOT EXISTS max_attempts int(11) NOT NULL DEFAULT 5 AFTER attempts,
        ADD COLUMN IF NOT EXISTS first_attempt_at datetime DEFAULT NULL AFTER max_attempts,
        ADD COLUMN IF NOT EXISTS device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown' AFTER last_error,
        ADD COLUMN IF NOT EXISTS sent_at datetime DEFAULT NULL AFTER first_attempt_at,
        ADD COLUMN IF NOT EXISTS acknowledged_at datetime DEFAULT NULL AFTER sent_at,
        ADD COLUMN IF NOT EXISTS duration_ms int(11) DEFAULT NULL AFTER acknowledged_at,
        ADD COLUMN IF NOT EXISTS next_retry_at datetime DEFAULT NULL AFTER duration_ms,
        ADD COLUMN IF NOT EXISTS reprint_of_queue_id bigint(20) DEFAULT NULL AFTER next_retry_at,
        ADD COLUMN IF NOT EXISTS last_seen_at datetime DEFAULT NULL AFTER reprint_of_queue_id,
        ADD UNIQUE KEY IF NOT EXISTS uq_print_queue_idempotency (idempotency_key),
        ADD KEY IF NOT EXISTS idx_print_queue_claim (status, locked_until, id),
        ADD KEY IF NOT EXISTS idx_print_queue_state_locked (status, locked_until),
        ADD KEY IF NOT EXISTS idx_print_queue_state_created (status, created_at),
        ADD KEY IF NOT EXISTS idx_print_queue_reprint_of (reprint_of_queue_id);

    ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS status_capability enum('write_only','escpos_status','snmp_status') NOT NULL DEFAULT 'write_only' AFTER is_active,
        ADD COLUMN IF NOT EXISTS device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown' AFTER status_capability,
        ADD COLUMN IF NOT EXISTS status_checked_at datetime DEFAULT NULL AFTER device_status,
        ADD COLUMN IF NOT EXISTS status_source varchar(32) DEFAULT NULL AFTER status_checked_at;

    SELECT COUNT(*) INTO v_count FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'print_queue'
           AND INDEX_NAME = 'idx_print_queue_status_created'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'status,created_at'
    ) duplicate_index;
    IF v_count = 1 THEN
        ALTER TABLE print_queue DROP INDEX idx_print_queue_status_created;
    END IF;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES (
        '2026-07-18-erp-foundation-v1',
        'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8'
    );
END$$

CALL `_ps_20260718_erp_foundation`()$$
DROP PROCEDURE `_ps_20260718_erp_foundation`$$

DELIMITER ;
