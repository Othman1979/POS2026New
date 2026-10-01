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

CALL `_ps_20260723_admin_manual_subscriptions`()$$
DROP PROCEDURE `_ps_20260723_admin_manual_subscriptions`$$

DELIMITER ;
