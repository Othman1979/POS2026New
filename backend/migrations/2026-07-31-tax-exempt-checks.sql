-- Tax-exempt check authority (phpMyAdmin-safe, forward-only).
-- Adds only the order fact, the reversible frozen source price, and the default-deny permission.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260731_tax_exempt_checks`$$
CREATE PROCEDURE `_ps_20260731_tax_exempt_checks`()
migration: BEGIN
    DECLARE v_tables INT DEFAULT 0;
    DECLARE v_columns INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_tables
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('orders', 'order_items', 'permissions', 'user_permissions', 'schema_migrations');
    IF v_tables <> 5 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required POS tables are missing';
    END IF;

    SELECT COUNT(*) INTO v_columns
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'tax_registration_type_at_sale';
    IF v_columns <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: orders.tax_registration_type_at_sale is required';
    END IF;

    SELECT COUNT(*) INTO v_columns
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_items'
       AND COLUMN_NAME = 'price_at_sale';
    IF v_columns <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: order_items.price_at_sale is required';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-31-tax-exempt-checks-v1';
    IF v_checksum IS NOT NULL
       AND v_checksum <> '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS tax_exempt_at_sale TINYINT(1) NOT NULL DEFAULT 0
      AFTER tax_registration_type_at_sale;

    ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS price_before_tax_exemption DECIMAL(10,6) NULL
      AFTER price_at_sale;

    DELETE FROM user_permissions WHERE perm_key = 'pos.tax_exempt';

    INSERT INTO permissions
      (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
    VALUES
      ('pos.tax_exempt', 'Tax Exempt', 'إعفاء ضريبي',
       'Apply tax exemption to the current unpaid check.',
       'تطبيق الإعفاء الضريبي على الفاتورة غير المدفوعة الحالية.',
       'pos', 100, 1, 0, 0)
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

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-31-tax-exempt-checks-v1', '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3');
END$$

CALL `_ps_20260731_tax_exempt_checks`()$$
DROP PROCEDURE `_ps_20260731_tax_exempt_checks`$$

DELIMITER ;
