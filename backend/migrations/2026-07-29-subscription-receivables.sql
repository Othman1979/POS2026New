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

    CREATE TABLE subscription_collections (
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

CALL `_ps_20260729_subscription_receivables`()$$
DROP PROCEDURE `_ps_20260729_subscription_receivables`$$

DELIMITER ;
