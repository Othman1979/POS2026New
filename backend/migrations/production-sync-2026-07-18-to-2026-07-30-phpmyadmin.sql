-- POSAPP consolidated phpMyAdmin migration rollup.
-- Scope: every apply migration dated 2026-07-18 through 2026-07-30.
-- Generated from the canonical files in backend/migrations; preflight and verify
-- companions are intentionally excluded because they do not change the schema.
--
-- Usage:
--   1. Back up the selected database.
--   2. Select that database in phpMyAdmin.
--   3. Import this complete file once through the Import tab.
--   4. Read the final result table. A "skipped_sql_error" row means that section
--      failed but later sections were still attempted; inspect it before production use.
--
-- Fully applied ledger-backed migrations are harmless no-ops. Direct migrations
-- use IF NOT EXISTS / upserts and are safe to rerun against the intended schema.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_rollup_require_database`$$
CREATE PROCEDURE `_ps_rollup_require_database`()
BEGIN
    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'STOP: select the POSAPP database before importing this file';
    END IF;
END$$
CALL `_ps_rollup_require_database`()$$
DROP PROCEDURE `_ps_rollup_require_database`$$

DELIMITER ;


-- ============================================================================
-- SOURCE: backend/migrations/2026-07-18-add-users-xyz-audit-bypass.sql
-- ============================================================================
SET @rollup_users_xyz = 'completed_or_already_applied';

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_rollup_users_xyz`$$
CREATE PROCEDURE `_ps_rollup_users_xyz`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_users_xyz = 'skipped_sql_error';

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS xyz TINYINT(1) NOT NULL DEFAULT 0
      COMMENT 'When 1, actions by this user are not written to audit_events';
END$$
CALL `_ps_rollup_users_xyz`()$$
DROP PROCEDURE `_ps_rollup_users_xyz`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-18-erp-foundation.sql
-- ============================================================================
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

SET @rollup_erp_foundation = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_erp_foundation`$$
CREATE PROCEDURE `_ps_rollup_erp_foundation`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_erp_foundation = 'skipped_sql_error';
    CALL `_ps_20260718_erp_foundation`();
END$$
CALL `_ps_rollup_erp_foundation`()$$
DROP PROCEDURE `_ps_rollup_erp_foundation`$$
DROP PROCEDURE `_ps_20260718_erp_foundation`$$

DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-18-expenses.sql
-- ============================================================================
SET @rollup_expenses = 'completed_or_already_applied';

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_rollup_expenses`$$
CREATE PROCEDURE `_ps_rollup_expenses`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_expenses = 'skipped_sql_error';

    CREATE TABLE IF NOT EXISTS expense_categories (
      id         INT NOT NULL AUTO_INCREMENT,
      name       VARCHAR(120) NOT NULL,
      is_active  TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_by INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_expense_categories_name (name),
      KEY idx_expense_categories_active_sort (is_active, sort_order, id),
      CONSTRAINT fk_expense_categories_user FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS expenses (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      category_id INT NOT NULL,
      amount      DECIMAL(10,2) NOT NULL,
      source      VARCHAR(16) NOT NULL,
      shift_id    INT DEFAULT NULL,
      note        VARCHAR(255) NOT NULL DEFAULT '',
      status      VARCHAR(16) NOT NULL DEFAULT 'active',
      created_by  INT NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      canceled_by INT DEFAULT NULL,
      canceled_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_expenses_created_status (created_at, status),
      KEY idx_expenses_shift_status (shift_id, status),
      KEY idx_expenses_category_created (category_id, created_at),
      KEY idx_expenses_created_by (created_by),
      CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories(id),
      CONSTRAINT fk_expenses_shift FOREIGN KEY (shift_id) REFERENCES shifts(id),
      CONSTRAINT fk_expenses_created_by FOREIGN KEY (created_by) REFERENCES users(id),
      CONSTRAINT fk_expenses_canceled_by FOREIGN KEY (canceled_by) REFERENCES users(id),
      CONSTRAINT chk_expenses_amount CHECK (amount > 0),
      CONSTRAINT chk_expenses_source CHECK (source IN ('drawer', 'outside')),
      CONSTRAINT chk_expenses_status CHECK (status IN ('active', 'canceled')),
      CONSTRAINT chk_expenses_drawer_shift CHECK (
        (source = 'drawer' AND shift_id IS NOT NULL) OR
        (source = 'outside' AND shift_id IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    INSERT INTO permissions
      (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
    VALUES
      ('pos.expenses', 'Record Expenses', 'تسجيل المصروفات',
       'Record an expense from the user''s open cash shift.',
       'تسجيل مصروف من وردية الصندوق المفتوحة للمستخدم.',
       'pos', 95, 1, 0, 0)
    ON DUPLICATE KEY UPDATE
      label = VALUES(label), label_ar = VALUES(label_ar),
      description = VALUES(description), description_ar = VALUES(description_ar),
      category = VALUES(category), sort_order = VALUES(sort_order),
      implemented = VALUES(implemented), default_cashier = VALUES(default_cashier),
      overridable = VALUES(overridable);
END$$
CALL `_ps_rollup_expenses`()$$
DROP PROCEDURE `_ps_rollup_expenses`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-18-foundation-final-hygiene.sql
-- ============================================================================
-- Final foundation hygiene migration (phpMyAdmin-safe).
-- Run the matching preflight first and require blocking_findings = 0.
-- Import this whole file, then run the matching verify file.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260718_foundation_hygiene`$$
CREATE PROCEDURE `_ps_20260718_foundation_hygiene`()
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
       AND TABLE_NAME IN ('products', 'qr_table_drafts', 'restaurant_tables', 'schema_migrations');
    IF v_count <> 4 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required POS tables are missing';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM schema_migrations
     WHERE migration_name = '2026-07-18-erp-foundation-v1'
       AND checksum = 'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8';
    IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: ERP foundation migration must be applied first';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-18-foundation-final-hygiene-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021' THEN
        LEAVE migration;
    END IF;

    SELECT COUNT(*) INTO v_conflicts FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'qr_table_drafts'
           AND INDEX_NAME = 'idx_qr_drafts_table'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) <> 'table_id'
           OR MIN(NON_UNIQUE) <> 0
    ) conflicts;
    IF v_conflicts <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: conflicting qr draft index name';
    END IF;

    SELECT COUNT(*) INTO v_conflicts FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'restaurant_tables'
           AND INDEX_NAME = 'section_id'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) <> 'section_id,table_number'
           OR MIN(NON_UNIQUE) <> 0
    ) conflicts;
    IF v_conflicts <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: conflicting restaurant table index name';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'qr_table_drafts'
       AND INDEX_NAME = 'idx_qr_drafts_table';
    IF v_count > 0 THEN
        ALTER TABLE qr_table_drafts DROP INDEX idx_qr_drafts_table;
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'restaurant_tables'
       AND INDEX_NAME = 'section_id';
    IF v_count > 0 THEN
        ALTER TABLE restaurant_tables DROP INDEX section_id;
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'products'
       AND COLUMN_NAME = 'warehouse_id';
    IF v_count = 1 THEN
        ALTER TABLE products DROP COLUMN warehouse_id;
    END IF;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES (
        '2026-07-18-foundation-final-hygiene-v1',
        'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021'
    );
END$$

SET @rollup_foundation_hygiene = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_foundation_hygiene`$$
CREATE PROCEDURE `_ps_rollup_foundation_hygiene`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_foundation_hygiene = 'skipped_sql_error';
    CALL `_ps_20260718_foundation_hygiene`();
END$$
CALL `_ps_rollup_foundation_hygiene`()$$
DROP PROCEDURE `_ps_rollup_foundation_hygiene`$$
DROP PROCEDURE `_ps_20260718_foundation_hygiene`$$

DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-19-multi-spooler-printer-ownership.sql
-- ============================================================================
-- Multi-spooler printer ownership migration (phpMyAdmin-safe).
-- Existing printers remain on the "primary" print station.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260719_multi_spooler`$$
CREATE PROCEDURE `_ps_20260719_multi_spooler`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('printers', 'print_queue', 'schema_migrations');
    IF v_count <> 3 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required printer tables are missing';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM schema_migrations
     WHERE migration_name = '2026-07-18-foundation-final-hygiene-v1'
       AND checksum = 'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021';
    IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: foundation hygiene migration must be applied first';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-19-multi-spooler-printer-ownership-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS spooler_id varchar(96) NOT NULL DEFAULT 'primary' AFTER assigned_ips;

    SELECT COUNT(*) INTO v_count FROM (
        SELECT CASE
            WHEN type = 'network' THEN CONCAT(role, ':network:', LOWER(TRIM(network_ip)), ':', COALESCE(NULLIF(TRIM(network_port), ''), '9100'))
            ELSE CONCAT(role, ':windows:', LOWER(TRIM(spooler_id)), ':', LOWER(TRIM(windows_name)))
        END AS endpoint_key
          FROM printers
         WHERE is_active = 1
         GROUP BY endpoint_key
        HAVING COUNT(*) > 1
    ) duplicate_endpoints;
    IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: duplicate active physical printer endpoints require correction';
    END IF;

    ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS active_endpoint_key varchar(255)
            AS (CASE
                WHEN is_active = 1 AND type = 'network'
                    THEN CONCAT(role, ':network:', LOWER(TRIM(network_ip)), ':', COALESCE(NULLIF(TRIM(network_port), ''), '9100'))
                WHEN is_active = 1 AND type = 'windows'
                    THEN CONCAT(role, ':windows:', LOWER(TRIM(spooler_id)), ':', LOWER(TRIM(windows_name)))
                ELSE NULL
            END) PERSISTENT;

    ALTER TABLE printers
        ADD KEY IF NOT EXISTS idx_printers_spooler (spooler_id, is_active, id),
        ADD UNIQUE KEY IF NOT EXISTS uq_printers_active_endpoint (active_endpoint_key);

    -- Old queue rows used printer names/IPs. Preserve uniquely mappable rows and
    -- null only unmatched historical identities; the original JSON payload remains.
    UPDATE print_queue q
       SET q.printer_id = (
            SELECT CASE WHEN COUNT(DISTINCT p.id) = 1 THEN MIN(p.id) ELSE NULL END
              FROM printers p
             WHERE q.printer_id = p.name
                OR q.printer_id = p.windows_name
                OR q.printer_id = p.network_ip
       )
     WHERE q.printer_id IS NOT NULL
       AND q.printer_id NOT REGEXP '^[0-9]+$';

    UPDATE print_queue q
    LEFT JOIN printers p ON p.id = CAST(q.printer_id AS UNSIGNED)
       SET q.printer_id = NULL
     WHERE q.printer_id IS NOT NULL
       AND p.id IS NULL;

    ALTER TABLE print_queue
        MODIFY printer_id int(11) DEFAULT NULL,
        ADD KEY IF NOT EXISTS idx_print_queue_owner_claim (printer_id, status, locked_until, id);

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES (
        '2026-07-19-multi-spooler-printer-ownership-v1',
        '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d'
    );
END$$

SET @rollup_multi_spooler = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_multi_spooler`$$
CREATE PROCEDURE `_ps_rollup_multi_spooler`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_multi_spooler = 'skipped_sql_error';
    CALL `_ps_20260719_multi_spooler`();
END$$
CALL `_ps_rollup_multi_spooler`()$$
DROP PROCEDURE `_ps_rollup_multi_spooler`$$
DROP PROCEDURE `_ps_20260719_multi_spooler`$$

DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-19-product-availability.sql
-- ============================================================================
SET @rollup_product_availability = 'completed_or_already_applied';

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_rollup_product_availability`$$
CREATE PROCEDURE `_ps_rollup_product_availability`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_product_availability = 'skipped_sql_error';

    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS is_available TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active;

    INSERT INTO permissions
      (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
    VALUES
      ('pos.product_availability', 'Manage Product Availability', 'إدارة توفر الأصناف',
       'Mark products as sold out or return them to sale.',
       'إيقاف بيع الأصناف النافدة أو إعادتها للبيع.',
       'pos', 97, 1, 0, 0)
    ON DUPLICATE KEY UPDATE
      label = VALUES(label),
      label_ar = VALUES(label_ar),
      description = VALUES(description),
      description_ar = VALUES(description_ar),
      category = VALUES(category),
      sort_order = VALUES(sort_order),
      implemented = VALUES(implemented),
      default_cashier = VALUES(default_cashier),
      overridable = VALUES(overridable);
END$$
CALL `_ps_rollup_product_availability`()$$
DROP PROCEDURE `_ps_rollup_product_availability`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-21-jofotara-documents.sql
-- ============================================================================
SET @rollup_jofotara_documents = 'completed_or_already_applied';

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_rollup_jofotara_documents`$$
CREATE PROCEDURE `_ps_rollup_jofotara_documents`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_jofotara_documents = 'skipped_sql_error';

    CREATE TABLE IF NOT EXISTS jofotara_documents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      source_key VARCHAR(96) NOT NULL,
      order_invoice_id INT NOT NULL,
      refund_id INT NULL,
      original_document_id BIGINT UNSIGNED NULL,
      document_kind ENUM('invoice','credit_note') NOT NULL,
      document_number VARCHAR(96) NOT NULL,
      document_uuid CHAR(36) NOT NULL,
      status ENUM('pending','submitting','accepted','rejected','unknown') NOT NULL DEFAULT 'pending',
      legal_snapshot_json LONGTEXT NULL,
      request_xml LONGTEXT NULL,
      qr_text LONGTEXT NULL,
      response_body LONGTEXT NULL,
      http_status SMALLINT UNSIGNED NULL,
      attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      submitted_by_user_id INT NULL,
      last_attempt_at DATETIME NULL,
      accepted_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_jofotara_source (source_key),
      UNIQUE KEY uq_jofotara_uuid (document_uuid),
      UNIQUE KEY uq_jofotara_number (document_number),
      KEY idx_jofotara_order (order_invoice_id, status),
      CONSTRAINT fk_jofotara_order FOREIGN KEY (order_invoice_id) REFERENCES orders(invoice_id),
      CONSTRAINT fk_jofotara_refund FOREIGN KEY (refund_id) REFERENCES refunds(id),
      CONSTRAINT fk_jofotara_original FOREIGN KEY (original_document_id) REFERENCES jofotara_documents(id),
      CONSTRAINT fk_jofotara_user FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    INSERT INTO settings (setting_key, setting_value) VALUES
    ('jofotara_enabled', '0'),
    ('jofotara_client_id', ''),
    ('jofotara_secret_key', ''),
    ('jofotara_income_source_sequence', ''),
    ('jofotara_seller_tax_number', ''),
    ('jofotara_seller_registered_name', '')
    ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);
END$$
CALL `_ps_rollup_jofotara_documents`()$$
DROP PROCEDURE `_ps_rollup_jofotara_documents`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-21-jofotara-income-tax-profile.sql
-- ============================================================================
SET @rollup_jofotara_tax_profiles = 'completed_or_already_applied';

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_rollup_jofotara_tax_profiles`$$
CREATE PROCEDURE `_ps_rollup_jofotara_tax_profiles`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_jofotara_tax_profiles = 'skipped_sql_error';

    -- Adds immutable tax-registration profile snapshots and isolates JoFotara credentials.
    -- Safe to rerun: guarded DDL, explicit backfills, and non-destructive scoped upserts.

    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS tax_registration_type_at_sale ENUM('sales_tax','income_tax') NULL
      AFTER tax_inclusive_at_sale;

    UPDATE orders
       SET tax_registration_type_at_sale = 'sales_tax'
     WHERE tax_registration_type_at_sale IS NULL;

    ALTER TABLE orders
      MODIFY COLUMN tax_registration_type_at_sale ENUM('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax';

    ALTER TABLE jofotara_documents
      ADD COLUMN IF NOT EXISTS tax_registration_type ENUM('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax'
      AFTER document_kind;

    UPDATE jofotara_documents
       SET tax_registration_type = 'sales_tax'
     WHERE tax_registration_type IS NULL;

    INSERT INTO settings (setting_key, setting_value)
    SELECT 'jofotara_sales_tax_client_id', legacy.setting_value
      FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_client_id') legacy
    ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

    INSERT INTO settings (setting_key, setting_value)
    SELECT 'jofotara_sales_tax_secret_key', legacy.setting_value
      FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_secret_key') legacy
    ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

    INSERT INTO settings (setting_key, setting_value)
    SELECT 'jofotara_sales_tax_income_source_sequence', legacy.setting_value
      FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_income_source_sequence') legacy
    ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

    INSERT INTO settings (setting_key, setting_value)
    SELECT 'jofotara_sales_tax_seller_tax_number', legacy.setting_value
      FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_seller_tax_number') legacy
    ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

    INSERT INTO settings (setting_key, setting_value)
    SELECT 'jofotara_sales_tax_seller_registered_name', legacy.setting_value
      FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_seller_registered_name') legacy
    ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

    INSERT INTO settings (setting_key, setting_value) VALUES
      ('tax_registration_type', 'sales_tax'),
      ('jofotara_sales_tax_client_id', ''),
      ('jofotara_sales_tax_secret_key', ''),
      ('jofotara_sales_tax_income_source_sequence', ''),
      ('jofotara_sales_tax_seller_tax_number', ''),
      ('jofotara_sales_tax_seller_registered_name', ''),
      ('jofotara_income_tax_client_id', ''),
      ('jofotara_income_tax_secret_key', ''),
      ('jofotara_income_tax_income_source_sequence', ''),
      ('jofotara_income_tax_seller_tax_number', ''),
      ('jofotara_income_tax_seller_registered_name', '')
    ON DUPLICATE KEY UPDATE setting_value = setting_value;

    DELETE FROM settings
     WHERE setting_key IN (
        'jofotara_client_id',
        'jofotara_secret_key',
        'jofotara_income_source_sequence',
        'jofotara_seller_tax_number',
        'jofotara_seller_registered_name'
     );
END$$
CALL `_ps_rollup_jofotara_tax_profiles`()$$
DROP PROCEDURE `_ps_rollup_jofotara_tax_profiles`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-21-modifier-inclusive-tax.sql
-- ============================================================================
SET @rollup_modifier_inclusive_tax = 'completed_or_already_applied';

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_rollup_modifier_inclusive_tax`$$
CREATE PROCEDURE `_ps_rollup_modifier_inclusive_tax`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_modifier_inclusive_tax = 'skipped_sql_error';

    ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS modifier_tax_amount DECIMAL(10,6) DEFAULT NULL
      AFTER modifier_surcharge;
END$$
CALL `_ps_rollup_modifier_inclusive_tax`()$$
DROP PROCEDURE `_ps_rollup_modifier_inclusive_tax`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-22-category-owned-price-lists.sql
-- ============================================================================
-- Category-owned price lists migration (phpMyAdmin-safe).
-- Import the whole file, then run the paired read-only verifier.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260722_category_price_lists`$$
CREATE PROCEDURE `_ps_20260722_category_price_lists`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('categories', 'products');
    IF v_count <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required category and product tables are missing';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-22-category-owned-price-lists-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE categories
        ADD COLUMN IF NOT EXISTS price_list_root_id int(11) DEFAULT NULL AFTER is_notes;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'categories'
       AND COLUMN_NAME = 'price_list_root_id'
       AND DATA_TYPE = 'int'
       AND IS_NULLABLE = 'YES';
    IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: categories.price_list_root_id conflicts with the required nullable integer column';
    END IF;

    SELECT COUNT(*) INTO v_count FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'categories'
           AND INDEX_NAME = 'idx_categories_price_list_tree'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'price_list_root_id,is_active,id'
    ) required_index;
    IF v_count = 0 THEN
        SELECT COUNT(*) INTO v_count
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'categories'
           AND INDEX_NAME = 'idx_categories_price_list_tree';
        IF v_count > 0 THEN
            ALTER TABLE categories DROP INDEX idx_categories_price_list_tree;
        END IF;
        ALTER TABLE categories
            ADD KEY idx_categories_price_list_tree (price_list_root_id, is_active, id);
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       AND kcu.TABLE_NAME = rc.TABLE_NAME
       AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
     WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
       AND rc.TABLE_NAME = 'categories'
       AND rc.CONSTRAINT_NAME = 'fk_categories_price_list_root'
       AND kcu.COLUMN_NAME = 'price_list_root_id'
       AND kcu.REFERENCED_TABLE_NAME = 'categories'
       AND kcu.REFERENCED_COLUMN_NAME = 'id'
       AND rc.DELETE_RULE = 'SET NULL';
    IF v_count = 0 THEN
        SELECT COUNT(*) INTO v_count
          FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND TABLE_NAME = 'categories'
           AND CONSTRAINT_NAME = 'fk_categories_price_list_root';
        IF v_count > 0 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: conflicting category price-list foreign-key name';
        END IF;
        ALTER TABLE categories
            ADD CONSTRAINT fk_categories_price_list_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE SET NULL;
    END IF;

    CREATE TABLE IF NOT EXISTS product_price_overrides (
        price_list_root_id int(11) NOT NULL,
        product_id int(11) NOT NULL,
        price decimal(10,6) NOT NULL,
        updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
        PRIMARY KEY (price_list_root_id, product_id),
        CONSTRAINT fk_product_price_overrides_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE CASCADE,
        CONSTRAINT fk_product_price_overrides_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
        CONSTRAINT chk_product_price_overrides_nonnegative CHECK (price >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES (
        '2026-07-22-category-owned-price-lists-v1',
        'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb'
    );
END$$

SET @rollup_category_price_lists = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_category_price_lists`$$
CREATE PROCEDURE `_ps_rollup_category_price_lists`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_category_price_lists = 'skipped_sql_error';
    CALL `_ps_20260722_category_price_lists`();
END$$
CALL `_ps_rollup_category_price_lists`()$$
DROP PROCEDURE `_ps_rollup_category_price_lists`$$
DROP PROCEDURE `_ps_20260722_category_price_lists`$$

DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-22-customer-meal-subscriptions.sql
-- ============================================================================
-- Customer meal subscriptions (phpMyAdmin-safe).
-- Import the whole file, then run the paired read-only verifier.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260722_customer_meal_subscriptions`$$
CREATE PROCEDURE `_ps_20260722_customer_meal_subscriptions`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('products', 'users', 'customers', 'orders', 'shifts', 'permissions', 'user_permissions');
    IF v_count <> 7 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required POS tables are missing';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-22-customer-meal-subscriptions-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'dab2c93b0761f3c3793bb53e0b4314b8beb15f51f72a07c6b65b1dd82424d754' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'dab2c93b0761f3c3793bb53e0b4314b8beb15f51f72a07c6b65b1dd82424d754' THEN
        LEAVE migration;
    END IF;

    CREATE TABLE IF NOT EXISTS subscription_plans (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        sale_product_id INT NOT NULL,
        included_credits SMALLINT UNSIGNED NOT NULL,
        duration_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_subscription_plans_sale_product (sale_product_id),
        KEY idx_subscription_plans_active (is_active, id),
        CONSTRAINT fk_subscription_plans_sale_product FOREIGN KEY (sale_product_id) REFERENCES products(id) ON DELETE RESTRICT,
        CONSTRAINT fk_subscription_plans_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_subscription_plans_credits CHECK (included_credits > 0),
        CONSTRAINT chk_subscription_plans_duration CHECK (duration_days > 0),
        CONSTRAINT chk_subscription_plans_active CHECK (is_active IN (0,1))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS subscription_plan_products (
        plan_id BIGINT UNSIGNED NOT NULL,
        product_id INT NOT NULL,
        PRIMARY KEY (plan_id, product_id),
        KEY idx_subscription_plan_products_product (product_id, plan_id),
        CONSTRAINT fk_subscription_plan_products_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
        CONSTRAINT fk_subscription_plan_products_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        customer_id INT NOT NULL,
        plan_id BIGINT UNSIGNED NOT NULL,
        purchase_invoice_id INT NOT NULL,
        starts_on DATE NOT NULL,
        ends_on DATE NOT NULL,
        total_credits SMALLINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        cancelled_at DATETIME NULL,
        cancelled_by INT NULL,
        cancellation_reason VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_subscriptions_invoice (purchase_invoice_id),
        KEY idx_customer_subscriptions_customer_state (customer_id, status, ends_on, id),
        KEY idx_customer_subscriptions_state_end (status, ends_on, id),
        CONSTRAINT fk_customer_subscriptions_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_subscriptions_invoice FOREIGN KEY (purchase_invoice_id) REFERENCES orders(invoice_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_subscriptions_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_customer_subscriptions_dates CHECK (ends_on >= starts_on),
        CONSTRAINT chk_customer_subscriptions_credits CHECK (total_credits > 0),
        CONSTRAINT chk_customer_subscriptions_status CHECK (status IN ('active','cancelled','refunded'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS customer_subscription_products (
        subscription_id BIGINT UNSIGNED NOT NULL,
        product_id INT NOT NULL,
        PRIMARY KEY (subscription_id, product_id),
        KEY idx_customer_subscription_products_product (product_id, subscription_id),
        CONSTRAINT fk_customer_subscription_products_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
        CONSTRAINT fk_customer_subscription_products_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS subscription_extensions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        subscription_id BIGINT UNSIGNED NOT NULL,
        old_ends_on DATE NOT NULL,
        new_ends_on DATE NOT NULL,
        reason VARCHAR(255) NOT NULL,
        extended_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_subscription_extensions_subscription (subscription_id, id),
        CONSTRAINT fk_subscription_extensions_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE RESTRICT,
        CONSTRAINT fk_subscription_extensions_extended_by FOREIGN KEY (extended_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_subscription_extensions_dates CHECK (new_ends_on > old_ends_on),
        CONSTRAINT chk_subscription_extensions_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS subscription_redemptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        subscription_id BIGINT UNSIGNED NOT NULL,
        redeemed_by INT NULL,
        shift_id INT NULL,
        business_date DATE NOT NULL,
        additional_meal_reason VARCHAR(255) NULL,
        stock_deducted TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        reversed_at DATETIME NULL,
        reversed_by INT NULL,
        reversal_reason VARCHAR(255) NULL,
        idempotency_key VARCHAR(80) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_subscription_redemptions_idempotency (idempotency_key),
        KEY idx_subscription_redemptions_balance (subscription_id, status, id),
        KEY idx_subscription_redemptions_business_date (business_date, status, id),
        KEY idx_subscription_redemptions_shift (shift_id, business_date, id),
        CONSTRAINT fk_subscription_redemptions_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE RESTRICT,
        CONSTRAINT fk_subscription_redemptions_redeemed_by FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_subscription_redemptions_shift FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
        CONSTRAINT fk_subscription_redemptions_reversed_by FOREIGN KEY (reversed_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_subscription_redemptions_status CHECK (status IN ('active','reversed')),
        CONSTRAINT chk_subscription_redemptions_stock CHECK (stock_deducted IN (0,1))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS subscription_redemption_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        redemption_id BIGINT UNSIGNED NOT NULL,
        product_id INT NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        quantity SMALLINT UNSIGNED NOT NULL,
        note TEXT NULL,
        selected_modifiers LONGTEXT NULL,
        bundle_items LONGTEXT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        KEY idx_subscription_redemption_items_redemption (redemption_id, sort_order, id),
        KEY idx_subscription_redemption_items_product (product_id, redemption_id),
        CONSTRAINT fk_subscription_redemption_items_redemption FOREIGN KEY (redemption_id) REFERENCES subscription_redemptions(id) ON DELETE CASCADE,
        CONSTRAINT fk_subscription_redemption_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        CONSTRAINT chk_subscription_redemption_items_quantity CHECK (quantity > 0),
        CONSTRAINT chk_subscription_redemption_items_modifiers_json CHECK (selected_modifiers IS NULL OR JSON_VALID(selected_modifiers)),
        CONSTRAINT chk_subscription_redemption_items_bundle_json CHECK (bundle_items IS NULL OR JSON_VALID(bundle_items))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (
          'subscription_plans', 'subscription_plan_products', 'customer_subscriptions',
          'customer_subscription_products', 'subscription_extensions',
          'subscription_redemptions', 'subscription_redemption_items'
       );
    IF v_count <> 7 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: subscription table creation failed or conflicts with an existing schema';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
       AND kcu.CONSTRAINT_NAME IN (
          'fk_subscription_plans_sale_product', 'fk_subscription_plans_created_by',
          'fk_subscription_plan_products_plan', 'fk_subscription_plan_products_product',
          'fk_customer_subscriptions_customer', 'fk_customer_subscriptions_plan',
          'fk_customer_subscriptions_invoice', 'fk_customer_subscriptions_cancelled_by',
          'fk_customer_subscription_products_subscription', 'fk_customer_subscription_products_product',
          'fk_subscription_extensions_subscription', 'fk_subscription_extensions_extended_by',
          'fk_subscription_redemptions_subscription', 'fk_subscription_redemptions_redeemed_by',
          'fk_subscription_redemptions_shift', 'fk_subscription_redemptions_reversed_by',
          'fk_subscription_redemption_items_redemption', 'fk_subscription_redemption_items_product'
       );
    IF v_count <> 18 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: subscription foreign-key schema conflicts with the required structure';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND (
       (TABLE_NAME='subscription_plans' AND COLUMN_NAME IN ('id','sale_product_id','included_credits','duration_days','is_active','created_by','created_at','updated_at')) OR
       (TABLE_NAME='subscription_plan_products' AND COLUMN_NAME IN ('plan_id','product_id')) OR
       (TABLE_NAME='customer_subscriptions' AND COLUMN_NAME IN ('id','customer_id','plan_id','purchase_invoice_id','starts_on','ends_on','total_credits','status','cancelled_at','cancelled_by','cancellation_reason','created_at')) OR
       (TABLE_NAME='customer_subscription_products' AND COLUMN_NAME IN ('subscription_id','product_id')) OR
       (TABLE_NAME='subscription_extensions' AND COLUMN_NAME IN ('id','subscription_id','old_ends_on','new_ends_on','reason','extended_by','created_at')) OR
       (TABLE_NAME='subscription_redemptions' AND COLUMN_NAME IN ('id','subscription_id','redeemed_by','shift_id','business_date','additional_meal_reason','stock_deducted','status','reversed_at','reversed_by','reversal_reason','idempotency_key','created_at')) OR
       (TABLE_NAME='subscription_redemption_items' AND COLUMN_NAME IN ('id','redemption_id','product_id','item_name','quantity','note','selected_modifiers','bundle_items','sort_order'))
     );
    IF v_count <> 53 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: subscription columns conflict with the required structure';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='PRIMARY KEY'
       AND TABLE_NAME IN (
         'subscription_plans', 'subscription_plan_products', 'customer_subscriptions',
         'customer_subscription_products', 'subscription_extensions',
         'subscription_redemptions', 'subscription_redemption_items'
       );
    IF v_count <> 7 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: subscription primary keys conflict with the required structure';
    END IF;

    SELECT COUNT(*) INTO v_count FROM (
      SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME IN (
         'uq_subscription_plans_sale_product','idx_subscription_plans_active',
         'idx_subscription_plan_products_product','uq_customer_subscriptions_invoice',
         'idx_customer_subscriptions_customer_state','idx_customer_subscriptions_state_end',
         'idx_subscription_extensions_subscription','uq_subscription_redemptions_idempotency',
         'idx_subscription_redemptions_balance','idx_subscription_redemptions_business_date',
         'idx_subscription_redemptions_shift','idx_subscription_redemption_items_redemption',
         'idx_subscription_redemption_items_product'
       ) GROUP BY INDEX_NAME
    ) required_subscription_indexes;
    IF v_count <> 13 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: subscription indexes conflict with the required structure';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'
       AND CONSTRAINT_NAME IN (
         'chk_subscription_plans_credits','chk_subscription_plans_duration','chk_subscription_plans_active',
         'chk_customer_subscriptions_dates','chk_customer_subscriptions_credits','chk_customer_subscriptions_status',
         'chk_subscription_extensions_dates','chk_subscription_extensions_reason',
         'chk_subscription_redemptions_status','chk_subscription_redemptions_stock',
         'chk_subscription_redemption_items_quantity','chk_subscription_redemption_items_modifiers_json',
         'chk_subscription_redemption_items_bundle_json'
       );
    IF v_count <> 13 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: subscription checks conflict with the required structure';
    END IF;

    INSERT INTO permissions
        (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
    VALUES
        ('pos.subscriptions', 'Manage Subscriptions', 'إدارة الاشتراكات',
         'Sell subscriptions and redeem customer meals.',
         'بيع الاشتراكات وصرف وجبات العملاء.', 'pos', 98, 1, 1, 0)
    ON DUPLICATE KEY UPDATE
        label=VALUES(label), label_ar=VALUES(label_ar),
        description=VALUES(description), description_ar=VALUES(description_ar),
        category=VALUES(category), sort_order=VALUES(sort_order),
        implemented=1, default_cashier=1, overridable=0;

    INSERT IGNORE INTO user_permissions (user_id, perm_key)
    SELECT id, 'pos.subscriptions'
      FROM users
     WHERE is_active=1 AND role='cashier';

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-22-customer-meal-subscriptions-v1', 'dab2c93b0761f3c3793bb53e0b4314b8beb15f51f72a07c6b65b1dd82424d754');
END$$

SET @rollup_meal_subscriptions = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_meal_subscriptions`$$
CREATE PROCEDURE `_ps_rollup_meal_subscriptions`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_meal_subscriptions = 'skipped_sql_error';
    CALL `_ps_20260722_customer_meal_subscriptions`();
END$$
CALL `_ps_rollup_meal_subscriptions`()$$
DROP PROCEDURE `_ps_rollup_meal_subscriptions`$$
DROP PROCEDURE `_ps_20260722_customer_meal_subscriptions`$$

DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-23-admin-manual-subscriptions.sql
-- ============================================================================
-- Admin manual subscriptions (phpMyAdmin-safe).
-- Makes purchase invoices optional only when a required manual reason is stored.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260723_admin_manual_subscriptions`$$
CREATE PROCEDURE `_ps_20260723_admin_manual_subscriptions`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('customer_subscriptions','users');
    IF v_count <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: customer subscription tables are missing';
    END IF;

    SELECT MAX(checksum) INTO v_checksum FROM schema_migrations
     WHERE migration_name='2026-07-23-admin-manual-subscriptions-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE customer_subscriptions MODIFY purchase_invoice_id INT NULL;

    SELECT COUNT(*) INTO v_count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions' AND COLUMN_NAME='created_by';
    IF v_count = 0 THEN
        ALTER TABLE customer_subscriptions ADD COLUMN created_by INT NULL AFTER cancellation_reason;
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions' AND COLUMN_NAME='manual_reason';
    IF v_count = 0 THEN
        ALTER TABLE customer_subscriptions ADD COLUMN manual_reason VARCHAR(255) NULL AFTER created_by;
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions'
       AND CONSTRAINT_NAME='fk_customer_subscriptions_created_by';
    IF v_count = 0 THEN
        ALTER TABLE customer_subscriptions
          ADD CONSTRAINT fk_customer_subscriptions_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions'
       AND CONSTRAINT_NAME='chk_customer_subscriptions_origin';
    IF v_count = 0 THEN
        ALTER TABLE customer_subscriptions
          ADD CONSTRAINT chk_customer_subscriptions_origin CHECK (
            (purchase_invoice_id IS NOT NULL AND manual_reason IS NULL)
            OR (purchase_invoice_id IS NULL AND CHAR_LENGTH(TRIM(manual_reason)) > 0)
          );
    END IF;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-23-admin-manual-subscriptions-v1', 'bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf');
END$$

SET @rollup_manual_subscriptions = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_manual_subscriptions`$$
CREATE PROCEDURE `_ps_rollup_manual_subscriptions`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_manual_subscriptions = 'skipped_sql_error';
    CALL `_ps_20260723_admin_manual_subscriptions`();
END$$
CALL `_ps_rollup_manual_subscriptions`()$$
DROP PROCEDURE `_ps_rollup_manual_subscriptions`$$
DROP PROCEDURE `_ps_20260723_admin_manual_subscriptions`$$

DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-24-jofotara-operations.sql
-- ============================================================================
-- JoFotara operations controls (phpMyAdmin-safe).
SET NAMES utf8mb4;

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260724_jofotara_operations`$$
CREATE PROCEDURE `_ps_20260724_jofotara_operations`()
migration: BEGIN
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT MAX(checksum) INTO v_checksum FROM schema_migrations
     WHERE migration_name='2026-07-24-jofotara-operations-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> '3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum IS NOT NULL THEN LEAVE migration; END IF;

    INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
      ('jofotara_auto_submit', '0'),
      ('jofotara_auto_submit_since', '');

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-24-jofotara-operations-v1', '3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e');
END$$
SET @rollup_jofotara_operations = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_jofotara_operations`$$
CREATE PROCEDURE `_ps_rollup_jofotara_operations`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_jofotara_operations = 'skipped_sql_error';
    CALL `_ps_20260724_jofotara_operations`();
END$$
CALL `_ps_rollup_jofotara_operations`()$$
DROP PROCEDURE `_ps_rollup_jofotara_operations`$$
DROP PROCEDURE IF EXISTS `_ps_20260724_jofotara_operations`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-24-progressive-split-checks.sql
-- ============================================================================
-- Progressive split-check ownership (phpMyAdmin-safe).
SET NAMES utf8mb4;

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260724_progressive_splits`$$
CREATE PROCEDURE `_ps_20260724_progressive_splits`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT MAX(checksum) INTO v_checksum FROM schema_migrations
     WHERE migration_name='2026-07-24-progressive-split-checks-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> '14178039d66459e3b898cd2038e5570df68edd714e31fb4fb9935ce7b765c3c4' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum IS NOT NULL THEN LEAVE migration; END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND COLUMN_NAME='parent_invoice_id';
    IF v_count=0 THEN
        ALTER TABLE held_orders ADD COLUMN parent_invoice_id int(11) DEFAULT NULL AFTER service_charge_snapshot_id;
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND COLUMN_NAME='table_id';
    IF v_count=0 THEN
        ALTER TABLE held_orders ADD COLUMN table_id int(11) DEFAULT NULL AFTER parent_invoice_id;
    END IF;

    UPDATE held_orders
       SET parent_invoice_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(cart_data, '$.parent_invoice_id')) AS UNSIGNED)
     WHERE parent_invoice_id IS NULL
       AND JSON_VALID(cart_data)
       AND JSON_EXTRACT(cart_data, '$.parent_invoice_id') IS NOT NULL;

    UPDATE held_orders h
    JOIN orders o ON o.invoice_id=h.parent_invoice_id
       SET h.table_id=o.table_id
     WHERE h.parent_invoice_id IS NOT NULL AND h.table_id IS NULL;

    SELECT COUNT(*) INTO v_count FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND INDEX_NAME='idx_held_orders_parent_invoice';
    IF v_count=0 THEN
        ALTER TABLE held_orders ADD KEY idx_held_orders_parent_invoice (parent_invoice_id, id);
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND INDEX_NAME='idx_held_orders_split_table';
    IF v_count=0 THEN
        ALTER TABLE held_orders ADD KEY idx_held_orders_split_table (table_id, id);
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND CONSTRAINT_NAME='fk_held_orders_parent_invoice';
    IF v_count=0 THEN
        ALTER TABLE held_orders ADD CONSTRAINT fk_held_orders_parent_invoice
          FOREIGN KEY (parent_invoice_id) REFERENCES orders(invoice_id) ON DELETE RESTRICT;
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND CONSTRAINT_NAME='fk_held_orders_split_table';
    IF v_count=0 THEN
        ALTER TABLE held_orders ADD CONSTRAINT fk_held_orders_split_table
          FOREIGN KEY (table_id) REFERENCES restaurant_tables(id) ON DELETE RESTRICT;
    END IF;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-24-progressive-split-checks-v1', '14178039d66459e3b898cd2038e5570df68edd714e31fb4fb9935ce7b765c3c4');
END$$
SET @rollup_progressive_splits = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_progressive_splits`$$
CREATE PROCEDURE `_ps_rollup_progressive_splits`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_progressive_splits = 'skipped_sql_error';
    CALL `_ps_20260724_progressive_splits`();
END$$
CALL `_ps_rollup_progressive_splits`()$$
DROP PROCEDURE `_ps_rollup_progressive_splits`$$
DROP PROCEDURE IF EXISTS `_ps_20260724_progressive_splits`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-25-print-templates.sql
-- ============================================================================
-- Durable print-template revisions (phpMyAdmin-safe).
-- Run 2026-07-25-print-templates-preflight.sql first and require blocking_findings = 0.
SET NAMES utf8mb4;

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260725_print_templates`$$
CREATE PROCEDURE `_ps_20260725_print_templates`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-25-print-templates-v1';
    IF v_checksum IS NOT NULL
       AND v_checksum <> 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum IS NOT NULL THEN LEAVE migration; END IF;

    CREATE TABLE IF NOT EXISTS print_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      document_type VARCHAR(16) NOT NULL,
      active_revision_id BIGINT UNSIGNED NULL,
      draft_revision_id BIGINT UNSIGNED NULL,
      lock_version INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_print_templates_document_type (document_type),
      CONSTRAINT chk_print_templates_document_type CHECK (document_type IN ('receipt','kitchen'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS print_template_revisions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      template_id BIGINT UNSIGNED NOT NULL,
      revision_no INT UNSIGNED NOT NULL,
      schema_version SMALLINT UNSIGNED NOT NULL,
      definition_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      definition_hash CHAR(64) NOT NULL,
      created_by INT(11) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_compile_error_code VARCHAR(64) NULL,
      last_compile_error_message VARCHAR(500) NULL,
      last_compile_failed_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_print_template_revision_no (template_id, revision_no),
      UNIQUE KEY uq_print_template_revision_hash (template_id, definition_hash),
      KEY idx_print_template_revisions_history (template_id, created_at, id),
      CONSTRAINT fk_print_template_revisions_template FOREIGN KEY (template_id) REFERENCES print_templates(id) ON DELETE RESTRICT,
      CONSTRAINT fk_print_template_revisions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT chk_print_template_revision_no CHECK (revision_no > 0),
      CONSTRAINT chk_print_template_revision_json CHECK (JSON_VALID(definition_json))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE IF NOT EXISTS print_template_revision_tests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      revision_id BIGINT UNSIGNED NOT NULL,
      printer_id INT(11) NULL,
      printer_name VARCHAR(200) NOT NULL,
      printer_endpoint_key VARCHAR(255) NOT NULL,
      queue_id INT(11) NULL,
      spooler_version VARCHAR(64) NOT NULL,
      acknowledged_at DATETIME NOT NULL,
      confirmed_by INT(11) NULL,
      confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_print_template_revision_test_queue (queue_id),
      KEY idx_print_template_tests_revision_printer (revision_id, printer_id, confirmed_at, id),
      CONSTRAINT fk_print_template_tests_revision FOREIGN KEY (revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
      CONSTRAINT fk_print_template_tests_printer FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL,
      CONSTRAINT fk_print_template_tests_queue FOREIGN KEY (queue_id) REFERENCES print_queue(id) ON DELETE SET NULL,
      CONSTRAINT fk_print_template_tests_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='print_templates'
       AND CONSTRAINT_NAME='fk_print_templates_active_revision';
    IF v_count = 0 THEN
        ALTER TABLE print_templates
          ADD CONSTRAINT fk_print_templates_active_revision
            FOREIGN KEY (active_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT;
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='print_templates'
       AND CONSTRAINT_NAME='fk_print_templates_draft_revision';
    IF v_count = 0 THEN
        ALTER TABLE print_templates
          ADD CONSTRAINT fk_print_templates_draft_revision
            FOREIGN KEY (draft_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT;
    END IF;

    INSERT IGNORE INTO print_templates (document_type) VALUES ('receipt'), ('kitchen');

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-25-print-templates-v1', 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07');
END$$
SET @rollup_print_templates = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_print_templates`$$
CREATE PROCEDURE `_ps_rollup_print_templates`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_print_templates = 'skipped_sql_error';
    CALL `_ps_20260725_print_templates`();
END$$
CALL `_ps_rollup_print_templates`()$$
DROP PROCEDURE `_ps_rollup_print_templates`$$
DROP PROCEDURE IF EXISTS `_ps_20260725_print_templates`$$
DELIMITER ;

-- ============================================================================
-- SOURCE: backend/migrations/2026-07-29-subscription-receivables.sql
-- ============================================================================
-- Subscription receivables and append-only collections (phpMyAdmin-safe).

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260729_subscription_receivables`$$
CREATE PROCEDURE `_ps_20260729_subscription_receivables`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME IN ('orders','customer_subscriptions','shifts','users','permissions');
    IF v_count <> 5 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required POS tables are missing';
    END IF;

    SELECT MAX(checksum) INTO v_checksum FROM schema_migrations
     WHERE migration_name='2026-07-29-subscription-receivables-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE orders
      MODIFY payment_method enum('cash','card','split','receivable','unpaid_table','voided') NOT NULL,
      ADD COLUMN IF NOT EXISTS payment_due_on DATE NULL AFTER payment_method,
      ADD COLUMN IF NOT EXISTS receivable_reason VARCHAR(255) NULL AFTER payment_due_on,
      ADD COLUMN IF NOT EXISTS buyer_name_at_sale VARCHAR(100) NULL AFTER receivable_reason,
      ADD COLUMN IF NOT EXISTS buyer_phone_at_sale VARCHAR(20) NULL AFTER buyer_name_at_sale,
      ADD COLUMN IF NOT EXISTS buyer_address_at_sale TEXT NULL AFTER buyer_phone_at_sale,
      ADD INDEX IF NOT EXISTS idx_orders_receivable_due (payment_method, payment_due_on, invoice_id);

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='orders'
       AND CONSTRAINT_NAME='chk_orders_receivable_terms';
    IF v_count = 0 THEN
        ALTER TABLE orders ADD CONSTRAINT chk_orders_receivable_terms CHECK (
          (payment_method='receivable'
            AND payment_due_on IS NOT NULL
            AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
            AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0
            AND COALESCE(cash_amount,0)=0 AND COALESCE(card_amount,0)=0
            AND COALESCE(amount_tendered,0)=0 AND COALESCE(change_due,0)=0)
          OR
          (payment_method<>'receivable'
            AND payment_due_on IS NULL AND receivable_reason IS NULL
            AND buyer_name_at_sale IS NULL AND buyer_phone_at_sale IS NULL
            AND buyer_address_at_sale IS NULL)
        );
    END IF;

    CREATE TABLE IF NOT EXISTS subscription_collections (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      subscription_id BIGINT UNSIGNED NOT NULL,
      shift_id INT NOT NULL,
      received_by INT NOT NULL,
      kind ENUM('collection','reversal') NOT NULL DEFAULT 'collection',
      cash_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      card_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      amount_tendered DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      change_due DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      business_date DATE NOT NULL,
      reverses_collection_id BIGINT UNSIGNED NULL,
      reason VARCHAR(255) NULL,
      idempotency_key VARCHAR(100) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_subscription_collections_idempotency (idempotency_key),
      UNIQUE KEY uq_subscription_collections_reversal (reverses_collection_id),
      KEY idx_subscription_collections_subscription (subscription_id, kind, id),
      KEY idx_subscription_collections_shift (shift_id, business_date, id),
      KEY idx_subscription_collections_date (business_date, kind, id),
      CONSTRAINT fk_subscription_collections_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
      CONSTRAINT fk_subscription_collections_shift FOREIGN KEY (shift_id) REFERENCES shifts(id),
      CONSTRAINT fk_subscription_collections_user FOREIGN KEY (received_by) REFERENCES users(id),
      CONSTRAINT fk_subscription_collections_reversal FOREIGN KEY (reverses_collection_id) REFERENCES subscription_collections(id),
      CONSTRAINT chk_subscription_collections_amount CHECK (
        cash_amount >= 0 AND card_amount >= 0 AND amount_tendered >= 0 AND change_due >= 0
        AND cash_amount + card_amount > 0
        AND ((kind='collection' AND amount_tendered >= cash_amount + card_amount
              AND change_due = amount_tendered - cash_amount - card_amount)
          OR (kind='reversal' AND amount_tendered=0 AND change_due=0))
      ),
      CONSTRAINT chk_subscription_collections_reversal_shape CHECK (
        (kind='collection' AND reverses_collection_id IS NULL)
        OR (kind='reversal' AND reverses_collection_id IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) > 0)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    INSERT INTO settings (setting_key, setting_value)
    VALUES ('subscription_receivables_enabled','0')
    ON DUPLICATE KEY UPDATE setting_value=setting_value;

    INSERT INTO permissions
      (perm_key,label,label_ar,description,description_ar,category,sort_order,implemented,default_cashier,overridable)
    VALUES
      ('pos.subscription_credit','Issue Subscription Credit','منح اشتراك آجل',
       'Issue a subscription as a receivable invoice.','منح اشتراك كفاتورة ذمم آجلة.',
       'pos',99,1,0,1)
    ON DUPLICATE KEY UPDATE implemented=1, default_cashier=0, overridable=1;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-29-subscription-receivables-v1', 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da');
END$$

SET @rollup_subscription_receivables = 'completed_or_already_applied'$$
DROP PROCEDURE IF EXISTS `_ps_rollup_subscription_receivables`$$
CREATE PROCEDURE `_ps_rollup_subscription_receivables`()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        SET @rollup_subscription_receivables = 'skipped_sql_error';
    CALL `_ps_20260729_subscription_receivables`();
END$$
CALL `_ps_rollup_subscription_receivables`()$$
DROP PROCEDURE `_ps_rollup_subscription_receivables`$$
DROP PROCEDURE `_ps_20260729_subscription_receivables`$$

DELIMITER ;

-- Final import summary. Any skipped_sql_error row needs inspection.
SELECT '2026-07-18 users xyz audit bypass' AS migration_section, @rollup_users_xyz AS result
UNION ALL SELECT '2026-07-18 ERP foundation', @rollup_erp_foundation
UNION ALL SELECT '2026-07-18 expenses', @rollup_expenses
UNION ALL SELECT '2026-07-18 foundation hygiene', @rollup_foundation_hygiene
UNION ALL SELECT '2026-07-19 multi-spooler ownership', @rollup_multi_spooler
UNION ALL SELECT '2026-07-19 product availability', @rollup_product_availability
UNION ALL SELECT '2026-07-21 JoFotara documents', @rollup_jofotara_documents
UNION ALL SELECT '2026-07-21 JoFotara tax profiles', @rollup_jofotara_tax_profiles
UNION ALL SELECT '2026-07-21 modifier inclusive tax', @rollup_modifier_inclusive_tax
UNION ALL SELECT '2026-07-22 category price lists', @rollup_category_price_lists
UNION ALL SELECT '2026-07-22 meal subscriptions', @rollup_meal_subscriptions
UNION ALL SELECT '2026-07-23 manual subscriptions', @rollup_manual_subscriptions
UNION ALL SELECT '2026-07-24 JoFotara operations', @rollup_jofotara_operations
UNION ALL SELECT '2026-07-24 progressive split checks', @rollup_progressive_splits
UNION ALL SELECT '2026-07-25 print templates', @rollup_print_templates
UNION ALL SELECT '2026-07-29 subscription receivables', @rollup_subscription_receivables;
