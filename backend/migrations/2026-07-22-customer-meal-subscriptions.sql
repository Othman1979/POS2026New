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

CALL `_ps_20260722_customer_meal_subscriptions`()$$
DROP PROCEDURE `_ps_20260722_customer_meal_subscriptions`$$

DELIMITER ;
