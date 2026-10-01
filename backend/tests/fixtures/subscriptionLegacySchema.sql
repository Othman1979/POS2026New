CREATE TABLE subscription_plans (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          sale_product_id int(11) NOT NULL,
          included_credits smallint unsigned NOT NULL,
          duration_days smallint unsigned NOT NULL DEFAULT 30,
          is_active tinyint(1) NOT NULL DEFAULT 1,
          created_by int(11) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY uq_subscription_plans_sale_product (sale_product_id),
          KEY idx_subscription_plans_active (is_active,id),
          CONSTRAINT fk_subscription_plans_sale_product FOREIGN KEY (sale_product_id) REFERENCES products(id),
          CONSTRAINT fk_subscription_plans_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT chk_subscription_plans_credits CHECK (included_credits > 0),
          CONSTRAINT chk_subscription_plans_duration CHECK (duration_days > 0),
          CONSTRAINT chk_subscription_plans_active CHECK (is_active IN (0,1))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE subscription_plan_products (
          plan_id bigint unsigned NOT NULL,
          product_id int(11) NOT NULL,
          PRIMARY KEY (plan_id,product_id),
          KEY idx_subscription_plan_products_product (product_id,plan_id),
          CONSTRAINT fk_subscription_plan_products_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
          CONSTRAINT fk_subscription_plan_products_product FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE customer_subscriptions (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          customer_id int(11) NOT NULL,
          plan_id bigint unsigned NOT NULL,
          purchase_invoice_id int(11) DEFAULT NULL,
          starts_on date NOT NULL,
          ends_on date NOT NULL,
          total_credits smallint unsigned NOT NULL,
          status varchar(16) NOT NULL DEFAULT 'active',
          cancelled_at datetime DEFAULT NULL,
          cancelled_by int(11) DEFAULT NULL,
          cancellation_reason varchar(255) DEFAULT NULL,
          created_by int(11) DEFAULT NULL,
          manual_reason varchar(255) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY uq_customer_subscriptions_invoice (purchase_invoice_id),
          KEY idx_customer_subscriptions_customer_state (customer_id,status,ends_on,id),
          KEY idx_customer_subscriptions_state_end (status,ends_on,id),
          CONSTRAINT fk_customer_subscriptions_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
          CONSTRAINT fk_customer_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
          CONSTRAINT fk_customer_subscriptions_invoice FOREIGN KEY (purchase_invoice_id) REFERENCES orders(invoice_id),
          CONSTRAINT fk_customer_subscriptions_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT fk_customer_subscriptions_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT chk_customer_subscriptions_dates CHECK (ends_on >= starts_on),
          CONSTRAINT chk_customer_subscriptions_credits CHECK (total_credits > 0),
          CONSTRAINT chk_customer_subscriptions_status CHECK (status IN ('active','cancelled','refunded')),
          CONSTRAINT chk_customer_subscriptions_origin CHECK ((purchase_invoice_id IS NOT NULL AND manual_reason IS NULL) OR (purchase_invoice_id IS NULL AND char_length(trim(manual_reason)) > 0))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE subscription_collections (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          subscription_id bigint unsigned NOT NULL,
          shift_id int(11) NOT NULL,
          received_by int(11) NOT NULL,
          kind enum('collection','reversal') NOT NULL DEFAULT 'collection',
          cash_amount decimal(10,2) NOT NULL DEFAULT 0.00,
          card_amount decimal(10,2) NOT NULL DEFAULT 0.00,
          amount_tendered decimal(10,2) NOT NULL DEFAULT 0.00,
          change_due decimal(10,2) NOT NULL DEFAULT 0.00,
          business_date date NOT NULL,
          reverses_collection_id bigint unsigned DEFAULT NULL,
          reason varchar(255) DEFAULT NULL,
          idempotency_key varchar(100) NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY uq_subscription_collections_idempotency (idempotency_key),
          UNIQUE KEY uq_subscription_collections_reversal (reverses_collection_id),
          KEY idx_subscription_collections_subscription (subscription_id,kind,id),
          KEY idx_subscription_collections_shift (shift_id,business_date,id),
          KEY idx_subscription_collections_date (business_date,kind,id),
          CONSTRAINT fk_subscription_collections_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
          CONSTRAINT fk_subscription_collections_shift FOREIGN KEY (shift_id) REFERENCES shifts(id),
          CONSTRAINT fk_subscription_collections_user FOREIGN KEY (received_by) REFERENCES users(id),
          CONSTRAINT fk_subscription_collections_reversal FOREIGN KEY (reverses_collection_id) REFERENCES subscription_collections(id),
          CONSTRAINT chk_subscription_collections_amount CHECK (cash_amount >= 0 AND card_amount >= 0 AND amount_tendered >= 0 AND change_due >= 0 AND cash_amount + card_amount > 0 AND ((kind='collection' AND amount_tendered >= cash_amount + card_amount AND change_due = amount_tendered - cash_amount - card_amount) OR (kind='reversal' AND amount_tendered=0 AND change_due=0))),
          CONSTRAINT chk_subscription_collections_reversal_shape CHECK ((kind='collection' AND reverses_collection_id IS NULL) OR (kind='reversal' AND reverses_collection_id IS NOT NULL AND char_length(trim(reason)) > 0))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE customer_subscription_products (
          subscription_id bigint unsigned NOT NULL,
          product_id int(11) NOT NULL,
          PRIMARY KEY (subscription_id,product_id),
          KEY idx_customer_subscription_products_product (product_id,subscription_id),
          CONSTRAINT fk_customer_subscription_products_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
          CONSTRAINT fk_customer_subscription_products_product FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE subscription_extensions (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          subscription_id bigint unsigned NOT NULL,
          old_ends_on date NOT NULL,
          new_ends_on date NOT NULL,
          reason varchar(255) NOT NULL,
          extended_by int(11) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_subscription_extensions_subscription (subscription_id,id),
          CONSTRAINT fk_subscription_extensions_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
          CONSTRAINT fk_subscription_extensions_extended_by FOREIGN KEY (extended_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT chk_subscription_extensions_dates CHECK (new_ends_on > old_ends_on),
          CONSTRAINT chk_subscription_extensions_reason CHECK (char_length(trim(reason)) > 0)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE subscription_redemptions (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          subscription_id bigint unsigned NOT NULL,
          redeemed_by int(11) DEFAULT NULL,
          shift_id int(11) DEFAULT NULL,
          business_date date NOT NULL,
          additional_meal_reason varchar(255) DEFAULT NULL,
          stock_deducted tinyint(1) NOT NULL DEFAULT 0,
          status varchar(16) NOT NULL DEFAULT 'active',
          reversed_at datetime DEFAULT NULL,
          reversed_by int(11) DEFAULT NULL,
          reversal_reason varchar(255) DEFAULT NULL,
          idempotency_key varchar(80) NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY uq_subscription_redemptions_idempotency (idempotency_key),
          KEY idx_subscription_redemptions_balance (subscription_id,status,id),
          KEY idx_subscription_redemptions_business_date (business_date,status,id),
          KEY idx_subscription_redemptions_shift (shift_id,business_date,id),
          CONSTRAINT fk_subscription_redemptions_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
          CONSTRAINT fk_subscription_redemptions_redeemed_by FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT fk_subscription_redemptions_shift FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
          CONSTRAINT fk_subscription_redemptions_reversed_by FOREIGN KEY (reversed_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT chk_subscription_redemptions_status CHECK (status IN ('active','reversed')),
          CONSTRAINT chk_subscription_redemptions_stock CHECK (stock_deducted IN (0,1))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE subscription_redemption_items (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          redemption_id bigint unsigned NOT NULL,
          product_id int(11) NOT NULL,
          item_name varchar(255) NOT NULL,
          quantity smallint unsigned NOT NULL,
          note text DEFAULT NULL,
          selected_modifiers longtext DEFAULT NULL,
          bundle_items longtext DEFAULT NULL,
          sort_order int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          KEY idx_subscription_redemption_items_redemption (redemption_id,sort_order,id),
          KEY idx_subscription_redemption_items_product (product_id,redemption_id),
          CONSTRAINT fk_subscription_redemption_items_redemption FOREIGN KEY (redemption_id) REFERENCES subscription_redemptions(id) ON DELETE CASCADE,
          CONSTRAINT fk_subscription_redemption_items_product FOREIGN KEY (product_id) REFERENCES products(id),
          CONSTRAINT chk_subscription_redemption_items_quantity CHECK (quantity > 0),
          CONSTRAINT chk_subscription_redemption_items_modifiers_json CHECK (selected_modifiers IS NULL OR json_valid(selected_modifiers)),
          CONSTRAINT chk_subscription_redemption_items_bundle_json CHECK (bundle_items IS NULL OR json_valid(bundle_items))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE subscription_redemption_items
 ADD COLUMN IF NOT EXISTS stock_authority varchar(24) NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS stock_snapshot JSON DEFAULT NULL;

ALTER TABLE subscription_redemption_items
  ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

ALTER TABLE subscription_redemption_items
  ADD KEY IF NOT EXISTS idx_sri_recipe_line_key (recipe_line_key),
  ALGORITHM=INPLACE, LOCK=NONE;
