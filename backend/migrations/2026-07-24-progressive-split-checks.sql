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
CALL `_ps_20260724_progressive_splits`()$$
DROP PROCEDURE IF EXISTS `_ps_20260724_progressive_splits`$$
DELIMITER ;
