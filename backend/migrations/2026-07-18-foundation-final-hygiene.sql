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

CALL `_ps_20260718_foundation_hygiene`()$$
DROP PROCEDURE `_ps_20260718_foundation_hygiene`$$

DELIMITER ;
