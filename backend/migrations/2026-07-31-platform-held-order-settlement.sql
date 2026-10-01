-- Deferred delivery-platform settlement (phpMyAdmin-safe).
-- Forward-only: application rollback must retain this additive schema once platform orders exist.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260731_platform_held_settlement`$$
CREATE PROCEDURE `_ps_20260731_platform_held_settlement`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_count FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME IN ('orders','order_types','schema_migrations');
    IF v_count <> 3 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required POS tables are missing';
    END IF;

    SELECT MAX(checksum) INTO v_checksum FROM schema_migrations
     WHERE migration_name='2026-07-31-platform-held-order-settlement-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE order_types
      ADD COLUMN IF NOT EXISTS is_deferred_settlement TINYINT(1) NOT NULL DEFAULT 0 AFTER requires_hash;

    ALTER TABLE orders
      MODIFY payment_method ENUM('cash','card','split','receivable','platform','unpaid_table','voided') NOT NULL;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-31-platform-held-order-settlement-v1', 'cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85');
END$$

CALL `_ps_20260731_platform_held_settlement`()$$
DROP PROCEDURE `_ps_20260731_platform_held_settlement`$$

DELIMITER ;
