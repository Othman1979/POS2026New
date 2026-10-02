-- Hostinger/phpMyAdmin emergency fallback for approved post-floor migrations.
-- Starting floor: 2026-07-31-tax-exempt-checks-v1
-- Starting floor ledger checksum: 6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3
-- Historical migrations are intentionally omitted; they are already synchronized.
-- Future approved Hostinger-safe blocks are appended here in manifest order,
-- copied verbatim from their approved .auto.sql source between these markers:
-- BEGIN AUTO MIGRATION: <name> | <checksum>
-- END AUTO MIGRATION: <name> | <checksum>
SET NAMES utf8mb4;
-- This cumulative file starts before subscription retirement. Replaying it after
-- retirement would recreate dropped tables in older repeatable repair blocks.
-- Stop before any DDL; use the automatic migrator for later upgrades.
SET @fallback_retirement_applied = (
  SELECT COUNT(*) FROM schema_migrations
  WHERE migration_name='2026-09-23-subscriptions-retirement-v1'
);
SET @fallback_retirement_guard = IF(
  @fallback_retirement_applied=0,
  'SELECT 1',
  'POSAPP_CUMULATIVE_FALLBACK_BLOCKED_AFTER_SUBSCRIPTION_RETIREMENT'
);
PREPARE fallback_retirement_check FROM @fallback_retirement_guard;
EXECUTE fallback_retirement_check;
DEALLOCATE PREPARE fallback_retirement_check;
-- BEGIN AUTO MIGRATION: 2026-08-01-additive-schema-reconciliation-v1 | 5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679
-- Hostinger-safe additive schema reconciliation.
-- Missing definitions are restored from the canonical baseline and reviewed migrations.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name varchar(190) NOT NULL,
  checksum char(64) NOT NULL,
  applied_at datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (migration_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS status enum('pending','processing','sent','acknowledged','failed','dead_letter','canceled') NOT NULL DEFAULT 'pending';

-- print_queue.status is owned by 2026-08-17-spooler-v2-agents-v1 after its initial seven-value shape.
-- Keep this repeatable reconciliation from downgrading that later enum authority.
ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(160) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payload_hash char(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS printer_id int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS print_type varchar(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS claimed_by varchar(128) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spooler_id varchar(128) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spooler_version varchar(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS locked_until datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS attempts int(11) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts int(11) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS first_attempt_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_error text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS sent_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS duration_ms int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS next_retry_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reprint_of_queue_id bigint(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_seen_at datetime DEFAULT NULL,
  ADD UNIQUE INDEX IF NOT EXISTS uq_print_queue_idempotency (idempotency_key),
  ADD INDEX IF NOT EXISTS idx_print_queue_claim (status,locked_until,id),
  ADD INDEX IF NOT EXISTS idx_print_queue_state_locked (status,locked_until),
  ADD INDEX IF NOT EXISTS idx_print_queue_state_created (status,created_at),
  ADD INDEX IF NOT EXISTS idx_print_queue_reprint_of (reprint_of_queue_id),
  ADD INDEX IF NOT EXISTS idx_print_queue_owner_claim (printer_id,status,locked_until,id);

ALTER TABLE printers
  ADD COLUMN IF NOT EXISTS status_capability enum('write_only','escpos_status','snmp_status') NOT NULL DEFAULT 'write_only',
  ADD COLUMN IF NOT EXISTS device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS status_checked_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS status_source varchar(32) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spooler_id varchar(96) NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS active_endpoint_key varchar(255)
    AS (CASE
      WHEN is_active = 1 AND type = 'network'
        THEN CONCAT(role, ':network:', LOWER(TRIM(network_ip)), ':', COALESCE(NULLIF(TRIM(network_port),''),'9100'))
      WHEN is_active = 1 AND type = 'windows'
        THEN CONCAT(role, ':windows:', LOWER(TRIM(spooler_id)), ':', LOWER(TRIM(windows_name)))
      ELSE NULL
    END) STORED,
  ADD INDEX IF NOT EXISTS idx_printers_spooler (spooler_id,is_active,id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_printers_active_endpoint (active_endpoint_key);

CREATE TABLE IF NOT EXISTS product_bundle_items (
  id int(11) NOT NULL AUTO_INCREMENT,
  bundle_id int(11) NOT NULL,
  product_id int(11) NOT NULL,
  qty decimal(10,3) NOT NULL DEFAULT 1.000,
  sort_order int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pbi_bundle (bundle_id),
  KEY idx_pbi_product (product_id),
  CONSTRAINT fk_pbi_bundle FOREIGN KEY (bundle_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pbi_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE product_bundle_items
  ADD COLUMN IF NOT EXISTS id int(11) NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS bundle_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS product_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS qty decimal(10,3) NOT NULL DEFAULT 1.000,
  ADD COLUMN IF NOT EXISTS sort_order int(11) NOT NULL DEFAULT 0,
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD INDEX IF NOT EXISTS idx_pbi_bundle (bundle_id),
  ADD INDEX IF NOT EXISTS idx_pbi_product (product_id);

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS price_list_root_id int(11) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_categories_price_list_tree (price_list_root_id,is_active,id);

CREATE TABLE IF NOT EXISTS product_price_overrides (
  price_list_root_id int(11) NOT NULL,
  product_id int(11) NOT NULL,
  price decimal(10,6) NOT NULL,
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (price_list_root_id,product_id),
  CONSTRAINT fk_product_price_overrides_root FOREIGN KEY (price_list_root_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT fk_product_price_overrides_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_product_price_overrides_nonnegative CHECK (price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE product_price_overrides
  ADD COLUMN IF NOT EXISTS price_list_root_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS product_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS price decimal(10,6) NOT NULL,
  ADD COLUMN IF NOT EXISTS updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (price_list_root_id,product_id),
  ADD CONSTRAINT IF NOT EXISTS chk_product_price_overrides_nonnegative CHECK (price >= 0);

CREATE TABLE IF NOT EXISTS jofotara_documents (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  source_key varchar(96) NOT NULL,
  order_invoice_id int(11) NOT NULL,
  refund_id int(11) DEFAULT NULL,
  original_document_id bigint unsigned DEFAULT NULL,
  document_kind enum('invoice','credit_note') NOT NULL,
  tax_registration_type enum('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax',
  document_number varchar(96) NOT NULL,
  document_uuid char(36) NOT NULL,
  status enum('pending','submitting','accepted','rejected','unknown') NOT NULL DEFAULT 'pending',
  legal_snapshot_json longtext DEFAULT NULL,
  request_xml longtext DEFAULT NULL,
  qr_text longtext DEFAULT NULL,
  response_body longtext DEFAULT NULL,
  http_status smallint unsigned DEFAULT NULL,
  attempt_count int unsigned NOT NULL DEFAULT 0,
  last_error text DEFAULT NULL,
  submitted_by_user_id int(11) DEFAULT NULL,
  last_attempt_at datetime DEFAULT NULL,
  accepted_at datetime DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_jofotara_source (source_key),
  UNIQUE KEY uq_jofotara_uuid (document_uuid),
  UNIQUE KEY uq_jofotara_number (document_number),
  KEY idx_jofotara_order (order_invoice_id,status),
  CONSTRAINT fk_jofotara_order FOREIGN KEY (order_invoice_id) REFERENCES orders(invoice_id),
  CONSTRAINT fk_jofotara_refund FOREIGN KEY (refund_id) REFERENCES refunds(id),
  CONSTRAINT fk_jofotara_original FOREIGN KEY (original_document_id) REFERENCES jofotara_documents(id),
  CONSTRAINT fk_jofotara_user FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE jofotara_documents
  ADD COLUMN IF NOT EXISTS tax_registration_type enum('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method enum('cash','card','split','receivable','platform','unpaid_table','voided') NOT NULL;

ALTER TABLE orders
  MODIFY COLUMN payment_method enum('cash','card','split','receivable','platform','unpaid_table','voided') NOT NULL,
  ADD COLUMN IF NOT EXISTS tax_registration_type_at_sale enum('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax',
  ADD COLUMN IF NOT EXISTS payment_due_on date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS receivable_reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buyer_name_at_sale varchar(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buyer_phone_at_sale varchar(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buyer_address_at_sale text DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_orders_receivable_due (payment_method,payment_due_on,invoice_id),
  ADD CONSTRAINT IF NOT EXISTS chk_orders_receivable_terms CHECK (
    (payment_method='receivable' AND payment_due_on IS NOT NULL AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
      AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0 AND COALESCE(cash_amount,0)=0 AND COALESCE(card_amount,0)=0
      AND COALESCE(amount_tendered,0)=0 AND COALESCE(change_due,0)=0)
    OR
    (payment_method<>'receivable' AND payment_due_on IS NULL AND receivable_reason IS NULL
      AND buyer_name_at_sale IS NULL AND buyer_phone_at_sale IS NULL AND buyer_address_at_sale IS NULL)
  );

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_before_tax_exemption decimal(10,6) DEFAULT NULL;

ALTER TABLE order_types
  ADD COLUMN IF NOT EXISTS is_deferred_settlement tinyint(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settings (
  setting_key varchar(50) NOT NULL,
  setting_value varchar(255) NOT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS permissions (
  perm_key varchar(64) NOT NULL,
  label varchar(120) NOT NULL,
  label_ar varchar(120) NOT NULL,
  description varchar(255) NOT NULL DEFAULT '',
  description_ar varchar(255) NOT NULL DEFAULT '',
  category varchar(32) NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  implemented tinyint(1) NOT NULL DEFAULT 1,
  default_cashier tinyint(1) NOT NULL DEFAULT 0,
  overridable tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (perm_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO settings (setting_key,setting_value) VALUES
  ('tax_registration_type','sales_tax'),
  ('jofotara_sales_tax_client_id',''),
  ('jofotara_sales_tax_secret_key',''),
  ('jofotara_sales_tax_income_source_sequence',''),
  ('jofotara_sales_tax_seller_tax_number',''),
  ('jofotara_sales_tax_seller_registered_name',''),
  ('jofotara_income_tax_client_id',''),
  ('jofotara_income_tax_secret_key',''),
  ('jofotara_income_tax_income_source_sequence',''),
  ('jofotara_income_tax_seller_tax_number',''),
  ('jofotara_income_tax_seller_registered_name',''),
  ('jofotara_auto_submit','0'),
  ('jofotara_auto_submit_since',''),
  ('subscription_receivables_enabled','0')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);

CREATE TABLE IF NOT EXISTS subscription_plans (
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

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS sale_product_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS included_credits smallint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS duration_days smallint unsigned NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS is_active tinyint(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD COLUMN IF NOT EXISTS updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_subscription_plans_sale_product (sale_product_id),
  ADD INDEX IF NOT EXISTS idx_subscription_plans_active (is_active,id),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_plans_credits CHECK (included_credits > 0),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_plans_duration CHECK (duration_days > 0),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_plans_active CHECK (is_active IN (0,1));

CREATE TABLE IF NOT EXISTS subscription_plan_products (
  plan_id bigint unsigned NOT NULL,
  product_id int(11) NOT NULL,
  PRIMARY KEY (plan_id,product_id),
  KEY idx_subscription_plan_products_product (product_id,plan_id),
  CONSTRAINT fk_subscription_plan_products_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_subscription_plan_products_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE subscription_plan_products
  ADD COLUMN IF NOT EXISTS plan_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS product_id int(11) NOT NULL,
  ADD PRIMARY KEY IF NOT EXISTS (plan_id,product_id),
  ADD INDEX IF NOT EXISTS idx_subscription_plan_products_product (product_id,plan_id);

CREATE TABLE IF NOT EXISTS customer_subscriptions (
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
  CONSTRAINT chk_customer_subscriptions_origin CHECK ((purchase_invoice_id IS NOT NULL AND manual_reason IS NULL) OR (purchase_invoice_id IS NULL AND CHAR_LENGTH(TRIM(manual_reason)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE customer_subscriptions
  ADD COLUMN IF NOT EXISTS purchase_invoice_id int(11) DEFAULT NULL;

ALTER TABLE customer_subscriptions
  MODIFY COLUMN purchase_invoice_id int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS customer_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS plan_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS starts_on date NOT NULL,
  ADD COLUMN IF NOT EXISTS ends_on date NOT NULL,
  ADD COLUMN IF NOT EXISTS total_credits smallint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS cancelled_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS manual_reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_customer_subscriptions_invoice (purchase_invoice_id),
  ADD INDEX IF NOT EXISTS idx_customer_subscriptions_customer_state (customer_id,status,ends_on,id),
  ADD INDEX IF NOT EXISTS idx_customer_subscriptions_state_end (status,ends_on,id),
  ADD CONSTRAINT IF NOT EXISTS chk_customer_subscriptions_dates CHECK (ends_on >= starts_on),
  ADD CONSTRAINT IF NOT EXISTS chk_customer_subscriptions_credits CHECK (total_credits > 0),
  ADD CONSTRAINT IF NOT EXISTS chk_customer_subscriptions_status CHECK (status IN ('active','cancelled','refunded')),
  ADD CONSTRAINT IF NOT EXISTS chk_customer_subscriptions_origin CHECK ((purchase_invoice_id IS NOT NULL AND manual_reason IS NULL) OR (purchase_invoice_id IS NULL AND CHAR_LENGTH(TRIM(manual_reason)) > 0));

CREATE TABLE IF NOT EXISTS customer_subscription_products (
  subscription_id bigint unsigned NOT NULL,
  product_id int(11) NOT NULL,
  PRIMARY KEY (subscription_id,product_id),
  KEY idx_customer_subscription_products_product (product_id,subscription_id),
  CONSTRAINT fk_customer_subscription_products_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_subscription_products_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE customer_subscription_products
  ADD COLUMN IF NOT EXISTS subscription_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS product_id int(11) NOT NULL,
  ADD PRIMARY KEY IF NOT EXISTS (subscription_id,product_id),
  ADD INDEX IF NOT EXISTS idx_customer_subscription_products_product (product_id,subscription_id);

CREATE TABLE IF NOT EXISTS subscription_extensions (
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
  CONSTRAINT chk_subscription_extensions_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE subscription_extensions
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS subscription_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS old_ends_on date NOT NULL,
  ADD COLUMN IF NOT EXISTS new_ends_on date NOT NULL,
  ADD COLUMN IF NOT EXISTS reason varchar(255) NOT NULL,
  ADD COLUMN IF NOT EXISTS extended_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD INDEX IF NOT EXISTS idx_subscription_extensions_subscription (subscription_id,id),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_extensions_dates CHECK (new_ends_on > old_ends_on),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_extensions_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0);

CREATE TABLE IF NOT EXISTS subscription_redemptions (
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

ALTER TABLE subscription_redemptions
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS subscription_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS redeemed_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shift_id int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS business_date date NOT NULL,
  ADD COLUMN IF NOT EXISTS additional_meal_reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stock_deducted tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS reversed_at datetime DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reversed_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(80) NOT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_subscription_redemptions_idempotency (idempotency_key),
  ADD INDEX IF NOT EXISTS idx_subscription_redemptions_balance (subscription_id,status,id),
  ADD INDEX IF NOT EXISTS idx_subscription_redemptions_business_date (business_date,status,id),
  ADD INDEX IF NOT EXISTS idx_subscription_redemptions_shift (shift_id,business_date,id),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_redemptions_status CHECK (status IN ('active','reversed')),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_redemptions_stock CHECK (stock_deducted IN (0,1));

CREATE TABLE IF NOT EXISTS subscription_redemption_items (
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
  CONSTRAINT chk_subscription_redemption_items_modifiers_json CHECK (selected_modifiers IS NULL OR JSON_VALID(selected_modifiers)),
  CONSTRAINT chk_subscription_redemption_items_bundle_json CHECK (bundle_items IS NULL OR JSON_VALID(bundle_items))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE subscription_redemption_items
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS redemption_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS product_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS item_name varchar(255) NOT NULL,
  ADD COLUMN IF NOT EXISTS quantity smallint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS note text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS selected_modifiers longtext DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bundle_items longtext DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sort_order int(11) NOT NULL DEFAULT 0,
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD INDEX IF NOT EXISTS idx_subscription_redemption_items_redemption (redemption_id,sort_order,id),
  ADD INDEX IF NOT EXISTS idx_subscription_redemption_items_product (product_id,redemption_id),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_redemption_items_quantity CHECK (quantity > 0),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_redemption_items_modifiers_json CHECK (selected_modifiers IS NULL OR JSON_VALID(selected_modifiers)),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_redemption_items_bundle_json CHECK (bundle_items IS NULL OR JSON_VALID(bundle_items));

INSERT INTO permissions
  (perm_key,label,label_ar,description,description_ar,category,sort_order,implemented,default_cashier,overridable)
VALUES
  ('pos.subscriptions','Manage Subscriptions','إدارة الاشتراكات','Sell subscriptions and redeem customer meals.','بيع الاشتراكات وصرف وجبات العملاء.','pos',98,1,1,0),
  ('pos.subscription_credit','Issue Subscription Credit','منح اشتراك آجل','Issue a subscription as a receivable invoice.','منح اشتراك كفاتورة ذمم آجلة.','pos',99,1,0,1),
  ('pos.tax_exempt','Tax Exempt','إعفاء ضريبي','Apply tax exemption to the current unpaid check.','تطبيق الإعفاء الضريبي على الفاتورة غير المدفوعة الحالية.','pos',100,1,0,0)
ON DUPLICATE KEY UPDATE perm_key = VALUES(perm_key);

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS parent_invoice_id int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS table_id int(11) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_held_orders_parent_invoice (parent_invoice_id,id),
  ADD INDEX IF NOT EXISTS idx_held_orders_split_table (table_id,id);

CREATE TABLE IF NOT EXISTS print_templates (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  document_type varchar(16) NOT NULL,
  active_revision_id bigint unsigned DEFAULT NULL,
  draft_revision_id bigint unsigned DEFAULT NULL,
  lock_version int unsigned NOT NULL DEFAULT 0,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_templates_document_type (document_type),
  CONSTRAINT chk_print_templates_document_type CHECK (document_type IN ('receipt','kitchen'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE print_templates
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS document_type varchar(16) NOT NULL,
  ADD COLUMN IF NOT EXISTS active_revision_id bigint unsigned DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS draft_revision_id bigint unsigned DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lock_version int unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD COLUMN IF NOT EXISTS updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_print_templates_document_type (document_type),
  ADD CONSTRAINT IF NOT EXISTS chk_print_templates_document_type CHECK (document_type IN ('receipt','kitchen'));

CREATE TABLE IF NOT EXISTS print_template_revisions (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  template_id bigint unsigned NOT NULL,
  revision_no int unsigned NOT NULL,
  schema_version smallint unsigned NOT NULL,
  definition_json longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  definition_hash char(64) NOT NULL,
  created_by int(11) DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  last_compile_error_code varchar(64) DEFAULT NULL,
  last_compile_error_message varchar(500) DEFAULT NULL,
  last_compile_failed_at datetime DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_template_revision_no (template_id,revision_no),
  UNIQUE KEY uq_print_template_revision_hash (template_id,definition_hash),
  KEY idx_print_template_revisions_history (template_id,created_at,id),
  CONSTRAINT fk_print_template_revisions_template FOREIGN KEY (template_id) REFERENCES print_templates(id) ON DELETE RESTRICT,
  CONSTRAINT fk_print_template_revisions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_print_template_revision_no CHECK (revision_no > 0),
  CONSTRAINT chk_print_template_revision_json CHECK (JSON_VALID(definition_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE print_template_revisions
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS template_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS revision_no int unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS schema_version smallint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS definition_json longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD COLUMN IF NOT EXISTS definition_hash char(64) NOT NULL,
  ADD COLUMN IF NOT EXISTS created_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD COLUMN IF NOT EXISTS last_compile_error_code varchar(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_compile_error_message varchar(500) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_compile_failed_at datetime DEFAULT NULL,
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_print_template_revision_no (template_id,revision_no),
  ADD UNIQUE INDEX IF NOT EXISTS uq_print_template_revision_hash (template_id,definition_hash),
  ADD INDEX IF NOT EXISTS idx_print_template_revisions_history (template_id,created_at,id),
  ADD CONSTRAINT IF NOT EXISTS chk_print_template_revision_no CHECK (revision_no > 0),
  ADD CONSTRAINT IF NOT EXISTS chk_print_template_revision_json CHECK (JSON_VALID(definition_json));

CREATE TABLE IF NOT EXISTS print_template_revision_tests (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  revision_id bigint unsigned NOT NULL,
  printer_id int(11) DEFAULT NULL,
  printer_name varchar(200) NOT NULL,
  printer_endpoint_key varchar(255) NOT NULL,
  queue_id int(11) DEFAULT NULL,
  spooler_version varchar(64) NOT NULL,
  acknowledged_at datetime NOT NULL,
  confirmed_by int(11) DEFAULT NULL,
  confirmed_at datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_template_revision_test_queue (queue_id),
  KEY idx_print_template_tests_revision_printer (revision_id,printer_id,confirmed_at,id),
  CONSTRAINT fk_print_template_tests_revision FOREIGN KEY (revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_print_template_tests_printer FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL,
  CONSTRAINT fk_print_template_tests_queue FOREIGN KEY (queue_id) REFERENCES print_queue(id) ON DELETE SET NULL,
  CONSTRAINT fk_print_template_tests_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE print_template_revision_tests
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS revision_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS printer_id int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS printer_name varchar(200) NOT NULL,
  ADD COLUMN IF NOT EXISTS printer_endpoint_key varchar(255) NOT NULL,
  ADD COLUMN IF NOT EXISTS queue_id int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spooler_version varchar(64) NOT NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_at datetime NOT NULL,
  ADD COLUMN IF NOT EXISTS confirmed_by int(11) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_print_template_revision_test_queue (queue_id),
  ADD INDEX IF NOT EXISTS idx_print_template_tests_revision_printer (revision_id,printer_id,confirmed_at,id);

ALTER TABLE print_templates
  ADD CONSTRAINT fk_print_templates_active_revision FOREIGN KEY IF NOT EXISTS (active_revision_id)
    REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

ALTER TABLE print_templates
  ADD CONSTRAINT fk_print_templates_draft_revision FOREIGN KEY IF NOT EXISTS (draft_revision_id)
    REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

INSERT INTO print_templates (document_type) VALUES ('receipt'),('kitchen')
ON DUPLICATE KEY UPDATE document_type = VALUES(document_type);

CREATE TABLE IF NOT EXISTS subscription_collections (
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
  CONSTRAINT chk_subscription_collections_reversal_shape CHECK ((kind='collection' AND reverses_collection_id IS NULL) OR (kind='reversal' AND reverses_collection_id IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE subscription_collections
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS subscription_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS shift_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS received_by int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS kind enum('collection','reversal') NOT NULL DEFAULT 'collection',
  ADD COLUMN IF NOT EXISTS cash_amount decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS card_amount decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS amount_tendered decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS change_due decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS business_date date NOT NULL,
  ADD COLUMN IF NOT EXISTS reverses_collection_id bigint unsigned DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(100) NOT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_subscription_collections_idempotency (idempotency_key),
  ADD UNIQUE INDEX IF NOT EXISTS uq_subscription_collections_reversal (reverses_collection_id),
  ADD INDEX IF NOT EXISTS idx_subscription_collections_subscription (subscription_id,kind,id),
  ADD INDEX IF NOT EXISTS idx_subscription_collections_shift (shift_id,business_date,id),
  ADD INDEX IF NOT EXISTS idx_subscription_collections_date (business_date,kind,id),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_collections_amount CHECK (cash_amount >= 0 AND card_amount >= 0 AND amount_tendered >= 0 AND change_due >= 0 AND cash_amount + card_amount > 0 AND ((kind='collection' AND amount_tendered >= cash_amount + card_amount AND change_due = amount_tendered - cash_amount - card_amount) OR (kind='reversal' AND amount_tendered=0 AND change_due=0))),
  ADD CONSTRAINT IF NOT EXISTS chk_subscription_collections_reversal_shape CHECK ((kind='collection' AND reverses_collection_id IS NULL) OR (kind='reversal' AND reverses_collection_id IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) > 0));

INSERT INTO schema_migrations (migration_name,checksum)
VALUES ('2026-08-01-additive-schema-reconciliation-v1','5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679')
ON DUPLICATE KEY UPDATE checksum = VALUES(checksum);

CREATE TABLE IF NOT EXISTS platform_remittances (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  order_type_id int(11) NOT NULL,
  provider_name_at_entry varchar(100) NOT NULL,
  kind enum('settlement','reversal') NOT NULL DEFAULT 'settlement',
  statement_start_date date DEFAULT NULL,
  statement_end_date date DEFAULT NULL,
  settled_on date NOT NULL,
  reference varchar(120) DEFAULT NULL,
  net_received decimal(10,2) NOT NULL,
  reverses_remittance_id bigint unsigned DEFAULT NULL,
  reason varchar(255) DEFAULT NULL,
  recorded_by int(11) NOT NULL,
  idempotency_key varchar(80) NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_remittances_idempotency (idempotency_key),
  UNIQUE KEY uq_platform_remittances_reversal (reverses_remittance_id),
  KEY idx_platform_remittances_provider_date (order_type_id,settled_on,id),
  KEY idx_platform_remittances_date_kind (settled_on,kind,id),
  CONSTRAINT fk_platform_remittances_user FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_remittances_reversal FOREIGN KEY (reverses_remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittances_net CHECK (net_received >= 0),
  CONSTRAINT chk_platform_remittances_statement_dates CHECK ((statement_start_date IS NULL AND statement_end_date IS NULL) OR (statement_start_date IS NOT NULL AND statement_end_date IS NOT NULL AND statement_start_date <= statement_end_date)),
  CONSTRAINT chk_platform_remittances_reversal_shape CHECK ((kind='settlement' AND reverses_remittance_id IS NULL AND reason IS NULL) OR (kind='reversal' AND reverses_remittance_id IS NOT NULL AND char_length(trim(reason)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE platform_remittances
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS order_type_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS provider_name_at_entry varchar(100) NOT NULL,
  ADD COLUMN IF NOT EXISTS kind enum('settlement','reversal') NOT NULL DEFAULT 'settlement',
  ADD COLUMN IF NOT EXISTS statement_start_date date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS statement_end_date date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS settled_on date NOT NULL,
  ADD COLUMN IF NOT EXISTS reference varchar(120) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS net_received decimal(10,2) NOT NULL,
  ADD COLUMN IF NOT EXISTS reverses_remittance_id bigint unsigned DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reason varchar(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS recorded_by int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(80) NOT NULL,
  ADD COLUMN IF NOT EXISTS created_at datetime NOT NULL DEFAULT current_timestamp(),
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_platform_remittances_idempotency (idempotency_key),
  ADD UNIQUE INDEX IF NOT EXISTS uq_platform_remittances_reversal (reverses_remittance_id),
  ADD INDEX IF NOT EXISTS idx_platform_remittances_provider_date (order_type_id,settled_on,id),
  ADD INDEX IF NOT EXISTS idx_platform_remittances_date_kind (settled_on,kind,id),
  ADD CONSTRAINT IF NOT EXISTS chk_platform_remittances_net CHECK (net_received >= 0),
  ADD CONSTRAINT IF NOT EXISTS chk_platform_remittances_statement_dates CHECK ((statement_start_date IS NULL AND statement_end_date IS NULL) OR (statement_start_date IS NOT NULL AND statement_end_date IS NOT NULL AND statement_start_date <= statement_end_date)),
  ADD CONSTRAINT IF NOT EXISTS chk_platform_remittances_reversal_shape CHECK ((kind='settlement' AND reverses_remittance_id IS NULL AND reason IS NULL) OR (kind='reversal' AND reverses_remittance_id IS NOT NULL AND char_length(trim(reason)) > 0));

ALTER TABLE platform_remittances
  ADD CONSTRAINT fk_platform_remittances_user FOREIGN KEY IF NOT EXISTS (recorded_by)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE platform_remittances
  ADD CONSTRAINT fk_platform_remittances_reversal FOREIGN KEY IF NOT EXISTS (reverses_remittance_id)
    REFERENCES platform_remittances(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS platform_remittance_lines (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  remittance_id bigint unsigned NOT NULL,
  invoice_id int(11) NOT NULL,
  allocated_amount decimal(10,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_remittance_lines_invoice (remittance_id,invoice_id),
  KEY idx_platform_remittance_lines_invoice (invoice_id,remittance_id),
  CONSTRAINT fk_platform_remittance_lines_remittance FOREIGN KEY (remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_remittance_lines_order FOREIGN KEY (invoice_id) REFERENCES orders(invoice_id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittance_lines_amount CHECK (allocated_amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE platform_remittance_lines
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS remittance_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS invoice_id int(11) NOT NULL,
  ADD COLUMN IF NOT EXISTS allocated_amount decimal(10,2) NOT NULL,
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD UNIQUE INDEX IF NOT EXISTS uq_platform_remittance_lines_invoice (remittance_id,invoice_id),
  ADD INDEX IF NOT EXISTS idx_platform_remittance_lines_invoice (invoice_id,remittance_id),
  ADD CONSTRAINT IF NOT EXISTS chk_platform_remittance_lines_amount CHECK (allocated_amount <> 0);

ALTER TABLE platform_remittance_lines
  ADD CONSTRAINT fk_platform_remittance_lines_remittance FOREIGN KEY IF NOT EXISTS (remittance_id)
    REFERENCES platform_remittances(id) ON DELETE RESTRICT;

ALTER TABLE platform_remittance_lines
  ADD CONSTRAINT fk_platform_remittance_lines_order FOREIGN KEY IF NOT EXISTS (invoice_id)
    REFERENCES orders(invoice_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS platform_remittance_adjustments (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  remittance_id bigint unsigned NOT NULL,
  direction enum('deduction','addition') NOT NULL,
  category enum('commission','service_fee','marketing_fee','penalty','withholding_tax','reimbursement','incentive','correction','other') NOT NULL,
  amount decimal(10,2) NOT NULL,
  note varchar(255) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_platform_remittance_adjustments_remittance (remittance_id,id),
  CONSTRAINT fk_platform_remittance_adjustments_remittance FOREIGN KEY (remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittance_adjustments_amount CHECK (amount > 0),
  CONSTRAINT chk_platform_remittance_adjustments_shape CHECK ((category IN ('commission','service_fee','marketing_fee','penalty','withholding_tax') AND direction='deduction') OR (category IN ('reimbursement','incentive') AND direction='addition') OR (category IN ('correction','other') AND char_length(trim(note)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE platform_remittance_adjustments
  ADD COLUMN IF NOT EXISTS id bigint unsigned NOT NULL AUTO_INCREMENT,
  ADD COLUMN IF NOT EXISTS remittance_id bigint unsigned NOT NULL,
  ADD COLUMN IF NOT EXISTS direction enum('deduction','addition') NOT NULL,
  ADD COLUMN IF NOT EXISTS category enum('commission','service_fee','marketing_fee','penalty','withholding_tax','reimbursement','incentive','correction','other') NOT NULL,
  ADD COLUMN IF NOT EXISTS amount decimal(10,2) NOT NULL,
  ADD COLUMN IF NOT EXISTS note varchar(255) DEFAULT NULL,
  ADD PRIMARY KEY IF NOT EXISTS (id),
  ADD INDEX IF NOT EXISTS idx_platform_remittance_adjustments_remittance (remittance_id,id),
  ADD CONSTRAINT IF NOT EXISTS chk_platform_remittance_adjustments_amount CHECK (amount > 0),
  ADD CONSTRAINT IF NOT EXISTS chk_platform_remittance_adjustments_shape CHECK ((category IN ('commission','service_fee','marketing_fee','penalty','withholding_tax') AND direction='deduction') OR (category IN ('reimbursement','incentive') AND direction='addition') OR (category IN ('correction','other') AND char_length(trim(note)) > 0));

ALTER TABLE platform_remittance_adjustments
  ADD CONSTRAINT fk_platform_remittance_adjustments_remittance FOREIGN KEY IF NOT EXISTS (remittance_id)
    REFERENCES platform_remittances(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_platform_provider (payment_method,order_type_id,invoice_id);
-- END AUTO MIGRATION: 2026-08-01-additive-schema-reconciliation-v1 | 5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679

-- BEGIN AUTO MIGRATION: 2026-08-03-platform-provider-reconciliation-v1 | 21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999
-- Hostinger-safe automatic form of 2026-08-03-platform-provider-reconciliation-v1.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS platform_remittances (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  order_type_id int(11) NOT NULL,
  provider_name_at_entry varchar(100) NOT NULL,
  kind enum('settlement','reversal') NOT NULL DEFAULT 'settlement',
  statement_start_date date DEFAULT NULL,
  statement_end_date date DEFAULT NULL,
  settled_on date NOT NULL,
  reference varchar(120) DEFAULT NULL,
  net_received decimal(10,2) NOT NULL,
  reverses_remittance_id bigint unsigned DEFAULT NULL,
  reason varchar(255) DEFAULT NULL,
  recorded_by int(11) NOT NULL,
  idempotency_key varchar(80) NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_remittances_idempotency (idempotency_key),
  UNIQUE KEY uq_platform_remittances_reversal (reverses_remittance_id),
  KEY idx_platform_remittances_provider_date (order_type_id,settled_on,id),
  KEY idx_platform_remittances_date_kind (settled_on,kind,id),
  CONSTRAINT fk_platform_remittances_user FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_remittances_reversal FOREIGN KEY (reverses_remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittances_net CHECK (net_received >= 0),
  CONSTRAINT chk_platform_remittances_statement_dates CHECK ((statement_start_date IS NULL AND statement_end_date IS NULL) OR (statement_start_date IS NOT NULL AND statement_end_date IS NOT NULL AND statement_start_date <= statement_end_date)),
  CONSTRAINT chk_platform_remittances_reversal_shape CHECK ((kind='settlement' AND reverses_remittance_id IS NULL AND reason IS NULL) OR (kind='reversal' AND reverses_remittance_id IS NOT NULL AND char_length(trim(reason)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS platform_remittance_lines (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  remittance_id bigint unsigned NOT NULL,
  invoice_id int(11) NOT NULL,
  allocated_amount decimal(10,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_remittance_lines_invoice (remittance_id,invoice_id),
  KEY idx_platform_remittance_lines_invoice (invoice_id,remittance_id),
  CONSTRAINT fk_platform_remittance_lines_remittance FOREIGN KEY (remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_remittance_lines_order FOREIGN KEY (invoice_id) REFERENCES orders(invoice_id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittance_lines_amount CHECK (allocated_amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS platform_remittance_adjustments (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  remittance_id bigint unsigned NOT NULL,
  direction enum('deduction','addition') NOT NULL,
  category enum('commission','service_fee','marketing_fee','penalty','withholding_tax','reimbursement','incentive','correction','other') NOT NULL,
  amount decimal(10,2) NOT NULL,
  note varchar(255) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_platform_remittance_adjustments_remittance (remittance_id,id),
  CONSTRAINT fk_platform_remittance_adjustments_remittance FOREIGN KEY (remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittance_adjustments_amount CHECK (amount > 0),
  CONSTRAINT chk_platform_remittance_adjustments_shape CHECK ((category IN ('commission','service_fee','marketing_fee','penalty','withholding_tax') AND direction='deduction') OR (category IN ('reimbursement','incentive') AND direction='addition') OR (category IN ('correction','other') AND char_length(trim(note)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_platform_provider (payment_method,order_type_id,invoice_id);

INSERT INTO schema_migrations (migration_name,checksum)
VALUES ('2026-08-03-platform-provider-reconciliation-v1','21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999');
-- END AUTO MIGRATION: 2026-08-03-platform-provider-reconciliation-v1 | 21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999

-- BEGIN AUTO MIGRATION: 2026-08-04-jofotara-tax-categories-v1 | dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41
-- Hostinger-safe automatic form of 2026-08-04-jofotara-tax-categories-v1.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS jofotara_tax_category CHAR(1) NOT NULL DEFAULT 'O'
  AFTER tax_rate;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS jofotara_tax_category CHAR(1) NOT NULL DEFAULT 'O'
  AFTER tax_rate;

ALTER TABLE service_charge_snapshots
  ADD COLUMN IF NOT EXISTS jofotara_tax_category CHAR(1) NOT NULL DEFAULT 'O'
  AFTER tax_rate;

UPDATE products
SET jofotara_tax_category = CASE WHEN tax_rate > 0 THEN 'S' ELSE 'O' END
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE migration_name = '2026-08-04-jofotara-tax-categories-v1'
);

UPDATE order_items AS oi
LEFT JOIN orders AS o ON o.invoice_id = oi.invoice_id
SET oi.jofotara_tax_category = CASE
  WHEN o.tax_exempt_at_sale = 1 THEN 'Z'
  WHEN oi.tax_rate > 0 THEN 'S'
  ELSE 'O'
END
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE migration_name = '2026-08-04-jofotara-tax-categories-v1'
);

UPDATE service_charge_snapshots
SET jofotara_tax_category = CASE WHEN tax_rate > 0 THEN 'S' ELSE 'O' END
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE migration_name = '2026-08-04-jofotara-tax-categories-v1'
);

ALTER TABLE products
  ADD CONSTRAINT IF NOT EXISTS chk_products_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

ALTER TABLE order_items
  ADD CONSTRAINT IF NOT EXISTS chk_order_items_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

ALTER TABLE service_charge_snapshots
  ADD CONSTRAINT IF NOT EXISTS chk_service_charge_snapshots_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

INSERT INTO settings (setting_key, setting_value)
VALUES ('service_charge_jofotara_tax_category', 'O')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-04-jofotara-tax-categories-v1',
  'dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-04-jofotara-tax-categories-v1 | dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41

-- BEGIN AUTO MIGRATION: 2026-08-04-special-source-buyer-snapshots-v1 | 084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244
-- Hostinger-safe automatic form of 2026-08-04-special-source-buyer-snapshots-v1.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms,
  ADD CONSTRAINT chk_orders_receivable_terms CHECK (
    (payment_method='receivable'
      AND payment_due_on IS NOT NULL
      AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
      AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0
      AND COALESCE(cash_amount,0)=0 AND COALESCE(card_amount,0)=0
      AND COALESCE(amount_tendered,0)=0 AND COALESCE(change_due,0)=0)
    OR
    (payment_method<>'receivable'
      AND payment_due_on IS NULL
      AND receivable_reason IS NULL)
  );

UPDATE orders AS o
LEFT JOIN customer_subscriptions AS cs ON cs.purchase_invoice_id = o.invoice_id
LEFT JOIN customers ON customers.id = COALESCE(o.customer_id, cs.customer_id)
   SET buyer_name_at_sale = COALESCE(buyer_name_at_sale, customers.name),
       buyer_phone_at_sale = COALESCE(buyer_phone_at_sale, customers.phone),
       buyer_address_at_sale = COALESCE(buyer_address_at_sale, customers.address)
 WHERE (o.payment_method = 'platform'
        OR EXISTS (
            SELECT 1
              FROM customer_subscriptions cs2
             WHERE cs2.purchase_invoice_id = o.invoice_id
        ))
   AND (o.buyer_name_at_sale IS NULL
        OR o.buyer_phone_at_sale IS NULL
        OR o.buyer_address_at_sale IS NULL);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-08-04-special-source-buyer-snapshots-v1', '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-04-special-source-buyer-snapshots-v1 | 084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244

-- BEGIN AUTO MIGRATION: 2026-08-05-service-charge-jofotara-tax-category-v1 | 9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678
-- Hostinger-safe automatic repair for 2026-08-05-service-charge-jofotara-tax-category-v1.
-- Sets a positive-rate service charge to JoFotara category S; preserves O/Z at zero rate.

SET NAMES utf8mb4;

UPDATE settings AS category
JOIN settings AS rate
  ON rate.setting_key = 'service_charge_tax_rate'
SET category.setting_value = 'S'
WHERE category.setting_key = 'service_charge_jofotara_tax_category'
  AND CAST(COALESCE(NULLIF(TRIM(rate.setting_value), ''), '0') AS DECIMAL(10,2)) > 0
  AND category.setting_value <> 'S'
  AND NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE migration_name = '2026-08-05-service-charge-jofotara-tax-category-v1'
  );

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-05-service-charge-jofotara-tax-category-v1',
  '9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);

-- END AUTO MIGRATION: 2026-08-05-service-charge-jofotara-tax-category-v1 | 9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678

-- BEGIN AUTO MIGRATION: 2026-08-08-settings-value-capacity-v1 | ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff
-- Hostinger-safe automatic form of 2026-08-08-settings-value-capacity-v1.
-- Widen settings values in place; existing rows are preserved and setting_value is not indexed.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE settings
  MODIFY COLUMN setting_value TEXT NOT NULL;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-08-settings-value-capacity-v1',
  'ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);

-- END AUTO MIGRATION: 2026-08-08-settings-value-capacity-v1 | ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff

-- BEGIN AUTO MIGRATION: 2026-08-09-imported-schema-drift-repair-v1 | 0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73
-- Hostinger-safe automatic form of 2026-08-09-imported-schema-drift-repair-v1.
-- Existing rows are preserved. Foreign-key creation deliberately fails closed
-- when any orphaned value is present.

SET NAMES utf8mb4;

ALTER TABLE orders
  ENGINE=InnoDB,
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE product_bundle_items
  ADD CONSTRAINT fk_pbi_bundle FOREIGN KEY IF NOT EXISTS (bundle_id)
    REFERENCES products(id) ON DELETE CASCADE;

ALTER TABLE product_bundle_items
  ADD CONSTRAINT fk_pbi_product FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE product_price_overrides
  ADD CONSTRAINT fk_product_price_overrides_root FOREIGN KEY IF NOT EXISTS (price_list_root_id)
    REFERENCES categories(id) ON DELETE CASCADE;

ALTER TABLE product_price_overrides
  ADD CONSTRAINT fk_product_price_overrides_product FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE CASCADE;

ALTER TABLE subscription_plans
  ADD CONSTRAINT fk_subscription_plans_sale_product FOREIGN KEY IF NOT EXISTS (sale_product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE subscription_plans
  ADD CONSTRAINT fk_subscription_plans_created_by FOREIGN KEY IF NOT EXISTS (created_by)
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE subscription_plan_products
  ADD CONSTRAINT fk_subscription_plan_products_plan FOREIGN KEY IF NOT EXISTS (plan_id)
    REFERENCES subscription_plans(id) ON DELETE CASCADE;

ALTER TABLE subscription_plan_products
  ADD CONSTRAINT fk_subscription_plan_products_product FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE subscription_extensions
  ADD CONSTRAINT fk_subscription_extensions_subscription FOREIGN KEY IF NOT EXISTS (subscription_id)
    REFERENCES customer_subscriptions(id) ON DELETE RESTRICT;

ALTER TABLE subscription_extensions
  ADD CONSTRAINT fk_subscription_extensions_extended_by FOREIGN KEY IF NOT EXISTS (extended_by)
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE subscription_redemptions
  ADD CONSTRAINT fk_subscription_redemptions_subscription FOREIGN KEY IF NOT EXISTS (subscription_id)
    REFERENCES customer_subscriptions(id) ON DELETE RESTRICT;

ALTER TABLE subscription_redemptions
  ADD CONSTRAINT fk_subscription_redemptions_redeemed_by FOREIGN KEY IF NOT EXISTS (redeemed_by)
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE subscription_redemptions
  ADD CONSTRAINT fk_subscription_redemptions_shift FOREIGN KEY IF NOT EXISTS (shift_id)
    REFERENCES shifts(id) ON DELETE SET NULL;

ALTER TABLE subscription_redemptions
  ADD CONSTRAINT fk_subscription_redemptions_reversed_by FOREIGN KEY IF NOT EXISTS (reversed_by)
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE subscription_redemption_items
  ADD CONSTRAINT fk_subscription_redemption_items_redemption FOREIGN KEY IF NOT EXISTS (redemption_id)
    REFERENCES subscription_redemptions(id) ON DELETE CASCADE;

ALTER TABLE subscription_redemption_items
  ADD CONSTRAINT fk_subscription_redemption_items_product FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE held_orders
  ADD CONSTRAINT fk_held_orders_parent_invoice FOREIGN KEY IF NOT EXISTS (parent_invoice_id)
    REFERENCES orders(invoice_id) ON DELETE RESTRICT;

ALTER TABLE held_orders
  ADD CONSTRAINT fk_held_orders_split_table FOREIGN KEY IF NOT EXISTS (table_id)
    REFERENCES restaurant_tables(id) ON DELETE RESTRICT;

ALTER TABLE print_templates
  ENGINE=InnoDB,
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE print_template_revisions
  ENGINE=InnoDB,
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE print_template_revision_tests
  ENGINE=InnoDB,
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE print_template_revisions
  ADD CONSTRAINT fk_print_template_revisions_template FOREIGN KEY IF NOT EXISTS (template_id)
    REFERENCES print_templates(id) ON DELETE RESTRICT;

ALTER TABLE print_template_revisions
  ADD CONSTRAINT fk_print_template_revisions_creator FOREIGN KEY IF NOT EXISTS (created_by)
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE print_template_revision_tests
  ADD CONSTRAINT fk_print_template_tests_revision FOREIGN KEY IF NOT EXISTS (revision_id)
    REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

ALTER TABLE print_template_revision_tests
  ADD CONSTRAINT fk_print_template_tests_printer FOREIGN KEY IF NOT EXISTS (printer_id)
    REFERENCES printers(id) ON DELETE SET NULL;

ALTER TABLE print_template_revision_tests
  ADD CONSTRAINT fk_print_template_tests_queue FOREIGN KEY IF NOT EXISTS (queue_id)
    REFERENCES print_queue(id) ON DELETE SET NULL;

ALTER TABLE print_template_revision_tests
  ADD CONSTRAINT fk_print_template_tests_confirmer FOREIGN KEY IF NOT EXISTS (confirmed_by)
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE print_templates
  ADD CONSTRAINT fk_print_templates_active_revision FOREIGN KEY IF NOT EXISTS (active_revision_id)
    REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

ALTER TABLE print_templates
  ADD CONSTRAINT fk_print_templates_draft_revision FOREIGN KEY IF NOT EXISTS (draft_revision_id)
    REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

ALTER TABLE subscription_collections
  ADD CONSTRAINT fk_subscription_collections_subscription FOREIGN KEY IF NOT EXISTS (subscription_id)
    REFERENCES customer_subscriptions(id) ON DELETE RESTRICT;

ALTER TABLE subscription_collections
  ADD CONSTRAINT fk_subscription_collections_shift FOREIGN KEY IF NOT EXISTS (shift_id)
    REFERENCES shifts(id) ON DELETE RESTRICT;

ALTER TABLE subscription_collections
  ADD CONSTRAINT fk_subscription_collections_user FOREIGN KEY IF NOT EXISTS (received_by)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE subscription_collections
  ADD CONSTRAINT fk_subscription_collections_reversal FOREIGN KEY IF NOT EXISTS (reverses_collection_id)
    REFERENCES subscription_collections(id) ON DELETE RESTRICT;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms,
  ADD CONSTRAINT chk_orders_receivable_terms CHECK (
    (payment_method='receivable'
      AND payment_due_on IS NOT NULL
      AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
      AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0
      AND COALESCE(cash_amount,0)=0
      AND COALESCE(card_amount,0)=0
      AND COALESCE(amount_tendered,0)=0
      AND COALESCE(change_due,0)=0)
    OR
    (payment_method<>'receivable'
      AND payment_due_on IS NULL
      AND receivable_reason IS NULL)
  );

ALTER TABLE products
  ADD CONSTRAINT IF NOT EXISTS chk_products_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

ALTER TABLE order_items
  ADD CONSTRAINT IF NOT EXISTS chk_order_items_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

ALTER TABLE service_charge_snapshots
  ADD CONSTRAINT IF NOT EXISTS chk_service_charge_snapshots_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-09-imported-schema-drift-repair-v1',
  '0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);

-- END AUTO MIGRATION: 2026-08-09-imported-schema-drift-repair-v1 | 0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73

-- BEGIN AUTO MIGRATION: 2026-08-09-baseline-foreign-key-authority-v1 | 8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937
-- Hostinger-safe automatic form of 2026-08-09-baseline-foreign-key-authority-v1.
-- Existing rows are preserved. Any orphaned reference fails the affected FK add;
-- every earlier add is idempotent, so the next run safely resumes after correction.

SET NAMES utf8mb4;

ALTER TABLE user_permissions
  ADD CONSTRAINT fk_uperm_user FOREIGN KEY IF NOT EXISTS (user_id)
    REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE user_permissions
  ADD CONSTRAINT fk_uperm_perm FOREIGN KEY IF NOT EXISTS (perm_key)
    REFERENCES permissions(perm_key) ON DELETE CASCADE;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_parent_table FOREIGN KEY IF NOT EXISTS (parent_table_id)
    REFERENCES restaurant_tables(id) ON DELETE SET NULL;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_ibfk_1 FOREIGN KEY IF NOT EXISTS (section_id)
    REFERENCES sections(id) ON DELETE RESTRICT;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_ibfk_1 FOREIGN KEY IF NOT EXISTS (user_id)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_ibfk_1 FOREIGN KEY IF NOT EXISTS (invoice_id)
    REFERENCES orders(invoice_id) ON DELETE CASCADE;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_ibfk_2 FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE refund_items
  ADD CONSTRAINT fk_refund_items_refund FOREIGN KEY IF NOT EXISTS (refund_id)
    REFERENCES refunds(id) ON DELETE CASCADE;

ALTER TABLE qr_table_drafts
  ADD CONSTRAINT qr_table_drafts_ibfk_1 FOREIGN KEY IF NOT EXISTS (table_id)
    REFERENCES restaurant_tables(id) ON DELETE CASCADE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-09-baseline-foreign-key-authority-v1',
  '8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-09-baseline-foreign-key-authority-v1 | 8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937

-- BEGIN AUTO MIGRATION: 2026-08-10-order-reference-authority-v1 | da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35
-- Hostinger-safe automatic form of 2026-08-10-order-reference-authority-v1.
SET NAMES utf8mb4;

UPDATE orders o
LEFT JOIN users u ON u.id = o.waiter_id
SET o.waiter_id = NULL
WHERE o.waiter_id IS NOT NULL AND u.id IS NULL;

UPDATE orders o
LEFT JOIN order_types ot ON ot.id = o.order_type_id
SET o.order_type_id = NULL
WHERE o.order_type_id IS NOT NULL AND ot.id IS NULL;

UPDATE orders o
LEFT JOIN customers c ON c.id = o.customer_id
SET o.customer_id = NULL
WHERE o.customer_id IS NOT NULL AND c.id IS NULL;

UPDATE orders o
LEFT JOIN restaurant_tables t ON t.id = o.table_id
SET o.table_id = NULL
WHERE o.table_id IS NOT NULL AND t.id IS NULL;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_waiter FOREIGN KEY IF NOT EXISTS (waiter_id)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_order_type FOREIGN KEY IF NOT EXISTS (order_type_id)
    REFERENCES order_types(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_customer FOREIGN KEY IF NOT EXISTS (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_table FOREIGN KEY IF NOT EXISTS (table_id)
    REFERENCES restaurant_tables(id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-order-reference-authority-v1',
  'da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-10-order-reference-authority-v1 | da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35

-- BEGIN AUTO MIGRATION: 2026-08-10-legacy-permission-column-retirement-v1 | d3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550
-- Hostinger-safe automatic form of 2026-08-10-legacy-permission-column-retirement-v1.
-- Remove only proven-unused users columns; all user and canonical grant rows remain.

SET NAMES utf8mb4;

ALTER TABLE users DROP COLUMN IF EXISTS can_view_orders;
ALTER TABLE users DROP COLUMN IF EXISTS canholdorders;
ALTER TABLE users DROP COLUMN IF EXISTS can_update_table;
ALTER TABLE users DROP COLUMN IF EXISTS can_apply_discount;
ALTER TABLE users DROP COLUMN IF EXISTS can_void_items;
ALTER TABLE users DROP COLUMN IF EXISTS can_open_register;
ALTER TABLE users DROP COLUMN IF EXISTS can_checkout_tables;
ALTER TABLE users DROP COLUMN IF EXISTS bypass_existing_tables;
ALTER TABLE users DROP COLUMN IF EXISTS bypass_printed_tables;
ALTER TABLE users DROP COLUMN IF EXISTS can_view_order_history;
ALTER TABLE users DROP COLUMN IF EXISTS can_transfer_table;
ALTER TABLE users DROP COLUMN IF EXISTS can_join_tables;
ALTER TABLE users DROP COLUMN IF EXISTS can_split_bills;
ALTER TABLE users DROP COLUMN IF EXISTS waiter_split_bill;
ALTER TABLE users DROP COLUMN IF EXISTS can_print_check;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-legacy-permission-column-retirement-v1',
  'd3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-10-legacy-permission-column-retirement-v1 | d3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550

-- BEGIN AUTO MIGRATION: 2026-08-10-refund-status-reconciliation-v1 | 00b8fedabceb21101e6bb2739f89c54a6f7ee8fef6aa7b155a4e037b093f7ee6
-- 2026-08-10-refund-status-reconciliation-v1
-- Reconcile the denormalized order cache from canonical refund evidence.
-- This changes only orders.refund_status; refund rows and financial amounts are untouched.

SET NAMES utf8mb4;

UPDATE orders o
LEFT JOIN (
    SELECT invoice_id,
           COUNT(*) AS refund_count,
           SUM(CASE WHEN kind='void' THEN 1 ELSE 0 END) AS void_count,
           COALESCE(SUM(amount_refunded), 0) AS refunded_amount
      FROM refunds
     GROUP BY invoice_id
) evidence ON evidence.invoice_id=o.invoice_id
LEFT JOIN (
    SELECT oi.invoice_id,
           COUNT(*) AS parent_count,
           SUM(CASE
                   WHEN COALESCE(ri.refunded_qty, 0) + 1e-9 >= oi.quantity THEN 1
                   ELSE 0
               END) AS fully_covered_count
      FROM order_items oi
      LEFT JOIN (
          SELECT ri.order_item_id, SUM(ri.quantity) AS refunded_qty
            FROM refund_items ri
            JOIN refunds r ON r.id=ri.refund_id
           WHERE r.kind='refund'
           GROUP BY ri.order_item_id
      ) ri ON ri.order_item_id=oi.id
     WHERE oi.parent_item_id IS NULL
     GROUP BY oi.invoice_id
) coverage ON coverage.invoice_id=o.invoice_id
SET o.refund_status = CASE
    WHEN COALESCE(evidence.refund_count, 0)=0 THEN 'none'
    WHEN o.payment_method='voided' AND COALESCE(evidence.void_count, 0)>0 THEN 'full'
    WHEN o.payment_method='unpaid_table' AND COALESCE(evidence.void_count, 0)>0 THEN 'partial'
    WHEN COALESCE(coverage.parent_count, 0)>0
         AND coverage.fully_covered_count=coverage.parent_count
         AND COALESCE(evidence.refunded_amount, 0) + 1e-9 >= COALESCE(o.total, 0) THEN 'full'
    ELSE 'partial'
END;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
    '2026-08-10-refund-status-reconciliation-v1',
    '00b8fedabceb21101e6bb2739f89c54a6f7ee8fef6aa7b155a4e037b093f7ee6'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);

-- END AUTO MIGRATION: 2026-08-10-refund-status-reconciliation-v1 | 00b8fedabceb21101e6bb2739f89c54a6f7ee8fef6aa7b155a4e037b093f7ee6

-- BEGIN AUTO MIGRATION: 2026-08-10-order-reference-index-authority-v1 | 8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d
-- 2026-08-10-order-reference-index-authority-v1
-- Give the two historical-order foreign-key indexes their canonical baseline names.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_waiter_id (waiter_id);

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_order_type_id (order_type_id);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-order-reference-index-authority-v1',
  '8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-10-order-reference-index-authority-v1 | 8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d

-- BEGIN AUTO MIGRATION: 2026-08-10-held-order-lifecycle-v1 | af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160
-- 2026-08-10-held-order-lifecycle-v1
-- Add durable, server-owned lifecycle state to the existing held_orders authority.

SET NAMES utf8mb4;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS version INT UNSIGNED NOT NULL DEFAULT 1;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS hold_request_id VARCHAR(64) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS claimed_by_user_id INT NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS claim_token_hash CHAR(64) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS claim_expires_at DATETIME NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS kitchen_snapshot LONGTEXT NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS kitchen_dispatch_version INT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS last_operation_id VARCHAR(64) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS last_operation_kind VARCHAR(32) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS last_operation_result LONGTEXT NULL;

ALTER TABLE held_orders
  ADD UNIQUE INDEX IF NOT EXISTS uq_held_orders_user_request (user_id, hold_request_id);

ALTER TABLE held_orders
  ADD INDEX IF NOT EXISTS idx_held_orders_claim_owner (claimed_by_user_id);

ALTER TABLE held_orders
  ADD CONSTRAINT fk_held_orders_claim_user FOREIGN KEY IF NOT EXISTS (claimed_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-held-order-lifecycle-v1',
  'af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-10-held-order-lifecycle-v1 | af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160

-- BEGIN AUTO MIGRATION: 2026-08-10-call-center-held-orders-v1 | f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b
-- 2026-08-10-call-center-held-orders-v1
-- Requires migration: 2026-08-10-held-order-lifecycle-v1
-- Requires checksum: af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160
-- Requires normalized SQL SHA-256: a5ecfe94d542e5672dbc95d10877b38ceb75f10987e5e97c1720728e440b2185
-- Add the fixed call-center role and nullable server-owned phone-order source links.
-- Existing rows are preserved; new source columns remain NULL for historical data.

SET NAMES utf8mb4;

ALTER TABLE users
  MODIFY role ENUM('admin','cashier','programmer','waiter','table_manager','call_center') NOT NULL DEFAULT 'cashier';

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL;

ALTER TABLE held_orders
  ADD INDEX IF NOT EXISTS idx_held_orders_call_center_user (call_center_user_id);

ALTER TABLE held_orders
  ADD CONSTRAINT fk_held_orders_call_center_user FOREIGN KEY IF NOT EXISTS (call_center_user_id)
    REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_call_center_user (call_center_user_id);

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_call_center_user FOREIGN KEY IF NOT EXISTS (call_center_user_id)
    REFERENCES users (id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-call-center-held-orders-v1',
  'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-10-call-center-held-orders-v1 | f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b

-- BEGIN AUTO MIGRATION: 2026-08-11-receipt-tax-display-v1 | 90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3
-- 2026-08-11-receipt-tax-display-v1
-- Requires migration: 2026-08-10-call-center-held-orders-v1
-- Requires checksum: f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b
-- Requires normalized SQL SHA-256: f1b384472c35fc84e30d7c970582cef03964a51773e7ea61c658bd77829121bc
-- Freeze customer-receipt tax-inclusive presentation without changing sale tax accounting.
-- Existing rows remain NULL and continue using their historical receipt mode.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_tax_inclusive_at_sale TINYINT(1) NULL AFTER tax_inclusive_at_sale;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-11-receipt-tax-display-v1',
  '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-11-receipt-tax-display-v1 | 90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3

-- BEGIN AUTO MIGRATION: 2026-08-13-split-quantity-precision-v1 | eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76
-- 2026-08-13-split-quantity-precision-v1
-- Requires migration: 2026-08-11-receipt-tax-display-v1
-- Requires checksum: 90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3
-- Requires normalized SQL SHA-256: 8871974f40069bca8cdb92f6bc5a986578c365fec505d9cc67efa4528836d794
-- Preserve fractional split quantities through paid child and refund rows.
-- Widening scale is non-destructive; existing three-decimal values remain exact.

SET NAMES utf8mb4;

ALTER TABLE order_items
  MODIFY COLUMN quantity DECIMAL(12,6) NOT NULL;

ALTER TABLE refund_items
  MODIFY COLUMN quantity DECIMAL(12,6) NOT NULL;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-13-split-quantity-precision-v1',
  'eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-13-split-quantity-precision-v1 | eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76

-- BEGIN AUTO MIGRATION: 2026-08-13-webauthn-registered-device-access-v1 | 20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09
-- 2026-08-13-webauthn-registered-device-access-v1
-- Requires migration: 2026-08-13-split-quantity-precision-v1
-- Requires checksum: eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76
-- Durable WebAuthn credentials, ceremonies, recovery codes, and credential-aware sessions.

SET NAMES utf8mb4;

-- Recreate an empty legacy column on a deliberately replayed migration so the
-- one-time session import remains safe after the first run drops it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_token VARCHAR(128) DEFAULT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS webauthn_user_handle VARBINARY(64) DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_webauthn_user_handle
  ON users (webauthn_user_handle);

CREATE TABLE IF NOT EXISTS webauthn_recovery_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  batch_id CHAR(36) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id INT DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  used_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webauthn_recovery_code_hash (code_hash),
  KEY idx_webauthn_recovery_user_batch (user_id, batch_id, used_at),
  KEY idx_webauthn_recovery_expiry (expires_at, used_at),
  CONSTRAINT fk_webauthn_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_webauthn_recovery_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  credential_lookup BINARY(32) NOT NULL,
  credential_id VARBINARY(1024) NOT NULL,
  public_key BLOB NOT NULL,
  counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
  device_type ENUM('singleDevice','multiDevice') NOT NULL,
  backed_up TINYINT(1) NOT NULL DEFAULT 0,
  authenticator_attachment ENUM('platform','cross-platform') DEFAULT NULL,
  transports VARCHAR(255) DEFAULT NULL,
  aaguid CHAR(36) DEFAULT NULL,
  attestation_format VARCHAR(32) DEFAULT NULL,
  device_label VARCHAR(100) NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  registered_by_user_id INT DEFAULT NULL,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  revoked_by_user_id INT DEFAULT NULL,
  revoke_reason VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webauthn_credential_lookup (credential_lookup),
  KEY idx_webauthn_credentials_user_status (user_id, status),
  KEY idx_webauthn_credentials_last_used (last_used_at),
  CONSTRAINT fk_webauthn_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_webauthn_credentials_registrar FOREIGN KEY (registered_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_credentials_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  user_id INT NOT NULL,
  credential_id BIGINT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idle_expires_at DATETIME NOT NULL,
  absolute_expires_at DATETIME NOT NULL,
  webauthn_verified_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  revoke_reason VARCHAR(100) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_sessions_token_hash (token_hash),
  KEY idx_auth_sessions_user_active (user_id, revoked_at, idle_expires_at),
  KEY idx_auth_sessions_credential_active (credential_id, revoked_at, idle_expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_auth_sessions_credential FOREIGN KEY (credential_id) REFERENCES webauthn_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS webauthn_ceremonies (
  id CHAR(36) NOT NULL,
  flow ENUM('bootstrap_registration','enrollment_registration','authentication','step_up','recovery_registration') NOT NULL,
  user_id INT DEFAULT NULL,
  requesting_user_id INT DEFAULT NULL,
  replacement_credential_id BIGINT UNSIGNED DEFAULT NULL,
  recovery_code_id BIGINT UNSIGNED DEFAULT NULL,
  is_decoy TINYINT(1) NOT NULL DEFAULT 0,
  challenge VARBINARY(128) NOT NULL,
  enrollment_token_hash CHAR(64) DEFAULT NULL,
  enrollment_expires_at DATETIME DEFAULT NULL,
  intended_device_label VARCHAR(100) DEFAULT NULL,
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  terminal_state ENUM('pending','consumed','expired','cancelled','failed') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (id),
  KEY idx_webauthn_ceremonies_flow_user (flow, user_id, terminal_state, expires_at),
  KEY idx_webauthn_ceremonies_challenge (challenge, terminal_state, expires_at),
  KEY idx_webauthn_ceremonies_token (enrollment_token_hash, enrollment_expires_at),
  KEY idx_webauthn_ceremonies_recovery (recovery_code_id, terminal_state),
  CONSTRAINT fk_webauthn_ceremonies_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_ceremonies_requester FOREIGN KEY (requesting_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_ceremonies_replacement FOREIGN KEY (replacement_credential_id) REFERENCES webauthn_credentials(id) ON DELETE SET NULL,
  CONSTRAINT fk_webauthn_ceremonies_recovery FOREIGN KEY (recovery_code_id) REFERENCES webauthn_recovery_codes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO auth_sessions (
  id, token_hash, user_id, credential_id, created_at, last_seen_at,
  idle_expires_at, absolute_expires_at, webauthn_verified_at
)
SELECT UUID(), u.session_token, u.id, NULL, NOW(), NOW(),
       DATE_ADD(NOW(), INTERVAL 30 MINUTE), DATE_ADD(NOW(), INTERVAL 12 HOUR), NULL
  FROM users AS u
 WHERE u.session_token IS NOT NULL
   AND u.session_token REGEXP '^[0-9a-fA-F]{64}$'
   AND u.is_active = 1
   AND NOT EXISTS (
       SELECT 1 FROM auth_sessions AS s WHERE s.token_hash = u.session_token
   );

ALTER TABLE users
  DROP INDEX IF EXISTS idx_users_session_token,
  DROP COLUMN IF EXISTS session_token;

INSERT INTO settings (setting_key, setting_value)
VALUES ('staff_device_auth_mode', 'disabled'), ('webauthn_bootstrap_consumed', '0')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-13-webauthn-registered-device-access-v1',
  '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-13-webauthn-registered-device-access-v1 | 20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09

-- BEGIN AUTO MIGRATION: 2026-08-17-spooler-v2-agents-v1 | e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985
-- 2026-08-17-spooler-v2-agents-v1
-- Requires migration: 2026-08-13-webauthn-registered-device-access-v1
-- Requires checksum: 20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09
-- Requires normalized SQL SHA-256: 4d29b2be29029f32b402ff5fc923938c04ab8eae74501c55607bc481a3157619
-- Durable V2 station ownership, agent identity history, and queue lifecycle state.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS spooler_stations (
  spooler_id VARCHAR(96) NOT NULL,
  delivery_protocol ENUM('v1','transitioning','v2') NOT NULL DEFAULT 'v1',
  v2_activated_at DATETIME DEFAULT NULL,
  first_v2_accepted_at DATETIME DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (spooler_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS spooler_agents (
  agent_id CHAR(36) NOT NULL,
  spooler_id VARCHAR(96) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL DEFAULT '',
  agent_version VARCHAR(40) DEFAULT NULL,
  protocol_version INT NOT NULL DEFAULT 2,
  status ENUM('active','draining','revoked','decommissioned') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME DEFAULT NULL,
  last_sync_at DATETIME DEFAULT NULL,
  last_error VARCHAR(255) DEFAULT NULL,
  local_queue_depth INT DEFAULT NULL,
  health_summary VARCHAR(255) DEFAULT NULL,
  active_station_key VARCHAR(96) GENERATED ALWAYS AS
    (CASE WHEN status IN ('active','draining') THEN spooler_id ELSE NULL END) STORED,
  PRIMARY KEY (agent_id),
  UNIQUE KEY uq_spooler_agents_active_station (active_station_key),
  KEY idx_spooler_agents_station (spooler_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Isolated statement. Fail closed if INSTANT is unavailable; never use INPLACE/COPY.
ALTER TABLE print_queue
  MODIFY COLUMN status ENUM('pending','processing','sent','acknowledged','failed',
    'dead_letter','canceled','local_accepted','cancel_requested') NOT NULL DEFAULT 'pending',
  ALGORITHM=INSTANT, LOCK=NONE;

-- Separate statement: nullable trailing columns (INSTANT-eligible).
ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS agent_id CHAR(36) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS accepted_at DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_failure_class ENUM('transient_safe','permanent_safe','uncertain') DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS artifact_hash CHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS artifact_bytes INT UNSIGNED DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

-- Separate statement: index build (INPLACE is the proven-safe algorithm for ADD INDEX).
ALTER TABLE print_queue
  ADD KEY IF NOT EXISTS idx_print_queue_agent_claim (agent_id, status, locked_until, id),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-17-spooler-v2-agents-v1',
  'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-17-spooler-v2-agents-v1 | e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985

-- BEGIN AUTO MIGRATION: 2026-08-23-audit-browser-preview-v1 | e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af
-- 2026-08-23-audit-browser-preview-v1
-- Requires migration: 2026-08-17-spooler-v2-agents-v1
-- Requires checksum: e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985
-- Requires normalized SQL SHA-256: 27d3cf2d886dd7161eda08755a398154469567be0008287a3d2aa862439ae1c4
-- Record that an immutable audit report payload is ready for browser printing.

SET NAMES utf8mb4;

ALTER TABLE audit_report_documents
  MODIFY COLUMN last_print_status ENUM('queued','printed','failed','browser_ready') NOT NULL DEFAULT 'queued',
  ALGORITHM=INSTANT, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-23-audit-browser-preview-v1',
  'e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-23-audit-browser-preview-v1 | e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af

-- BEGIN AUTO MIGRATION: 2026-08-30-jofotara-stale-submission-index-v1 | 5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed
-- 2026-08-30-jofotara-stale-submission-index-v1
-- Requires migration: 2026-08-23-audit-browser-preview-v1
-- Requires checksum: e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af
-- Add the covering index used by stale-submission recovery without changing rows.

SET NAMES utf8mb4;

ALTER TABLE jofotara_documents
  ADD INDEX IF NOT EXISTS idx_jofotara_status_attempt (status, last_attempt_at),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-30-jofotara-stale-submission-index-v1',
  '5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-30-jofotara-stale-submission-index-v1 | 5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed

-- BEGIN AUTO MIGRATION: 2026-08-31-pos-order-history-default-v1 | 862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b
-- 2026-08-31-pos-order-history-default-v1
-- Requires migration: 2026-08-30-jofotara-stale-submission-index-v1
-- Requires checksum: 5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed
-- Restrict POS Order Notes history to cashiers with an explicit orders.view grant.

SET NAMES utf8mb4;

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES (
  'orders.view',
  'POS Order History',
  'سجل طلبات نقطة البيع',
  'View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.',
  'عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.',
  'orders',
  100,
  1,
  0,
  0
)
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
VALUES (
  '2026-08-31-pos-order-history-default-v1',
  '862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-08-31-pos-order-history-default-v1 | 862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b

-- BEGIN AUTO MIGRATION: 2026-09-01-product-price-override-lock-v1 | e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8
-- 2026-09-01-product-price-override-lock-v1
-- Requires migration: 2026-08-31-pos-order-history-default-v1
-- Requires checksum: 862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b
-- Requires normalized SQL SHA-256: f7c795ccbc34a515d365f9135e14366b9d86a30a179fb13e5745f064f5c71983
-- Add a per-product lock for manual price entry; existing products remain overrideable.

SET NAMES utf8mb4;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_override_locked TINYINT(1) NOT NULL DEFAULT 0,
  ALGORITHM=INSTANT, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-01-product-price-override-lock-v1',
  'e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-01-product-price-override-lock-v1 | e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8

-- BEGIN AUTO MIGRATION: 2026-09-01-fractional-stock-precision-v1 | b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e
-- 2026-09-01-fractional-stock-precision-v1
-- Requires migration: 2026-09-01-product-price-override-lock-v1
-- Requires checksum: e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8
-- Requires normalized SQL SHA-256: 9e9bf23a05e6df78932a3e78d6df7fdea9690e2f7b5be97e139a708d5d587a64
-- Widen product stock and thresholds to six-decimal precision while preserving
-- the signed INT range and existing nullability/default semantics.
-- MariaDB 10.4 requires COPY/SHARED for this type conversion.

SET NAMES utf8mb4;

ALTER TABLE products
  MODIFY COLUMN stock DECIMAL(16,6) DEFAULT NULL,
  MODIFY COLUMN min_stock_level DECIMAL(16,6) DEFAULT 10,
  MODIFY COLUMN max_stock_level DECIMAL(16,6) DEFAULT 100,
  ALGORITHM=COPY, LOCK=SHARED;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-01-fractional-stock-precision-v1',
  'b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-01-fractional-stock-precision-v1 | b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e

-- BEGIN AUTO MIGRATION: 2026-09-02-expense-zero-amount-v1 | 264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75
-- 2026-09-02-expense-zero-amount-v1
-- Requires migration: 2026-09-01-fractional-stock-precision-v1
-- Requires checksum: b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e
-- Requires normalized SQL SHA-256: 5b0429ee51ce38fcabcb723f53ef25b65527af5c58f19cabe3f1b766cced1ecb
-- Allow zero-valued expense entries while continuing to reject negative amounts.
-- This metadata-only change preserves all existing expense rows.

SET NAMES utf8mb4;

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS chk_expenses_amount,
  ADD CONSTRAINT chk_expenses_amount CHECK (amount >= 0);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-02-expense-zero-amount-v1',
  '264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-02-expense-zero-amount-v1 | 264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75

-- BEGIN AUTO MIGRATION: 2026-09-03-y-order-type-setting-v1 | 4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3
-- 2026-09-03-y-order-type-setting-v1
-- Requires migration: 2026-09-02-expense-zero-amount-v1
-- Requires checksum: 264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75
-- Ensure the DB-only Y held-order setting exists without changing a configured value.

SET NAMES utf8mb4;

INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES ('y_order_type_id', '');

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-03-y-order-type-setting-v1',
  '4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-03-y-order-type-setting-v1 | 4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3

-- BEGIN AUTO MIGRATION: 2026-09-05-recipe-ledger-v1 | 9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb
-- 2026-09-05-recipe-ledger-v1
-- Requires migration: 2026-09-03-y-order-type-setting-v1
-- Requires checksum: 4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3
-- Optional ingredient recipe ledger: usage, reversals, receipts, waste, counts, and corrections.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS ingredients (
  id int(11) NOT NULL AUTO_INCREMENT,
  name varchar(100) NOT NULL,
  measure enum('weight','volume','count') NOT NULL,
  display_unit enum('g','kg','ml','l','unit') NOT NULL,
  unit_cost decimal(16,8) DEFAULT NULL,
  par_qty decimal(16,6) DEFAULT NULL,
  pack_name varchar(40) DEFAULT NULL,
  pack_size decimal(16,6) DEFAULT NULL,
  is_active tinyint(1) NOT NULL DEFAULT 1,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ingredients_name (name),
  CONSTRAINT chk_ingredients_unit CHECK (
    (measure='weight' AND display_unit IN ('g','kg')) OR
    (measure='volume' AND display_unit IN ('ml','l')) OR
    (measure='count'  AND display_unit='unit')),
  CONSTRAINT chk_ingredients_pack CHECK (
    (pack_name IS NULL AND pack_size IS NULL) OR
    (pack_name IS NOT NULL AND pack_size > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS product_recipe_lines (
  id int(11) NOT NULL AUTO_INCREMENT,
  product_id int(11) NOT NULL,
  ingredient_id int(11) NOT NULL,
  qty_per_unit decimal(16,6) NOT NULL,
  sort_order int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_recipe_lines (product_id, ingredient_id),
  KEY idx_prl_ingredient (ingredient_id),
  CONSTRAINT fk_prl_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_prl_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT chk_prl_qty CHECK (qty_per_unit > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ingredient_movements (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  ingredient_id int(11) NOT NULL,
  kind enum('usage','reversal','receipt','waste','count','correction') NOT NULL,
  qty decimal(16,6) NOT NULL,
  unit_cost decimal(16,8) DEFAULT NULL,
  reason enum('spoiled','expired','dropped_or_burnt','over_prepared','staff_meal','other') DEFAULT NULL,
  expected_qty decimal(16,6) DEFAULT NULL,
  period_usage_qty decimal(16,6) DEFAULT NULL,
  line_key char(32) DEFAULT NULL,
  unit_qty decimal(16,6) DEFAULT NULL,
  product_qty decimal(16,6) DEFAULT NULL,
  source_type enum('order','redemption','refund','void','manual') NOT NULL,
  source_id int(11) DEFAULT NULL,
  source_label varchar(64) DEFAULT NULL,
  product_id int(11) DEFAULT NULL,
  product_name varchar(255) DEFAULT NULL,
  user_id int(11) DEFAULT NULL,
  user_name varchar(100) DEFAULT NULL,
  business_date date NOT NULL,
  occurred_at datetime NOT NULL DEFAULT current_timestamp(),
  note varchar(255) DEFAULT NULL,
  client_key varchar(64) DEFAULT NULL,
  corrects_movement_id bigint(20) unsigned DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_im_client_key (client_key),
  UNIQUE KEY uq_im_corrects (corrects_movement_id),
  KEY idx_im_ingredient_id (ingredient_id, id),
  KEY idx_im_ingredient_kind_id (ingredient_id, kind, id),
  KEY idx_im_date_ingredient (business_date, ingredient_id),
  KEY idx_im_line_key (line_key),
  KEY idx_im_source (source_type, source_id),
  CONSTRAINT fk_im_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT chk_im_signs CHECK (
    (kind IN ('usage','waste') AND qty <= 0) OR
    (kind IN ('reversal','receipt') AND qty >= 0) OR
    (kind = 'count' AND qty >= 0) OR
    kind = 'correction'),
  CONSTRAINT chk_im_reason CHECK (kind = 'waste' OR reason IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

ALTER TABLE order_items
  ADD KEY IF NOT EXISTS idx_order_items_recipe_line_key (recipe_line_key),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE subscription_redemption_items
  ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

ALTER TABLE subscription_redemption_items
  ADD KEY IF NOT EXISTS idx_sri_recipe_line_key (recipe_line_key),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES ('recipe_ledger_enabled', '0');

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-05-recipe-ledger-v1',
  '9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-05-recipe-ledger-v1 | 9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb

-- BEGIN AUTO MIGRATION: 2026-09-06-recipe-ledger-performance-v1 | f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c
-- 2026-09-06-recipe-ledger-performance-v1
-- Requires migration: 2026-09-05-recipe-ledger-v1
-- Requires checksum: 9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb

-- Evidence/operational source for the immutable per-line ingredient lock record.
-- Apply before starting the updated application, through the managed runner.
-- Existing movement quantities and cost snapshots are unchanged.

CREATE TABLE IF NOT EXISTS recipe_ledger_lines (
  line_key char(32) NOT NULL PRIMARY KEY,
  ingredient_ids JSON NOT NULL,
  CONSTRAINT chk_rll_array CHECK (JSON_TYPE(ingredient_ids)='ARRAY')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- MariaDB 10.4 has no JSON_ARRAYAGG. Guard against GROUP_CONCAT truncation
-- explicitly: incomplete discovery must fail, never silently omit a lock.
SET @recipe_line_previous_concat_limit = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 4294967295;

INSERT INTO recipe_ledger_lines (line_key, ingredient_ids)
SELECT line_key, CASE
  WHEN OCTET_LENGTH(GROUP_CONCAT(ingredient_id ORDER BY ingredient_id)) =
       SUM(OCTET_LENGTH(CAST(ingredient_id AS CHAR))) + COUNT(*) - 1
  THEN CONCAT('[', GROUP_CONCAT(ingredient_id ORDER BY ingredient_id), ']')
  ELSE NULL END
FROM (
  SELECT DISTINCT line_key, ingredient_id FROM ingredient_movements
  WHERE line_key IS NOT NULL AND kind IN ('usage','reversal')
) recorded
GROUP BY line_key
ON DUPLICATE KEY UPDATE line_key=VALUES(line_key);

SET SESSION group_concat_max_len = @recipe_line_previous_concat_limit;

-- A saved key without any usage rows is a frozen empty composition.
-- Split holds retain their parent order lines until settlement; merged and
-- settled lines retain the same keys. Movement keys above cover removed lines.
INSERT INTO recipe_ledger_lines (line_key, ingredient_ids)
SELECT recipe_line_key, '[]' FROM order_items WHERE recipe_line_key IS NOT NULL
UNION
SELECT recipe_line_key, '[]' FROM subscription_redemption_items WHERE recipe_line_key IS NOT NULL
ON DUPLICATE KEY UPDATE line_key=VALUES(line_key);

-- Replace the two existing read indexes with covering versions. The balance
-- index keeps ingredient/id ordering; the day index also orders flow groups.
ALTER TABLE ingredient_movements
  ADD KEY IF NOT EXISTS idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date),
  ADD KEY IF NOT EXISTS idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE ingredient_movements
  DROP KEY IF EXISTS idx_im_ingredient_id,
  DROP KEY IF EXISTS idx_im_date_ingredient,
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-06-recipe-ledger-performance-v1', 'f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-06-recipe-ledger-performance-v1 | f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c

-- BEGIN AUTO MIGRATION: 2026-09-07-ingredient-analysis-v1 | e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60
-- 2026-09-07-ingredient-analysis-v1
-- Requires migration: 2026-09-06-recipe-ledger-performance-v1
-- Requires checksum: f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c
-- Existing recipe quantities remain stock quantities; legacy prices have unknown provenance.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS recipe_cost_snapshot JSON DEFAULT NULL;
ALTER TABLE product_recipe_lines ADD COLUMN IF NOT EXISTS yield_pct decimal(10,4) NOT NULL DEFAULT 100;
ALTER TABLE ingredient_movements
 ADD COLUMN IF NOT EXISTS purchase_priced tinyint(1) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS cost_source varchar(24) NOT NULL DEFAULT 'legacy',
 MODIFY COLUMN note varchar(500) DEFAULT NULL,
 ADD KEY IF NOT EXISTS idx_im_purchase_cost (ingredient_id,kind,business_date,purchase_priced);
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-07-ingredient-analysis-v1', 'e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-07-ingredient-analysis-v1 | e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-adjustments-v1 | 24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc
-- 2026-09-08-stock-adjustments-v1
-- Requires migration: 2026-09-07-ingredient-analysis-v1
-- Requires checksum: e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60
-- Legacy product authority remains active; no history is inferred or backfilled.
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_version BIGINT UNSIGNED NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS stock_operations (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 request_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 kind VARCHAR(24) NOT NULL,
 actor_id INT DEFAULT NULL,
 legacy_product_id INT DEFAULT NULL,
 result_json JSON DEFAULT NULL,
 posted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 UNIQUE KEY uq_stock_operation_request (request_key),
 KEY idx_stock_operation_product (legacy_product_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO schema_migrations (migration_name,checksum) VALUES ('2026-09-08-stock-adjustments-v1','24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-adjustments-v1 | 24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-ledger-core-v1 | 39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4
-- Requires migration: 2026-09-08-stock-adjustments-v1
-- Requires checksum: 24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc
-- Stock identity and append-only quantity ledger.
-- This evidence migration is not an authority cutover. No legacy rows are mapped.
-- Quantity writers are integrated or reject linked product edits; item activation remains unavailable pending frozen authority and preflight.
CREATE TABLE IF NOT EXISTS stock_items (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(100) NOT NULL,
 measure VARCHAR(12) NOT NULL,
 base_unit VARCHAR(8) NOT NULL,
 legacy_product_id INT DEFAULT NULL,
 legacy_ingredient_id INT DEFAULT NULL,
 tracking_state VARCHAR(16) NOT NULL DEFAULT 'draft',
 lot_required TINYINT NOT NULL DEFAULT 0,
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_item_product (legacy_product_id),
 UNIQUE KEY uq_stock_item_ingredient (legacy_ingredient_id),
 KEY idx_stock_item_name (name,id),
 CONSTRAINT ck_stock_item_source CHECK (legacy_product_id IS NULL OR legacy_ingredient_id IS NULL),
 CONSTRAINT ck_stock_item_measure CHECK ((measure='weight' AND base_unit='g') OR (measure='volume' AND base_unit='ml') OR (measure='count' AND base_unit='unit')),
 CONSTRAINT ck_stock_item_state CHECK (tracking_state IN ('draft','active')),
 CONSTRAINT ck_stock_item_flags CHECK (lot_required IN (0,1) AND is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_locations (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 code VARCHAR(32) NOT NULL,
 name VARCHAR(100) NOT NULL,
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_location_code (code),
 CONSTRAINT ck_stock_location_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO stock_locations (code,name) VALUES ('default','المخزن الرئيسي'),('in_transit','قيد النقل')
ON DUPLICATE KEY UPDATE code=VALUES(code);
CREATE TABLE IF NOT EXISTS stock_lots (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 lot_code VARCHAR(100) NOT NULL,
 expiry_date DATE DEFAULT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'eligible',
 is_default TINYINT NOT NULL DEFAULT 0,
 UNIQUE KEY uq_stock_lot_code (stock_item_id,lot_code),
 UNIQUE KEY uq_stock_lot_item (id,stock_item_id),
 KEY idx_stock_lot_pick (stock_item_id,state,expiry_date,id),
 CONSTRAINT fk_stock_lot_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_lot_state CHECK (state IN ('eligible','quarantine')),
 CONSTRAINT ck_stock_default_lot CHECK ((is_default=1 AND lot_code='default') OR (is_default=0 AND lot_code<>'default'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_balances (
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NOT NULL,
 lot_id BIGINT UNSIGNED NOT NULL,
 quantity DECIMAL(16,6) NOT NULL DEFAULT 0,
 quantity_known TINYINT NOT NULL DEFAULT 0,
 version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 last_operation_id BIGINT UNSIGNED DEFAULT NULL,
 PRIMARY KEY (stock_item_id,location_id,lot_id),
 KEY idx_stock_balance_location (location_id,stock_item_id,lot_id),
 CONSTRAINT fk_stock_balance_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_stock_balance_location FOREIGN KEY (location_id) REFERENCES stock_locations(id),
 CONSTRAINT fk_stock_balance_lot FOREIGN KEY (lot_id,stock_item_id) REFERENCES stock_lots(id,stock_item_id),
 CONSTRAINT ck_stock_balance_known CHECK (quantity_known IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE stock_operations
 ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'posted',
 ADD COLUMN IF NOT EXISTS business_date DATE DEFAULT NULL,
 ADD COLUMN IF NOT EXISTS original_operation_id BIGINT UNSIGNED DEFAULT NULL;
CREATE TABLE IF NOT EXISTS stock_movements (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 operation_id BIGINT UNSIGNED NOT NULL,
 line_ordinal SMALLINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NOT NULL,
 lot_id BIGINT UNSIGNED NOT NULL,
 quantity DECIMAL(16,6) NOT NULL,
 establishes_known TINYINT NOT NULL DEFAULT 0,
 unit_snapshot VARCHAR(8) NOT NULL,
 source_line VARCHAR(100) DEFAULT NULL,
 business_date DATE NOT NULL,
 UNIQUE KEY uq_stock_movement_operation (operation_id,line_ordinal),
 KEY idx_stock_movement_history (stock_item_id,location_id,lot_id,id),
 KEY idx_stock_movement_day (business_date,id),
 CONSTRAINT fk_stock_movement_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT fk_stock_movement_balance FOREIGN KEY (stock_item_id,location_id,lot_id) REFERENCES stock_balances(stock_item_id,location_id,lot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS product_stock_links (
 product_id INT NOT NULL PRIMARY KEY,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 qty_per_sale DECIMAL(16,6) NOT NULL,
 policy_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 CONSTRAINT fk_product_stock_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_product_stock_qty CHECK (qty_per_sale > 0),
 CONSTRAINT fk_product_stock_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-ledger-core-v1','39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-ledger-core-v1 | 39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-sale-snapshots-v1 | b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f
-- 2026-09-08-stock-sale-snapshots-v1
-- Requires migration: 2026-09-08-stock-ledger-core-v1
-- Requires checksum: 39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4
-- NULL snapshots identify historical lines whose original mapping is unknown.
-- Never backfill them from today's catalog configuration.
ALTER TABLE order_items
 ADD COLUMN IF NOT EXISTS stock_authority varchar(24) NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS stock_snapshot JSON DEFAULT NULL;
ALTER TABLE subscription_redemption_items
 ADD COLUMN IF NOT EXISTS stock_authority varchar(24) NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS stock_snapshot JSON DEFAULT NULL;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-08-stock-sale-snapshots-v1', 'b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-sale-snapshots-v1 | b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-read-index-v1 | 318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081
-- 2026-09-08-stock-read-index-v1
-- Requires migration: 2026-09-08-stock-sale-snapshots-v1
-- Requires checksum: b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f
-- Equality filters precede the name/ID cursor; retains the existing all-status name index.
ALTER TABLE stock_items
 ADD INDEX IF NOT EXISTS idx_stock_item_active_name (tracking_state,is_active,name,id);
INSERT INTO schema_migrations (migration_name,checksum) VALUES ('2026-09-08-stock-read-index-v1','318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-read-index-v1 | 318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-report-generations-v1 | 724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510
-- 2026-09-08-stock-report-generations-v1
-- Requires migration: 2026-09-08-stock-read-index-v1
-- Requires checksum: 318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081
-- Publication metadata only. No source rows are inferred or activated.
CREATE TABLE IF NOT EXISTS stock_report_builds (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 day DATE NOT NULL,
 scope_id TINYINT UNSIGNED NOT NULL,
 generation BIGINT UNSIGNED NOT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'building',
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 KEY idx_stock_report_build_cleanup (state,id),
 CONSTRAINT chk_stock_report_build_scope CHECK (scope_id<32),
 CONSTRAINT chk_stock_report_build_state CHECK (state IN ('building','published','abandoned','obsolete'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_dirty (
 day DATE NOT NULL,
 scope_id TINYINT UNSIGNED NOT NULL,
 generation BIGINT UNSIGNED NOT NULL DEFAULT 1,
 pending TINYINT(1) NOT NULL DEFAULT 1,
 dirty_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
 lease_until DATETIME(6) DEFAULT NULL,
 active_build_id BIGINT UNSIGNED DEFAULT NULL,
 published_build_id BIGINT UNSIGNED DEFAULT NULL,
 published_generation BIGINT UNSIGNED DEFAULT NULL,
 as_of DATETIME(6) DEFAULT NULL,
 PRIMARY KEY (day,scope_id),
 KEY idx_stock_report_pending (pending,dirty_at,day,scope_id),
 CONSTRAINT fk_stock_report_active_build FOREIGN KEY (active_build_id) REFERENCES stock_report_builds(id),
 CONSTRAINT fk_stock_report_published_build FOREIGN KEY (published_build_id) REFERENCES stock_report_builds(id),
 CONSTRAINT chk_stock_report_dirty_scope CHECK (scope_id<32),
 CONSTRAINT chk_stock_report_pending CHECK (pending IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_worker (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
 lease_until DATETIME(6) DEFAULT NULL,
 CONSTRAINT chk_stock_report_worker_singleton CHECK (id=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-generations-v1','724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-report-generations-v1 | 724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-report-facts-v1 | c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb
-- 2026-09-08-stock-report-facts-v1
-- Requires migration: 2026-09-08-stock-report-generations-v1
-- Requires checksum: 724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510
-- Derived staging only. Published generation pointers control visibility.
-- The bounded invoice-line reader names this existing composite index.
-- Ensure older installations with an equivalent differently named index work.
ALTER TABLE order_items ADD INDEX IF NOT EXISTS idx_order_items_parent_invoice (parent_item_id,invoice_id);
CREATE TABLE IF NOT EXISTS stock_report_meals (
 build_id BIGINT UNSIGNED NOT NULL,
 product_id INT NOT NULL,
 name VARCHAR(255) DEFAULT NULL,
 sold DECIMAL(28,6) NOT NULL DEFAULT 0,
 refunded DECIMAL(28,6) NOT NULL DEFAULT 0,
 net_revenue_cents BIGINT NOT NULL DEFAULT 0,
 known_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 incomplete_lines BIGINT UNSIGNED NOT NULL DEFAULT 0,
 legacy_lines BIGINT UNSIGNED NOT NULL DEFAULT 0,
 unallocated_records BIGINT UNSIGNED NOT NULL DEFAULT 0,
 unallocated_revenue_cents BIGINT NOT NULL DEFAULT 0,
 excluded_revenue_cents BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY (build_id,product_id),
 CONSTRAINT fk_stock_report_meal_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_ingredients (
 build_id BIGINT UNSIGNED NOT NULL,
 product_id INT NOT NULL,
 ingredient_id INT NOT NULL,
 name VARCHAR(255) NOT NULL,
 display_unit VARCHAR(8) NOT NULL,
 qty DECIMAL(40,16) NOT NULL DEFAULT 0,
 known_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 incomplete TINYINT(1) NOT NULL DEFAULT 0,
 PRIMARY KEY (build_id,product_id,ingredient_id),
 KEY idx_stock_report_ingredient (build_id,ingredient_id,product_id),
 CONSTRAINT fk_stock_report_ingredient_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_events (
 build_id BIGINT UNSIGNED NOT NULL,
 kind VARCHAR(8) NOT NULL,
 source_id BIGINT UNSIGNED NOT NULL,
 source_line_id BIGINT UNSIGNED NOT NULL,
 invoice_id INT NOT NULL,
 product_id INT NOT NULL,
 event_at DATETIME NOT NULL,
 quantity DECIMAL(28,6) NOT NULL,
 net_revenue_cents BIGINT NOT NULL,
 known_cost DECIMAL(40,16) NOT NULL,
 incomplete TINYINT(1) NOT NULL,
 PRIMARY KEY (build_id,kind,source_id,source_line_id),
 KEY idx_stock_report_product_event (build_id,product_id,event_at,source_line_id),
 CONSTRAINT fk_stock_report_event_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE,
 CONSTRAINT chk_stock_report_event_kind CHECK (kind IN ('sale','refund'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_operations (
 build_id BIGINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ingredient_id INT NOT NULL DEFAULT 0,
 kind VARCHAR(24) NOT NULL,
 source_type VARCHAR(24) NOT NULL,
 qty DECIMAL(28,6) NOT NULL DEFAULT 0,
 known_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 uncosted_qty DECIMAL(28,6) NOT NULL DEFAULT 0,
 movement_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY (build_id,stock_item_id,ingredient_id,kind,source_type),
 CONSTRAINT fk_stock_report_operation_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Revoke metadata-only publications when typed facts are installed.
-- Guard the one-time invalidation when the cumulative manual SQL is rerun.
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
 active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1');
UPDATE stock_report_builds SET state=CASE WHEN state='published' THEN 'obsolete' ELSE 'abandoned' END
 WHERE state IN ('building','published') AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-facts-v1','c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-report-facts-v1 | c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-availability-policy-v1 | 161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88
-- 2026-09-08-stock-availability-policy-v1
-- Requires migration: 2026-09-08-stock-report-facts-v1
-- Requires checksum: c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb
-- Strict remains the default for existing packaged-stock identities.
-- Estimate records recipe usage without inventing a counted opening balance.
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS availability_policy VARCHAR(12) NOT NULL DEFAULT 'strict';
ALTER TABLE stock_items ADD CONSTRAINT IF NOT EXISTS ck_stock_item_availability
 CHECK (availability_policy IN ('strict','estimate'));
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-availability-policy-v1','161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-availability-policy-v1 | 161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-ingredient-cutover-v1 | a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a
-- 2026-09-08-stock-ingredient-cutover-v1
-- Requires migration: 2026-09-08-stock-availability-policy-v1
-- Requires checksum: 161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88
-- Durable ingredient authority cutover and source identity provenance.
-- Provenance is keyed by operation line and source identity, not reconstructed movement IDs.
CREATE TABLE IF NOT EXISTS stock_ingredient_links (
 ingredient_id INT NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 operation_id BIGINT UNSIGNED NOT NULL,
 movement_watermark BIGINT UNSIGNED NOT NULL,
 count_id BIGINT UNSIGNED DEFAULT NULL,
 observation_token CHAR(64) NOT NULL,
 quantity DECIMAL(16,6) DEFAULT NULL,
 quantity_known TINYINT NOT NULL,
 request_key VARCHAR(80) NOT NULL,
 activated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY (ingredient_id),
 UNIQUE KEY uq_stock_ingredient_item (stock_item_id),
 UNIQUE KEY uq_stock_ingredient_request (request_key),
 KEY idx_stock_ingredient_operation (operation_id),
 CONSTRAINT fk_stock_ingredient_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_stock_ingredient_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT ck_stock_ingredient_known CHECK (quantity_known IN (0,1)),
 CONSTRAINT ck_stock_ingredient_quantity CHECK ((quantity_known=0 AND quantity IS NULL) OR (quantity_known=1 AND quantity IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_operation_sources (
 operation_id BIGINT UNSIGNED NOT NULL,
 line_ordinal SMALLINT UNSIGNED NOT NULL,
 source_kind VARCHAR(32) NOT NULL,
 source_type VARCHAR(32) DEFAULT NULL,
 source_id BIGINT DEFAULT NULL,
 source_line VARCHAR(100) DEFAULT NULL,
 ingredient_id INT DEFAULT NULL,
 PRIMARY KEY (operation_id,line_ordinal),
 KEY idx_stock_source_ingredient (ingredient_id,source_type,source_id),
 KEY idx_stock_source_document (source_type,source_id),
 CONSTRAINT fk_stock_source_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT ck_stock_source_kind CHECK (source_kind IN ('ingredient_cutover','ingredient_usage','ingredient_manual','ingredient_correction'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-ingredient-cutover-v1','a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

-- END AUTO MIGRATION: 2026-09-08-stock-ingredient-cutover-v1 | a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-item-projections-v1 | 6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b
-- 2026-09-08-stock-item-projections-v1
-- Requires migration: 2026-09-08-stock-ingredient-cutover-v1
-- Requires checksum: a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a
-- Bounded stock pages project barcode, attention and daily movement identity.
ALTER TABLE stock_items
 ADD COLUMN IF NOT EXISTS barcode VARCHAR(50) NULL,
 ADD COLUMN IF NOT EXISTS attention VARCHAR(12) NOT NULL DEFAULT 'unknown';
ALTER TABLE stock_items ADD UNIQUE INDEX IF NOT EXISTS uq_stock_item_barcode (barcode);
ALTER TABLE stock_items ADD INDEX IF NOT EXISTS idx_stock_item_attention (attention,name,id);
ALTER TABLE stock_items ADD CONSTRAINT IF NOT EXISTS ck_stock_item_attention
 CHECK (attention IN ('ok','unknown','negative','inactive'));
ALTER TABLE stock_movements ADD INDEX IF NOT EXISTS idx_stock_movement_item_day (stock_item_id,business_date,id);
UPDATE stock_items s
 LEFT JOIN (
  SELECT stock_item_id, MIN(quantity_known) AS quantity_known, MIN(quantity) AS min_qty
  FROM stock_balances GROUP BY stock_item_id
 ) b ON b.stock_item_id=s.id
 SET s.attention=CASE
  WHEN s.is_active=0 OR s.tracking_state<>'active' THEN 'inactive'
  WHEN b.stock_item_id IS NULL OR b.quantity_known=0 THEN 'unknown'
  WHEN b.min_qty<0 THEN 'negative'
  ELSE 'ok' END;
UPDATE stock_items s
 INNER JOIN products p ON p.id=s.legacy_product_id
 SET s.barcode=NULLIF(TRIM(p.barcode),'')
 WHERE s.barcode IS NULL AND p.barcode IS NOT NULL AND TRIM(p.barcode)<>'';
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-item-projections-v1','6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-item-projections-v1 | 6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-report-ingredient-rebuild-v1 | 73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329
-- 2026-09-08-stock-report-ingredient-rebuild-v1
-- Requires migration: 2026-09-08-stock-item-projections-v1
-- Requires checksum: 6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b
-- Withdraw facts built by the old ingredient streamer. Physical ledgers are untouched.
-- Replaying after a partial migration is safe: only live pointers are invalidated.
-- Revoke the current worker lease before withdrawing published pointers.
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-ingredient-rebuild-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=CURRENT_TIMESTAMP(6),
 published_build_id=NULL,published_generation=NULL,as_of=NULL,
 active_build_id=NULL,lease_owner=NULL,lease_until=NULL
 WHERE (published_build_id IS NOT NULL OR active_build_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-ingredient-rebuild-v1');
UPDATE stock_report_builds b LEFT JOIN stock_report_dirty d
 ON d.published_build_id=b.id OR d.active_build_id=b.id
 SET b.state=IF(b.state='building','abandoned','obsolete')
 WHERE d.day IS NULL AND b.state IN ('building','published') AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-ingredient-rebuild-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-ingredient-rebuild-v1','73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-report-ingredient-rebuild-v1 | 73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-resolved-product-links-v1 | c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301
-- 2026-09-08-stock-resolved-product-links-v1
-- Requires migration: 2026-09-08-stock-report-ingredient-rebuild-v1
-- Requires checksum: 73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329
-- One product may resolve to multiple physical stocks; stocks may be shared.
-- Existing 1:1 rows and immutable sale snapshots are preserved.
ALTER TABLE product_stock_links DROP PRIMARY KEY, ADD PRIMARY KEY (product_id,stock_item_id);
ALTER TABLE product_stock_links ADD INDEX IF NOT EXISTS idx_product_stock_physical (stock_item_id,product_id);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-resolved-product-links-v1','c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-resolved-product-links-v1 | c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-report-backfill-v1 | 7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4
-- 2026-09-08-stock-report-backfill-v1
-- Requires migration: 2026-09-08-stock-resolved-product-links-v1
-- Requires checksum: c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301
-- Durable bounded source discovery. New writers enqueue their scopes in-source.
CREATE TABLE IF NOT EXISTS stock_report_backfill (
 source VARCHAR(24) NOT NULL PRIMARY KEY,
 last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 complete TINYINT(1) NOT NULL DEFAULT 0,
 CONSTRAINT ck_stock_report_backfill_source CHECK (source IN ('orders','refunds','ingredient_movements','stock_operations'))
) ENGINE=InnoDB;
INSERT IGNORE INTO stock_report_backfill(source) VALUES ('orders'),('refunds'),('ingredient_movements'),('stock_operations');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-backfill-v1','7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-report-backfill-v1 | 7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-report-count-intervals-v1 | 6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4
-- 2026-09-08-stock-report-count-intervals-v1
-- Requires migration: 2026-09-08-stock-report-backfill-v1
-- Requires checksum: 7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4
CREATE TABLE IF NOT EXISTS stock_report_counts (
 build_id BIGINT UNSIGNED NOT NULL,
 ingredient_id INT NOT NULL,
 count_id BIGINT UNSIGNED NOT NULL,
 previous_count_id BIGINT UNSIGNED NOT NULL,
 count_at DATETIME NOT NULL,
 count_qty DECIMAL(28,6) NOT NULL,
 received DECIMAL(28,6) NOT NULL DEFAULT 0,
 theoretical DECIMAL(28,6) NOT NULL DEFAULT 0,
 waste DECIMAL(28,6) NOT NULL DEFAULT 0,
 PRIMARY KEY(build_id,ingredient_id,count_id),
 KEY idx_stock_report_count_interval(ingredient_id,count_id,build_id),
 CONSTRAINT fk_stock_report_count_build FOREIGN KEY(build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_count_corrections (
 build_id BIGINT UNSIGNED NOT NULL,
 ingredient_id INT NOT NULL,
 count_id BIGINT UNSIGNED NOT NULL,
 original_id BIGINT UNSIGNED NOT NULL,
 kind VARCHAR(8) NOT NULL,
 qty DECIMAL(28,6) NOT NULL,
 PRIMARY KEY(build_id,ingredient_id,count_id,original_id),
 KEY idx_stock_report_count_correction(ingredient_id,count_id,original_id,build_id),
 CONSTRAINT fk_stock_report_count_correction_build FOREIGN KEY(build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-count-intervals-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
 active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-count-intervals-v1');
UPDATE stock_report_builds SET state=IF(state='building','abandoned','obsolete') WHERE state IN ('building','published')
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-count-intervals-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-count-intervals-v1','6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-report-count-intervals-v1 | 6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4

-- BEGIN AUTO MIGRATION: 2026-09-08-ingredient-working-balances-v1 | bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84
-- 2026-09-08-ingredient-working-balances-v1
-- Requires migration: 2026-09-08-stock-report-count-intervals-v1
-- Requires checksum: 6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4
-- Legacy ingredient projection. Activated ingredients read their physical ledger.
-- Historical initialization is bounded background work, not an upgrade-wide scan.
CREATE TABLE IF NOT EXISTS ingredient_working_balances (
 ingredient_id INT NOT NULL PRIMARY KEY,
 quantity DECIMAL(28,6) NOT NULL DEFAULT 0,
 quantity_known TINYINT(1) NOT NULL DEFAULT 0,
 last_count_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 period_usage DECIMAL(28,6) NOT NULL DEFAULT 0,
 variance_qty DECIMAL(28,6) NULL,
 initialized TINYINT(1) NOT NULL DEFAULT 0,
 CONSTRAINT fk_ingredient_working_balance FOREIGN KEY(ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
) ENGINE=InnoDB;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-ingredient-working-balances-v1','bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-ingredient-working-balances-v1 | bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-report-daily-projection-v1 | eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67
-- 2026-09-08-stock-report-daily-projection-v1
-- Requires migration: 2026-09-08-ingredient-working-balances-v1
-- Requires checksum: bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84
CREATE TABLE IF NOT EXISTS stock_report_daily (
 build_id BIGINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ingredient_id INT NOT NULL DEFAULT 0,
 location_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 incoming DECIMAL(28,6) NOT NULL DEFAULT 0,
 outgoing DECIMAL(28,6) NOT NULL DEFAULT 0,
 received DECIMAL(28,6) NOT NULL DEFAULT 0,
 used DECIMAL(28,6) NOT NULL DEFAULT 0,
 waste DECIMAL(28,6) NOT NULL DEFAULT 0,
 corrections DECIMAL(28,6) NOT NULL DEFAULT 0,
 used_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 waste_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 opening_id BIGINT UNSIGNED DEFAULT NULL,
 PRIMARY KEY(build_id,stock_item_id,ingredient_id,location_id),
 KEY idx_stock_daily_ingredient(build_id,ingredient_id,stock_item_id),
 CONSTRAINT fk_stock_daily_build FOREIGN KEY(build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-daily-projection-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
 active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-daily-projection-v1');
UPDATE stock_report_builds SET state=IF(state='building','abandoned','obsolete') WHERE state IN ('building','published')
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-daily-projection-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-daily-projection-v1','eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-stock-report-daily-projection-v1 | eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67

-- BEGIN AUTO MIGRATION: 2026-09-08-stock-procurement-v1 | a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d
-- 2026-09-08-stock-procurement-v1
-- Requires migration: 2026-09-08-stock-report-daily-projection-v1
-- Requires checksum: eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67
-- Suppliers, versioned packs, purchase orders, receipts, vendor returns and price-only adjustments.
CREATE TABLE IF NOT EXISTS stock_suppliers (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(120) NOT NULL,
 is_active TINYINT NOT NULL DEFAULT 1,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_supplier_name (name),
 KEY idx_stock_supplier_active_name (is_active,name,id),
 CONSTRAINT ck_stock_supplier_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_supplier_items (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 supplier_id BIGINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 supplier_sku VARCHAR(80) DEFAULT NULL,
 pack_barcode VARCHAR(50) DEFAULT NULL,
 pack_qty DECIMAL(16,6) NOT NULL,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_supplier_item (supplier_id,stock_item_id),
 UNIQUE KEY uq_stock_supplier_pack_barcode (pack_barcode),
 KEY idx_stock_supplier_item_sku (supplier_id,supplier_sku),
 CONSTRAINT fk_stock_supplier_item_supplier FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id),
 CONSTRAINT fk_stock_supplier_item_stock FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_supplier_item_pack CHECK (pack_qty>0),
 CONSTRAINT ck_stock_supplier_item_currency CHECK (currency='JD'),
 CONSTRAINT ck_stock_supplier_item_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_purchase_orders (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 supplier_id BIGINT UNSIGNED NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'draft',
 revision INT UNSIGNED NOT NULL DEFAULT 1,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 request_key VARCHAR(80) DEFAULT NULL,
 business_date DATE NOT NULL,
 notes VARCHAR(240) DEFAULT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_po_request (request_key),
 KEY idx_stock_po_status_date (status,business_date,id),
 KEY idx_stock_po_supplier (supplier_id,id),
 CONSTRAINT fk_stock_po_supplier FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id),
 CONSTRAINT ck_stock_po_status CHECK (status IN ('draft','approved','partially_received','closed','cancelled')),
 CONSTRAINT ck_stock_po_currency CHECK (currency='JD')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_purchase_order_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 purchase_order_id BIGINT UNSIGNED NOT NULL,
 revision INT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 supplier_item_id BIGINT UNSIGNED DEFAULT NULL,
 pack_qty DECIMAL(16,6) NOT NULL,
 ordered_packs DECIMAL(16,6) NOT NULL DEFAULT 0,
 ordered_loose DECIMAL(16,6) NOT NULL DEFAULT 0,
 ordered_qty DECIMAL(16,6) NOT NULL,
 received_qty DECIMAL(16,6) NOT NULL DEFAULT 0,
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 UNIQUE KEY uq_stock_po_line (purchase_order_id,revision,line_ordinal),
 KEY idx_stock_po_line_item (purchase_order_id,revision,stock_item_id),
 CONSTRAINT fk_stock_po_line_po FOREIGN KEY (purchase_order_id) REFERENCES stock_purchase_orders(id),
 CONSTRAINT fk_stock_po_line_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_po_line_qty CHECK (ordered_qty>=0 AND received_qty>=0 AND pack_qty>0 AND ordered_packs>=0 AND ordered_loose>=0),
 CONSTRAINT ck_stock_po_line_currency CHECK (currency='JD')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_receipts (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 supplier_id BIGINT UNSIGNED DEFAULT NULL,
 purchase_order_id BIGINT UNSIGNED DEFAULT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 request_key VARCHAR(80) DEFAULT NULL,
 supplier_document_ref VARCHAR(80) DEFAULT NULL,
 supplier_document_ack TINYINT NOT NULL DEFAULT 0,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 discount_amount DECIMAL(18,8) NOT NULL DEFAULT 0,
 nonrecoverable_charges DECIMAL(18,8) NOT NULL DEFAULT 0,
 recoverable_tax DECIMAL(18,8) NOT NULL DEFAULT 0,
 lines_subtotal DECIMAL(18,8) DEFAULT NULL,
 allocated_total DECIMAL(18,8) DEFAULT NULL,
 business_date DATE NOT NULL,
 operation_id BIGINT UNSIGNED DEFAULT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_receipt_request (request_key),
 KEY idx_stock_receipt_status_date (status,business_date,id),
 KEY idx_stock_receipt_supplier_ref (supplier_id,supplier_document_ref),
 KEY idx_stock_receipt_po (purchase_order_id,id),
 CONSTRAINT fk_stock_receipt_supplier FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id),
 CONSTRAINT fk_stock_receipt_po FOREIGN KEY (purchase_order_id) REFERENCES stock_purchase_orders(id),
 CONSTRAINT ck_stock_receipt_status CHECK (status IN ('draft','posted')),
 CONSTRAINT ck_stock_receipt_currency CHECK (currency='JD'),
 CONSTRAINT ck_stock_receipt_ack CHECK (supplier_document_ack IN (0,1)),
 CONSTRAINT ck_stock_receipt_money CHECK (discount_amount>=0 AND nonrecoverable_charges>=0 AND recoverable_tax>=0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_receipt_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 receipt_id BIGINT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 purchase_order_line_id BIGINT UNSIGNED DEFAULT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NOT NULL,
 lot_id BIGINT UNSIGNED NOT NULL,
 pack_qty DECIMAL(16,6) NOT NULL,
 packs DECIMAL(16,6) NOT NULL DEFAULT 0,
 loose DECIMAL(16,6) NOT NULL DEFAULT 0,
 received_qty DECIMAL(16,6) NOT NULL,
 ordered_qty DECIMAL(16,6) DEFAULT NULL,
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 allocated_cost DECIMAL(18,8) DEFAULT NULL,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 UNIQUE KEY uq_stock_receipt_line (receipt_id,line_ordinal),
 KEY idx_stock_receipt_line_item (receipt_id,stock_item_id),
 KEY idx_stock_receipt_line_po (purchase_order_line_id),
 CONSTRAINT fk_stock_receipt_line_receipt FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id),
 CONSTRAINT fk_stock_receipt_line_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_stock_receipt_line_location FOREIGN KEY (location_id) REFERENCES stock_locations(id),
 CONSTRAINT fk_stock_receipt_line_lot FOREIGN KEY (lot_id) REFERENCES stock_lots(id),
 CONSTRAINT ck_stock_receipt_line_qty CHECK (received_qty>0 AND pack_qty>0 AND packs>=0 AND loose>=0),
 CONSTRAINT ck_stock_receipt_line_currency CHECK (currency='JD')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_vendor_returns (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 receipt_id BIGINT UNSIGNED NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 request_key VARCHAR(80) DEFAULT NULL,
 business_date DATE NOT NULL,
 operation_id BIGINT UNSIGNED DEFAULT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_vendor_return_request (request_key),
 KEY idx_stock_vendor_return_receipt (receipt_id,id),
 CONSTRAINT fk_stock_vendor_return_receipt FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id),
 CONSTRAINT ck_stock_vendor_return_status CHECK (status IN ('draft','posted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_vendor_return_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 vendor_return_id BIGINT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 receipt_line_id BIGINT UNSIGNED NOT NULL,
 quantity DECIMAL(16,6) NOT NULL,
 UNIQUE KEY uq_stock_vendor_return_line (vendor_return_id,line_ordinal),
 KEY idx_stock_vendor_return_source (receipt_line_id),
 CONSTRAINT fk_stock_vendor_return_line_return FOREIGN KEY (vendor_return_id) REFERENCES stock_vendor_returns(id),
 CONSTRAINT fk_stock_vendor_return_line_source FOREIGN KEY (receipt_line_id) REFERENCES stock_receipt_lines(id),
 CONSTRAINT ck_stock_vendor_return_line_qty CHECK (quantity>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_price_adjustments (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 receipt_id BIGINT UNSIGNED NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 request_key VARCHAR(80) DEFAULT NULL,
 business_date DATE NOT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_price_adjustment_request (request_key),
 KEY idx_stock_price_adjustment_receipt (receipt_id,id),
 CONSTRAINT fk_stock_price_adjustment_receipt FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id),
 CONSTRAINT ck_stock_price_adjustment_status CHECK (status IN ('draft','posted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_price_adjustment_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 price_adjustment_id BIGINT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 receipt_line_id BIGINT UNSIGNED NOT NULL,
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 UNIQUE KEY uq_stock_price_adjustment_line (price_adjustment_id,line_ordinal),
 KEY idx_stock_price_adjustment_source (receipt_line_id),
 CONSTRAINT fk_stock_price_adjustment_line_adj FOREIGN KEY (price_adjustment_id) REFERENCES stock_price_adjustments(id),
 CONSTRAINT fk_stock_price_adjustment_line_source FOREIGN KEY (receipt_line_id) REFERENCES stock_receipt_lines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO permissions
 (perm_key,label,label_ar,description,description_ar,category,sort_order,implemented,default_cashier,overridable) VALUES
 ('inventory.read','View inventory','عرض المخزون','Read stock identities, receipts and purchase documents.','قراءة أصناف المخزون وإيصالات الاستلام وأوامر الشراء.','inventory',300,1,0,0),
 ('receipt.enter','Enter receipts','إدخال الاستلام','Create and edit receipt drafts.','إنشاء مسودات الاستلام وتعديلها.','inventory',310,1,0,0),
 ('receipt.post','Post receipts','ترحيل الاستلام','Post receipt, return and price-adjustment documents.','ترحيل إيصالات الاستلام والمرتجعات وتعديلات السعر.','inventory',320,1,0,0),
 ('purchase.approve','Approve purchases','اعتماد المشتريات','Approve, amend or cancel purchase orders.','اعتماد أوامر الشراء أو تعديلها أو إلغاء المتبقي منها.','inventory',330,1,0,0),
 ('supplier.manage','Manage suppliers','إدارة الموردين','Create and edit suppliers and pack mappings.','إنشاء الموردين وتعريفات العبوات وتعديلها.','inventory',340,1,0,0),
 ('count.enter','Enter counts','إدخال الجرد','Reserved for count drafts.','محجوز لمسودات الجرد.','inventory',350,0,0,0),
 ('count.post','Post counts','ترحيل الجرد','Reserved for posting counts.','محجوز لترحيل الجرد.','inventory',360,0,0,0),
 ('recipe.publish','Publish recipes','نشر الوصفات','Reserved for recipe publication.','محجوز لنشر الوصفات.','inventory',370,0,0,0),
 ('prep.post','Post preparations','ترحيل التحضير','Reserved for preparation batches.','محجوز لترحيل دفعات التحضير.','inventory',380,0,0,0),
 ('transfer.dispatch','Dispatch transfers','صرف التحويل','Reserved for transfer dispatch.','محجوز لصرف التحويل.','inventory',390,0,0,0),
 ('transfer.receive','Receive transfers','استلام التحويل','Reserved for transfer receipt.','محجوز لاستلام التحويل.','inventory',400,0,0,0),
 ('waste.post','Post waste','ترحيل الهدر','Reserved for waste posting.','محجوز لترحيل الهدر.','inventory',410,0,0,0),
 ('value.adjust','Adjust valuation','تعديل التقييم','Reserved for valuation adjustments.','محجوز لتعديلات التقييم.','inventory',420,0,0,0),
 ('period.close','Close periods','إقفال الفترات','Reserved for period close.','محجوز لإقفال الفترات.','inventory',430,0,0,0)
ON DUPLICATE KEY UPDATE label=VALUES(label),label_ar=VALUES(label_ar),description=VALUES(description),description_ar=VALUES(description_ar),category=VALUES(category),sort_order=VALUES(sort_order),implemented=VALUES(implemented),default_cashier=VALUES(default_cashier),overridable=VALUES(overridable);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-procurement-v1','a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

-- END AUTO MIGRATION: 2026-09-08-stock-procurement-v1 | a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d

-- BEGIN AUTO MIGRATION: 2026-09-08-procurement-request-integrity-v1 | 257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f
-- 2026-09-08-procurement-request-integrity-v1
-- Requires migration: 2026-09-08-stock-procurement-v1
-- Requires checksum: a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d
ALTER TABLE stock_purchase_orders ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_vendor_returns ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_price_adjustments ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_receipt_lines ADD COLUMN IF NOT EXISTS returned_qty DECIMAL(16,6) NOT NULL DEFAULT 0;
UPDATE stock_receipt_lines l LEFT JOIN (
 SELECT rl.receipt_line_id,SUM(rl.quantity) quantity FROM stock_vendor_return_lines rl
 JOIN stock_vendor_returns r ON r.id=rl.vendor_return_id WHERE r.status='posted' GROUP BY rl.receipt_line_id
) returned ON returned.receipt_line_id=l.id SET l.returned_qty=COALESCE(returned.quantity,0);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-procurement-request-integrity-v1','257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-08-procurement-request-integrity-v1 | 257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f

-- BEGIN AUTO MIGRATION: 2026-09-09-held-order-numbers-v1 | be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad
-- 2026-09-09-held-order-numbers-v1
-- Requires migration: 2026-09-08-procurement-request-integrity-v1
-- Requires checksum: 257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f
-- Existing holds remain unnumbered until their next explicit print/fire action.
ALTER TABLE held_orders ADD COLUMN IF NOT EXISTS order_id INT DEFAULT NULL;
ALTER TABLE held_orders ADD COLUMN IF NOT EXISTS order_seq_scope VARCHAR(40) DEFAULT NULL;
ALTER TABLE held_orders ADD UNIQUE KEY IF NOT EXISTS uq_held_order_sequence (order_seq_scope, order_id);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-09-held-order-numbers-v1','be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-09-held-order-numbers-v1 | be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad

-- BEGIN AUTO MIGRATION: 2026-09-12-order-type-numbering-v1 | 91f50cc44ba575da5014fada4f152a709686b38950eead8eaf732f5a6b99d883
-- 2026-09-12-order-type-numbering-v1
-- Requires migration: 2026-09-09-held-order-numbers-v1
-- Requires checksum: be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad
-- Existing order IDs/scopes remain unchanged. Prefixes are frozen per business day.
CREATE TABLE IF NOT EXISTS daily_order_type_sequences (
  sequence_date DATE NOT NULL,
  order_type_id INT NOT NULL,
  prefix_ordinal INT UNSIGNED NOT NULL,
  current_value INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (sequence_date, order_type_id),
  UNIQUE KEY uq_daily_type_prefix (sequence_date, prefix_ordinal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
INSERT IGNORE INTO settings(setting_key,setting_value) VALUES('order_type_numbering','0');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-order-type-numbering-v1','91f50cc44ba575da5014fada4f152a709686b38950eead8eaf732f5a6b99d883')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-12-order-type-numbering-v1 | 91f50cc44ba575da5014fada4f152a709686b38950eead8eaf732f5a6b99d883

-- BEGIN AUTO MIGRATION: 2026-09-12-stock-item-identity-v1 | 045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b
-- 2026-09-12-stock-item-identity-v1
-- One balance per item. Retained nullable warehouse IDs are historical provenance.
-- Run with application writers stopped. Unsupported warehouse data fails before DDL.
SET @stock_identity_ok = 1;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_lots'),'SELECT @stock_identity_ok := @stock_identity_ok AND NOT EXISTS(SELECT 1 FROM stock_lots WHERE is_default<>1 OR lot_code<>''default'' OR state<>''eligible'' OR expiry_date IS NOT NULL)','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_locations'),'SELECT @stock_identity_ok := @stock_identity_ok AND NOT EXISTS(SELECT 1 FROM stock_balances b JOIN stock_locations l ON l.id=b.location_id WHERE l.code<>''default'' OR l.is_active<>1)','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(1,'SELECT @stock_identity_ok := @stock_identity_ok AND NOT EXISTS(SELECT stock_item_id FROM stock_balances GROUP BY stock_item_id HAVING COUNT(*)>1)','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='lot_required'),'SELECT @stock_identity_ok := @stock_identity_ok AND NOT EXISTS(SELECT 1 FROM stock_items WHERE lot_required<>0)','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(@stock_identity_ok=1,'SELECT 1','SELECT * FROM posapp_stock_identity_requires_review');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines'),'ALTER TABLE stock_receipt_lines ADD COLUMN IF NOT EXISTS legacy_stock_identity JSON DEFAULT NULL','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_locations') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_lots'),'UPDATE stock_receipt_lines r JOIN stock_locations l ON l.id=r.location_id JOIN stock_lots t ON t.id=r.lot_id SET r.legacy_stock_identity=JSON_OBJECT(''location_id'',CAST(l.id AS CHAR),''location_code'',l.code,''location_name'',l.name,''location_active'',l.is_active,''lot_id'',CAST(t.id AS CHAR),''lot_code'',t.lot_code,''expiry_date'',t.expiry_date,''state'',t.state,''is_default'',t.is_default) WHERE r.legacy_stock_identity IS NULL','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines'),'ALTER TABLE stock_receipt_lines DROP FOREIGN KEY IF EXISTS fk_stock_receipt_line_location','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
SET @stock_identity_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines'),'ALTER TABLE stock_receipt_lines DROP FOREIGN KEY IF EXISTS fk_stock_receipt_line_lot','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
ALTER TABLE stock_movements DROP FOREIGN KEY IF EXISTS fk_stock_movement_balance;
ALTER TABLE stock_balances DROP FOREIGN KEY IF EXISTS fk_stock_balance_location;
ALTER TABLE stock_balances DROP FOREIGN KEY IF EXISTS fk_stock_balance_lot;
SET @stock_identity_sql = IF((SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_balances' AND INDEX_NAME='PRIMARY') <> 'stock_item_id','ALTER TABLE stock_balances DROP PRIMARY KEY, ADD PRIMARY KEY(stock_item_id)','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
ALTER TABLE stock_balances MODIFY COLUMN location_id BIGINT UNSIGNED NULL DEFAULT NULL, MODIFY COLUMN lot_id BIGINT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE stock_balances DROP INDEX IF EXISTS idx_stock_balance_location, DROP INDEX IF EXISTS fk_stock_balance_lot;
ALTER TABLE stock_movements MODIFY COLUMN location_id BIGINT UNSIGNED NULL DEFAULT NULL, MODIFY COLUMN lot_id BIGINT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE stock_movements DROP INDEX IF EXISTS idx_stock_movement_history;
CREATE INDEX IF NOT EXISTS idx_stock_movement_history ON stock_movements(stock_item_id,id);
SET @stock_identity_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='fk_stock_movement_balance'),'ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movement_balance FOREIGN KEY(stock_item_id) REFERENCES stock_balances(stock_item_id)','SELECT 1');
PREPARE stock_identity_stmt FROM @stock_identity_sql;
EXECUTE stock_identity_stmt;
DEALLOCATE PREPARE stock_identity_stmt;
DROP TABLE IF EXISTS stock_lots;
DROP TABLE IF EXISTS stock_locations;
ALTER TABLE stock_items DROP CONSTRAINT IF EXISTS ck_stock_item_flags;
ALTER TABLE stock_items DROP COLUMN IF EXISTS lot_required;
ALTER TABLE stock_items ADD CONSTRAINT ck_stock_item_flags CHECK (is_active IN (0,1));
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-stock-item-identity-v1','045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-12-stock-item-identity-v1 | 045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b

-- BEGIN AUTO MIGRATION: 2026-09-12-ingredient-state-v1 | 2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e
-- 2026-09-12-ingredient-state-v1
-- Requires migration: 2026-09-12-stock-item-identity-v1
-- Requires checksum: 045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b
-- Consolidate one-to-one ingredient state. Both movement ledgers remain unchanged.
-- Startup owns the migration lock; run the manual fallback with application writers stopped.
SET @ingredient_state_ok = 1;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_ingredient_links'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM stock_ingredient_links s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_working_balances'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM ingredient_working_balances s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(@ingredient_state_ok=1,'SELECT 1','SELECT * FROM posapp_ingredient_state_requires_review');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
ALTER TABLE ingredients
 ADD COLUMN IF NOT EXISTS stock_item_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_operation_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_movement_watermark BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_count_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_observation_token CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_quantity DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_quantity_known TINYINT NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_request_key VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
 ADD COLUMN IF NOT EXISTS stock_activated_at DATETIME(6) NULL,
 ADD COLUMN IF NOT EXISTS working_quantity DECIMAL(28,6) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_quantity_known TINYINT(1) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_last_count_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_period_usage DECIMAL(28,6) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_variance_qty DECIMAL(28,6) NULL,
 ADD COLUMN IF NOT EXISTS working_initialized TINYINT(1) NOT NULL DEFAULT 0;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_ingredient_links'),'UPDATE ingredients i JOIN stock_ingredient_links s ON s.ingredient_id=i.id SET i.stock_item_id=s.stock_item_id,i.stock_activation_operation_id=s.operation_id,i.stock_movement_watermark=s.movement_watermark,i.stock_activation_count_id=s.count_id,i.stock_observation_token=s.observation_token,i.stock_activation_quantity=s.quantity,i.stock_activation_quantity_known=s.quantity_known,i.stock_activation_request_key=s.request_key,i.stock_activated_at=s.activated_at,i.updated_at=i.updated_at','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_ingredient_links'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM stock_ingredient_links s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL OR NOT (i.stock_item_id<=>s.stock_item_id AND i.stock_activation_operation_id<=>s.operation_id AND i.stock_movement_watermark<=>s.movement_watermark AND i.stock_activation_count_id<=>s.count_id AND i.stock_observation_token<=>s.observation_token AND i.stock_activation_quantity<=>s.quantity AND i.stock_activation_quantity_known<=>s.quantity_known AND i.stock_activation_request_key<=>s.request_key AND i.stock_activated_at<=>s.activated_at)) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_working_balances'),'UPDATE ingredients i JOIN ingredient_working_balances s ON s.ingredient_id=i.id SET i.working_quantity=s.quantity,i.working_quantity_known=s.quantity_known,i.working_last_count_id=s.last_count_id,i.working_period_usage=s.period_usage,i.working_variance_qty=s.variance_qty,i.working_initialized=s.initialized,i.updated_at=i.updated_at','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_working_balances'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM ingredient_working_balances s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL OR NOT (i.working_quantity<=>s.quantity AND i.working_quantity_known<=>s.quantity_known AND i.working_last_count_id<=>s.last_count_id AND i.working_period_usage<=>s.period_usage AND i.working_variance_qty<=>s.variance_qty AND i.working_initialized<=>s.initialized)) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(@ingredient_state_ok=1,'SELECT 1','SELECT * FROM posapp_ingredient_state_copy_mismatch');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='uq_stock_ingredient_item'),'ALTER TABLE ingredients ADD UNIQUE KEY uq_stock_ingredient_item (stock_item_id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='uq_stock_ingredient_request'),'ALTER TABLE ingredients ADD UNIQUE KEY uq_stock_ingredient_request (stock_activation_request_key)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='idx_stock_ingredient_operation'),'ALTER TABLE ingredients ADD KEY idx_stock_ingredient_operation (stock_activation_operation_id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='idx_ingredient_working_init'),'ALTER TABLE ingredients ADD KEY idx_ingredient_working_init (working_initialized,id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='fk_ingredient_stock_item'),'ALTER TABLE ingredients ADD CONSTRAINT fk_ingredient_stock_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='fk_ingredient_stock_operation'),'ALTER TABLE ingredients ADD CONSTRAINT fk_ingredient_stock_operation FOREIGN KEY (stock_activation_operation_id) REFERENCES stock_operations(id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='ck_ingredient_stock_link'),'ALTER TABLE ingredients ADD CONSTRAINT ck_ingredient_stock_link CHECK (
 (stock_item_id IS NULL AND stock_activation_operation_id IS NULL AND stock_movement_watermark IS NULL
  AND stock_activation_count_id IS NULL AND stock_observation_token IS NULL AND stock_activation_quantity IS NULL
  AND stock_activation_quantity_known IS NULL AND stock_activation_request_key IS NULL AND stock_activated_at IS NULL)
 OR (stock_item_id IS NOT NULL AND stock_activation_operation_id IS NOT NULL AND stock_movement_watermark IS NOT NULL
  AND stock_observation_token IS NOT NULL AND stock_activation_request_key IS NOT NULL AND stock_activated_at IS NOT NULL
  AND stock_activation_quantity_known IS NOT NULL AND stock_activation_quantity_known IN (0,1)
  AND ((stock_activation_quantity_known=0 AND stock_activation_quantity IS NULL) OR (stock_activation_quantity_known=1 AND stock_activation_quantity IS NOT NULL))))','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='ck_ingredient_working_state'),'ALTER TABLE ingredients ADD CONSTRAINT ck_ingredient_working_state CHECK (working_quantity_known IN (0,1) AND working_initialized IN (0,1))','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
DROP TABLE IF EXISTS stock_ingredient_links;
DROP TABLE IF EXISTS ingredient_working_balances;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-ingredient-state-v1','2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-12-ingredient-state-v1 | 2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e

-- BEGIN AUTO MIGRATION: 2026-09-12-unified-stock-movements-v1 | 91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99
-- 2026-09-12-unified-stock-movements-v1
-- Requires migration: 2026-09-12-ingredient-state-v1
-- Requires checksum: 2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e
-- Stop every application writer/worker during this upgrade. Back up before DDL.
-- Original IDs are scoped by movement_type; no history is renumbered or discarded.
-- New ingredient movements can carry their physical effect on the same row.
SET @unified_movement_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-12-ingredient-state-v1' AND checksum='2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-12-unified-stock-movements-v1' AND checksum<>'91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99')),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT (EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements') OR EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND COLUMN_NAME='movement_type')),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_ok = 1;
SET @unified_movement_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'),'SELECT NOT EXISTS(SELECT 1 FROM ingredient_movements m LEFT JOIN ingredients i ON i.id=m.ingredient_id WHERE i.id IS NULL) INTO @unified_movement_ok','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT (@unified_movement_ok=1),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SELECT GREATEST(COALESCE(MAX(AUTO_INCREMENT),1),1) INTO @unified_movement_next FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_movements','ingredient_movements');
ALTER TABLE stock_movements
 ADD COLUMN IF NOT EXISTS movement_type ENUM('stock','ingredient') NOT NULL DEFAULT 'stock',
 ADD COLUMN IF NOT EXISTS ingredient_id INT NULL,
 ADD COLUMN IF NOT EXISTS kind ENUM('usage','reversal','receipt','waste','count','correction') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(16,8) NULL,
 ADD COLUMN IF NOT EXISTS reason ENUM('spoiled','expired','dropped_or_burnt','over_prepared','staff_meal','other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS expected_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS period_usage_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS line_key CHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS unit_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS product_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS source_type ENUM('order','redemption','refund','void','manual') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS source_id INT NULL,
 ADD COLUMN IF NOT EXISTS source_label VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS product_id INT NULL,
 ADD COLUMN IF NOT EXISTS product_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS user_id INT NULL,
 ADD COLUMN IF NOT EXISTS user_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS occurred_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN IF NOT EXISTS note VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS client_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS corrects_movement_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS purchase_priced TINYINT(1) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS cost_source VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'legacy',
 MODIFY operation_id BIGINT UNSIGNED NULL,
 MODIFY line_ordinal SMALLINT UNSIGNED NULL,
 MODIFY stock_item_id BIGINT UNSIGNED NULL,
 MODIFY quantity DECIMAL(16,6) NULL,
 MODIFY unit_snapshot VARCHAR(8) NULL;
-- Physical history keeps its timestamp in stock_operations.posted_at.
UPDATE stock_movements SET occurred_at=NULL WHERE movement_type='stock';
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_stock_movement_id'),'ALTER TABLE stock_movements ADD KEY idx_stock_movement_id (id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF((SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='PRIMARY')='id','ALTER TABLE stock_movements DROP PRIMARY KEY, ADD PRIMARY KEY (movement_type,id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='uq_im_client_key'),'ALTER TABLE stock_movements ADD UNIQUE KEY uq_im_client_key (client_key)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='uq_im_corrects'),'ALTER TABLE stock_movements ADD UNIQUE KEY uq_im_corrects (corrects_movement_id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_ingredient_kind_id'),'ALTER TABLE stock_movements ADD KEY idx_im_ingredient_kind_id (ingredient_id,kind,id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_line_key'),'ALTER TABLE stock_movements ADD KEY idx_im_line_key (line_key)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_source'),'ALTER TABLE stock_movements ADD KEY idx_im_source (source_type,source_id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_balance'),'ALTER TABLE stock_movements ADD KEY idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_day'),'ALTER TABLE stock_movements ADD KEY idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_purchase_cost'),'ALTER TABLE stock_movements ADD KEY idx_im_purchase_cost (ingredient_id,kind,business_date,purchase_priced)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='fk_stock_movement_ingredient'),'ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movement_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='ck_stock_movement_identity'),'ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movement_identity CHECK ((movement_type=''stock'' AND ingredient_id IS NULL AND kind IS NULL AND qty IS NULL AND operation_id IS NOT NULL AND occurred_at IS NULL) OR (movement_type=''ingredient'' AND ingredient_id IS NOT NULL AND kind IS NOT NULL AND qty IS NOT NULL AND source_type IS NOT NULL AND occurred_at IS NOT NULL))','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='ck_stock_movement_physical'),'ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movement_physical CHECK ((operation_id IS NULL AND stock_item_id IS NULL AND line_ordinal IS NULL AND quantity IS NULL AND unit_snapshot IS NULL AND establishes_known=0) OR (operation_id IS NOT NULL AND stock_item_id IS NOT NULL AND line_ordinal IS NOT NULL AND quantity IS NOT NULL AND unit_snapshot IS NOT NULL AND establishes_known IN (0,1)))','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='chk_im_signs'),'ALTER TABLE stock_movements ADD CONSTRAINT chk_im_signs CHECK (kind IS NULL OR (kind IN (''usage'',''waste'') AND qty<=0) OR (kind IN (''reversal'',''receipt'',''count'') AND qty>=0) OR kind=''correction'')','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='chk_im_reason'),'ALTER TABLE stock_movements ADD CONSTRAINT chk_im_reason CHECK (kind=''waste'' OR reason IS NULL)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'),'INSERT INTO stock_movements(movement_type,id,ingredient_id,kind,qty,unit_cost,reason,expected_qty,period_usage_qty,line_key,unit_qty,product_qty,source_type,source_id,source_label,product_id,product_name,user_id,user_name,occurred_at,note,client_key,corrects_movement_id,purchase_priced,cost_source,business_date) SELECT ''ingredient'',id,ingredient_id,kind,qty,unit_cost,reason,expected_qty,period_usage_qty,line_key,unit_qty,product_qty,source_type,source_id,source_label,product_id,product_name,user_id,user_name,occurred_at,note,client_key,corrects_movement_id,purchase_priced,cost_source,business_date FROM ingredient_movements ON DUPLICATE KEY UPDATE id=stock_movements.id','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'),'SELECT NOT EXISTS(SELECT 1 FROM ingredient_movements s LEFT JOIN stock_movements t ON t.movement_type=''ingredient'' AND t.id=s.id WHERE t.id IS NULL OR NOT (BINARY t.id<=>BINARY s.id AND BINARY t.ingredient_id<=>BINARY s.ingredient_id AND BINARY t.kind<=>BINARY s.kind AND BINARY t.qty<=>BINARY s.qty AND BINARY t.unit_cost<=>BINARY s.unit_cost AND BINARY t.reason<=>BINARY s.reason AND BINARY t.expected_qty<=>BINARY s.expected_qty AND BINARY t.period_usage_qty<=>BINARY s.period_usage_qty AND BINARY t.line_key<=>BINARY s.line_key AND BINARY t.unit_qty<=>BINARY s.unit_qty AND BINARY t.product_qty<=>BINARY s.product_qty AND BINARY t.source_type<=>BINARY s.source_type AND BINARY t.source_id<=>BINARY s.source_id AND BINARY t.source_label<=>BINARY s.source_label AND BINARY t.product_id<=>BINARY s.product_id AND BINARY t.product_name<=>BINARY s.product_name AND BINARY t.user_id<=>BINARY s.user_id AND BINARY t.user_name<=>BINARY s.user_name AND BINARY t.occurred_at<=>BINARY s.occurred_at AND BINARY t.note<=>BINARY s.note AND BINARY t.client_key<=>BINARY s.client_key AND BINARY t.corrects_movement_id<=>BINARY s.corrects_movement_id AND BINARY t.purchase_priced<=>BINARY s.purchase_priced AND BINARY t.cost_source<=>BINARY s.cost_source AND BINARY t.business_date<=>BINARY s.business_date)) AND (SELECT COUNT(*) FROM ingredient_movements)=(SELECT COUNT(*) FROM stock_movements WHERE movement_type=''ingredient'') INTO @unified_movement_ok','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT (@unified_movement_ok=1),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SELECT GREATEST(@unified_movement_next,COALESCE(MAX(id),0)+1) INTO @unified_movement_next FROM stock_movements;
SET @unified_movement_sql = CONCAT('ALTER TABLE stock_movements AUTO_INCREMENT=',CAST(@unified_movement_next AS CHAR));
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
DROP TABLE IF EXISTS ingredient_movements;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-unified-stock-movements-v1','91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-12-unified-stock-movements-v1 | 91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99

-- BEGIN AUTO MIGRATION: 2026-09-12-held-report-date-index-v1 | 46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034
-- 2026-09-12-held-report-date-index-v1
-- Requires migration: 2026-09-12-unified-stock-movements-v1
-- Requires checksum: 91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99
-- Date access for Y reports; no held content or order identity changes.
SET NAMES utf8mb4;

ALTER TABLE held_orders
  ADD INDEX IF NOT EXISTS idx_held_orders_created_id (created_at, id),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-12-held-report-date-index-v1', '46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-12-held-report-date-index-v1 | 46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034

-- BEGIN AUTO MIGRATION: 2026-09-13-table-action-recovery-v1 | 00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92
-- 2026-09-13-table-action-recovery-v1
-- Requires migration: 2026-09-12-held-report-date-index-v1
-- Requires checksum: 46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034
-- Durable table-action results survive bill deletion, settlement and later moves.
-- No foreign keys: deleting a bill/user/table must not enable replay of an old action.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS table_action_operations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json LONGTEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_table_action_operation (operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-13-table-action-recovery-v1', '00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-13-table-action-recovery-v1 | 00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92

-- BEGIN AUTO MIGRATION: 2026-09-13-paid-split-parent-index-v1 | ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136
-- 2026-09-13-paid-split-parent-index-v1
-- Requires migration: 2026-09-13-table-action-recovery-v1
-- Requires checksum: 00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92
-- Read the matching preflight before manual application. Index only; no bill changes.
SET NAMES utf8mb4;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_parent_payment (parent_invoice_id, payment_method),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-13-paid-split-parent-index-v1', 'ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-13-paid-split-parent-index-v1 | ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136

-- BEGIN AUTO MIGRATION: 2026-09-13-table-seating-v1 | 78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1
-- 2026-09-13-table-seating-v1
-- Requires migration: 2026-09-13-paid-split-parent-index-v1
-- Requires checksum: ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136
-- Seating is independent from the legacy shared-bill parent_table_id relationship.
-- Read the matching preflight before manual application. No bill/item writes.
SET NAMES utf8mb4;

ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS seating_parent_id INT DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_tables_seating_parent (seating_parent_id);

ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_tables_seating_parent FOREIGN KEY IF NOT EXISTS (seating_parent_id)
  REFERENCES restaurant_tables (id) ON DELETE SET NULL;

-- An interrupted application may resume the backfill. Once the ledger exists,
-- raw replay must not restore seating links the operator has since separated.
UPDATE restaurant_tables
   SET seating_parent_id=parent_table_id
 WHERE seating_parent_id IS NULL AND parent_table_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-13-table-seating-v1');

-- Empty groups have no issued bill identity to preserve. Their next orders are
-- independent; existing occupied/printed aliases retain parent_table_id.
UPDATE restaurant_tables
   SET parent_table_id=NULL
 WHERE current_order_id IS NULL AND parent_table_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-13-table-seating-v1');

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-13-table-seating-v1', '78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-13-table-seating-v1 | 78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1

-- BEGIN AUTO MIGRATION: 2026-09-14-deleted-table-items-v1 | b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e
-- 2026-09-14-deleted-table-items-v1
-- Requires migration: 2026-09-13-table-seating-v1
-- Requires checksum: 78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1
-- Future cancellations only. No existing order, item or refund data is changed.
SET NAMES utf8mb4;

ALTER TABLE refunds MODIFY COLUMN invoice_id INT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS deleted (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_id INT NOT NULL,
  source_invoice_id INT NOT NULL,
  source_order_item_id INT NOT NULL,
  source_parent_item_id INT DEFAULT NULL,
  product_id INT DEFAULT NULL,
  item_name VARCHAR(255) DEFAULT NULL,
  quantity DECIMAL(12,6) NOT NULL,
  item_snapshot JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_deleted_event_item (refund_id,source_order_item_id),
  KEY idx_deleted_source_invoice (source_invoice_id),
  CONSTRAINT fk_deleted_refund FOREIGN KEY (refund_id) REFERENCES refunds (id) ON DELETE CASCADE,
  CONSTRAINT chk_deleted_quantity CHECK (quantity > 0 OR (quantity = 0 AND source_parent_item_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-deleted-table-items-v1', 'b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-14-deleted-table-items-v1 | b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e

-- BEGIN AUTO MIGRATION: 2026-09-14-permission-catalog-v1 | 4776f118d24edefde22d81c73fac61ba77485106107fef027d09dc8536ac0883
-- 2026-09-14-permission-catalog-v1
-- Requires migration: 2026-09-14-deleted-table-items-v1
-- Requires checksum: b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e
-- Restore the complete catalog without deleting or granting staff permissions.
SET NAMES utf8mb4;

INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
('pos.checkout', 'Checkout Orders', 'إتمام الطلبات', 'Finalize an order and take payment.', 'إنهاء الطلب واستلام الدفع.', 'pos', 10, 1, 1, 0),
('pos.hold_orders', 'Hold Orders', 'تعليق الطلبات', 'Park an order to retrieve and finish later.', 'تعليق الطلب لاسترجاعه لاحقاً.', 'pos', 20, 1, 1, 0),
('pos.split_checks', 'Split Checks', 'تقسيم الفاتورة', 'Split one bill into multiple checks.', 'تقسيم الفاتورة إلى عدة شيكات.', 'pos', 30, 1, 0, 0),
('pos.discount', 'Discount Button', 'زر الخصم', 'Apply a percent or value discount.', 'تطبيق خصم نسبة أو قيمة.', 'pos', 40, 1, 0, 1),
('pos.price_override', 'Price Override Button', 'تعديل السعر', 'Manually override an item price.', 'تعديل سعر الصنف يدوياً.', 'pos', 50, 1, 0, 1),
('pos.void_item', 'Remove items / clear a table', 'حذف أصناف أو مسح طلب طاولة', 'Remove items or clear an unpaid table order. Saved or printed table items also require Void printed items.', 'حذف أصناف أو مسح طلب طاولة غير مدفوع. الأصناف المحفوظة أو المطبوعة تتطلب أيضاً صلاحية إلغاء الأصناف المطبوعة.', 'pos', 60, 1, 0, 1),
('pos.void_printed_item', 'Void printed items', 'إلغاء الأصناف المطبوعة', 'Allow cancellation of saved or printed table items, together with Remove items / clear a table.', 'السماح بإلغاء أصناف الطاولة المحفوظة أو المطبوعة، مع صلاحية حذف أصناف أو مسح طلب طاولة.', 'pos', 70, 1, 0, 1),
('pos.service_charge', 'Apply Service Charge', 'تطبيق رسوم الخدمة', 'Add the auto-gratuity service charge to an order.', 'إضافة رسوم الخدمة إلى الطلب.', 'pos', 85, 1, 0, 0),
('pos.reprint_receipt', 'Reprint Receipt', 'إعادة طباعة الإيصال', 'Reprint the last or a selected receipt.', 'إعادة طباعة آخر إيصال أو إيصال محدد.', 'pos', 90, 1, 0, 1),
('pos.expenses', 'Record Expenses', 'تسجيل المصروفات', 'Record an expense from the user\'s open cash shift.', 'تسجيل مصروف من وردية الصندوق المفتوحة للمستخدم.', 'pos', 95, 1, 0, 0),
('pos.product_availability', 'Manage Product Availability', 'إدارة توفر الأصناف', 'Mark products as sold out or return them to sale.', 'إيقاف بيع الأصناف النافدة أو إعادتها للبيع.', 'pos', 97, 1, 0, 0),
('pos.subscriptions', 'Manage Subscriptions', 'إدارة الاشتراكات', 'Sell subscriptions and redeem customer meals.', 'بيع الاشتراكات وصرف وجبات العملاء.', 'pos', 98, 1, 0, 1),
('pos.subscription_credit', 'Issue Subscription Credit', 'منح اشتراك آجل', 'Issue a subscription as a receivable invoice.', 'منح اشتراك كفاتورة ذمم آجلة.', 'pos', 99, 1, 0, 1),
('pos.tax_exempt', 'Tax Exempt', 'إعفاء ضريبي', 'Apply tax exemption to the current unpaid check.', 'تطبيق الإعفاء الضريبي على الفاتورة غير المدفوعة الحالية.', 'pos', 100, 1, 0, 0),
('orders.view', 'POS Order History', 'سجل طلبات نقطة البيع', 'View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.', 'عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.', 'orders', 100, 1, 0, 0),
('shift.open', 'Open Register', 'فتح الوردية', 'Open a register shift with a starting float.', 'فتح وردية الصندوق برصيد ابتدائي.', 'shift', 110, 1, 1, 0),
('shift.close', 'Close Own Shift (Z)', 'إغلاق الوردية', 'Close own shift and submit the cash count.', 'إغلاق الوردية وإدخال عدّ النقد.', 'shift', 120, 1, 1, 0),
('tables.access', 'Enter tables', 'دخول الطاولات', 'Open the floor plan and view table orders in assigned sections. Saving and payment use separate permissions.', 'فتح مخطط الطاولات وعرض طلباتها ضمن الأقسام المسموحة. الحفظ والدفع لهما صلاحيات منفصلة.', 'tables', 130, 1, 0, 0),
('pos.refund', 'Refund paid orders', 'إرجاع طلبات مدفوعة', 'Return items or money from a paid order. Unpaid table cancellations use the item-void permissions.', 'إرجاع أصناف أو مبالغ من طلب مدفوع. إلغاء أصناف الطاولات غير المدفوعة يستخدم صلاحيات إلغاء الأصناف.', 'pos', 140, 1, 0, 0),
('waiter.edit_locked', 'Edit Saved Order', 'تعديل طلب محفوظ', 'Edit or add to an order after it has been saved/sent.', 'تعديل أو الإضافة إلى طلب بعد حفظه/إرساله.', 'waiter', 200, 1, 0, 0),
('waiter.override_tables', 'Handle other employees’ tables', 'التعامل مع طاولات موظفين آخرين', 'Work on a table assigned to another employee. Saving, moving, splitting and voiding still need their own permissions.', 'العمل على طاولة مسندة لموظف آخر. الحفظ والنقل والتقسيم والإلغاء تبقى بحاجة لصلاحياتها.', 'waiter', 210, 1, 0, 0),
('waiter.checkout', 'Take payment as a waiter', 'استلام الدفع بصلاحية نادل', 'Let a waiter settle table orders. Cashiers use Checkout orders for payment.', 'السماح للنادل بتحصيل طلبات الطاولات. الكاشير يستخدم صلاحية إتمام الطلبات للدفع.', 'waiter', 220, 1, 0, 0),
('waiter.transfer_table', 'Move tables or items', 'نقل الطاولات أو الأصناف', 'Move a table order or selected saved items to another table. Other employees’ tables need separate access.', 'نقل طلب طاولة أو أصناف محفوظة محددة إلى طاولة أخرى. طاولات الموظفين الآخرين تحتاج صلاحية منفصلة.', 'waiter', 230, 1, 0, 0),
('waiter.merge_tables', 'Join seating / merge bills', 'ضم الجلسات أو دمج الفواتير', 'Join tables into one seating group, separate them again, or combine unpaid bills. Joining seating keeps bills separate.', 'ضم الطاولات في جلسة واحدة أو فصلها، أو جمع الفواتير غير المدفوعة. ضم الجلسات يبقي الفواتير منفصلة.', 'waiter', 240, 1, 0, 0),
('tables.save', 'Save table orders', 'حفظ طلبات الطاولات', 'Let a cashier save a table order and send its items to the kitchen. Requires Enter tables.', 'السماح للكاشير بحفظ طلب الطاولة وإرسال أصنافه إلى المطبخ. يتطلب صلاحية دخول الطاولات.', 'tables', 135, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label=VALUES(label),
  label_ar=VALUES(label_ar),
  description=VALUES(description),
  description_ar=VALUES(description_ar),
  category=VALUES(category),
  sort_order=VALUES(sort_order),
  implemented=VALUES(implemented);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-permission-catalog-v1', '4776f118d24edefde22d81c73fac61ba77485106107fef027d09dc8536ac0883')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-14-permission-catalog-v1 | 4776f118d24edefde22d81c73fac61ba77485106107fef027d09dc8536ac0883

-- BEGIN AUTO MIGRATION: 2026-09-14-table-access-scope-v1 | d468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919
-- 2026-09-14-table-access-scope-v1
-- Requires migration: 2026-09-14-permission-catalog-v1
-- Requires checksum: 4776f118d24edefde22d81c73fac61ba77485106107fef027d09dc8536ac0883
-- Preserve existing effective section access, then make future choices explicit.
SET NAMES utf8mb4;

-- Nullable until backfill so an interrupted DDL/backfill can resume safely.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS table_access_scope ENUM('all','selected','none') DEFAULT NULL AFTER allowed_sections;

UPDATE users
   SET table_access_scope = CASE
     WHEN role IN ('admin','programmer') THEN 'all'
     WHEN role='call_center' THEN 'none'
     WHEN TRIM(COALESCE(allowed_sections,''))<>'' THEN 'selected'
     WHEN role='waiter' THEN 'none'
     ELSE 'all'
   END
 WHERE table_access_scope IS NULL;

-- Direct SQL-created staff default to no sections unless explicitly assigned.
ALTER TABLE users
  MODIFY COLUMN table_access_scope ENUM('all','selected','none') NOT NULL DEFAULT 'selected';

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-table-access-scope-v1', 'd468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-14-table-access-scope-v1 | d468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919

-- BEGIN AUTO MIGRATION: 2026-09-14-permission-catalog-v2 | a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408
-- 2026-09-14-permission-catalog-v2
-- Requires migration: 2026-09-14-table-access-scope-v1
-- Requires checksum: d468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919
-- Align permission descriptions with shared action rules; preserve grants and installation defaults.
SET NAMES utf8mb4;

INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
('pos.checkout', 'Checkout Orders', 'إتمام الطلبات', 'Finalize an order and take payment.', 'إنهاء الطلب واستلام الدفع.', 'pos', 10, 1, 1, 0),
('pos.hold_orders', 'Hold Orders', 'تعليق الطلبات', 'Park an order to retrieve and finish later.', 'تعليق الطلب لاسترجاعه لاحقاً.', 'pos', 20, 1, 1, 0),
('pos.split_checks', 'Split Checks', 'تقسيم الفاتورة', 'Split one bill into multiple checks.', 'تقسيم الفاتورة إلى عدة شيكات.', 'pos', 30, 1, 0, 0),
('pos.discount', 'Discount Button', 'زر الخصم', 'Apply a percent or value discount.', 'تطبيق خصم نسبة أو قيمة.', 'pos', 40, 1, 0, 1),
('pos.price_override', 'Price Override Button', 'تعديل السعر', 'Manually override an item price.', 'تعديل سعر الصنف يدوياً.', 'pos', 50, 1, 0, 1),
('pos.void_item', 'Cancel saved table items', 'إلغاء أصناف الطاولة المحفوظة', 'Cancel saved items or clear an unpaid table. After the guest bill is printed, also enable Cancel after bill print.', 'إلغاء أصناف محفوظة أو مسح طلب طاولة غير مدفوع. بعد طباعة الحساب، يلزم أيضاً تفعيل صلاحية الإلغاء بعد طباعة الحساب.', 'pos', 60, 1, 0, 1),
('pos.void_printed_item', 'Cancel after bill print', 'إلغاء بعد طباعة الحساب', 'Cancel saved table items after the guest bill is printed. Also requires Cancel saved table items.', 'إلغاء أصناف الطاولة المحفوظة بعد طباعة الحساب. يتطلب أيضاً صلاحية إلغاء أصناف الطاولة المحفوظة.', 'pos', 70, 1, 0, 1),
('pos.service_charge', 'Apply Service Charge', 'تطبيق رسوم الخدمة', 'Add the auto-gratuity service charge to an order.', 'إضافة رسوم الخدمة إلى الطلب.', 'pos', 85, 1, 0, 0),
('pos.reprint_receipt', 'Reprint Receipt', 'إعادة طباعة الإيصال', 'Reprint the last or a selected receipt.', 'إعادة طباعة آخر إيصال أو إيصال محدد.', 'pos', 90, 1, 0, 1),
('pos.expenses', 'Record Expenses', 'تسجيل المصروفات', 'Record an expense from the user\'s open cash shift.', 'تسجيل مصروف من وردية الصندوق المفتوحة للمستخدم.', 'pos', 95, 1, 0, 0),
('pos.product_availability', 'Manage Product Availability', 'إدارة توفر الأصناف', 'Mark products as sold out or return them to sale.', 'إيقاف بيع الأصناف النافدة أو إعادتها للبيع.', 'pos', 97, 1, 0, 0),
('pos.subscriptions', 'Manage Subscriptions', 'إدارة الاشتراكات', 'Sell subscriptions and redeem customer meals.', 'بيع الاشتراكات وصرف وجبات العملاء.', 'pos', 98, 1, 0, 1),
('pos.subscription_credit', 'Issue Subscription Credit', 'منح اشتراك آجل', 'Issue a subscription as a receivable invoice.', 'منح اشتراك كفاتورة ذمم آجلة.', 'pos', 99, 1, 0, 1),
('pos.tax_exempt', 'Tax Exempt', 'إعفاء ضريبي', 'Apply tax exemption to the current unpaid check.', 'تطبيق الإعفاء الضريبي على الفاتورة غير المدفوعة الحالية.', 'pos', 100, 1, 0, 0),
('orders.view', 'POS Order History', 'سجل طلبات نقطة البيع', 'View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.', 'عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.', 'orders', 100, 1, 0, 0),
('shift.open', 'Open Register', 'فتح الوردية', 'Open a register shift with a starting float.', 'فتح وردية الصندوق برصيد ابتدائي.', 'shift', 110, 1, 1, 0),
('shift.close', 'Close Own Shift (Z)', 'إغلاق الوردية', 'Close own shift and submit the cash count.', 'إغلاق الوردية وإدخال عدّ النقد.', 'shift', 120, 1, 1, 0),
('tables.access', 'Enter tables', 'دخول الطاولات', 'Open the floor plan and view table orders in assigned sections. Saving and payment use separate permissions.', 'فتح مخطط الطاولات وعرض طلباتها ضمن الأقسام المسموحة. الحفظ والدفع لهما صلاحيات منفصلة.', 'tables', 130, 1, 0, 0),
('pos.refund', 'Refund paid orders', 'إرجاع طلبات مدفوعة', 'Return items or money from a paid order. Unpaid table cancellations use the item-void permissions.', 'إرجاع أصناف أو مبالغ من طلب مدفوع. إلغاء أصناف الطاولات غير المدفوعة يستخدم صلاحيات إلغاء الأصناف.', 'pos', 140, 1, 0, 0),
('waiter.edit_locked', 'Edit saved table orders', 'تعديل طلبات الطاولات المحفوظة', 'Add or change saved table items. Waiters also need this permission for their first save. Cancellations use separate permissions.', 'إضافة أصناف أو تعديلها في طلب طاولة محفوظ. يحتاج النادل هذه الصلاحية أيضاً للحفظ الأول. الإلغاء يحتاج صلاحيات منفصلة.', 'waiter', 200, 1, 0, 0),
('waiter.override_tables', 'Handle other employees’ tables', 'التعامل مع طاولات موظفين آخرين', 'Load or edit another employee’s table order, move its items, or create its split checks. Each action still requires its own permission.', 'فتح طلب طاولة موظف آخر أو تعديله أو نقل أصنافه أو تقسيم حسابه. تبقى صلاحية كل إجراء مطلوبة بشكل منفصل.', 'waiter', 210, 1, 0, 0),
('waiter.checkout', 'Take table payments as a waiter', 'استلام دفعات الطاولات كنادل', 'Let a waiter settle saved table orders and their split checks. Counter sales require Checkout Orders.', 'السماح للنادل بتحصيل طلبات الطاولات المحفوظة وحساباتها المقسمة. مبيعات الكاونتر تحتاج صلاحية إتمام الطلبات.', 'waiter', 220, 1, 0, 0),
('waiter.transfer_table', 'Move tables or items', 'نقل الطاولات أو الأصناف', 'Move a whole order to another table. Moving selected items also requires Edit saved table orders and access to the source order.', 'نقل الطلب كاملاً إلى طاولة أخرى. نقل أصناف محددة يتطلب أيضاً صلاحية تعديل طلبات الطاولات المحفوظة والوصول إلى الطلب الأصلي.', 'waiter', 230, 1, 0, 0),
('waiter.merge_tables', 'Join seating / merge bills', 'ضم الجلسات أو دمج الفواتير', 'Join tables into one seating group, separate them again, or combine unpaid bills. Joining seating keeps bills separate.', 'ضم الطاولات في جلسة واحدة أو فصلها، أو جمع الفواتير غير المدفوعة. ضم الجلسات يبقي الفواتير منفصلة.', 'waiter', 240, 1, 0, 0),
('tables.save', 'Save table orders', 'حفظ طلبات الطاولات', 'Let a cashier save a table order and send its items to the kitchen. Requires Enter tables.', 'السماح للكاشير بحفظ طلب الطاولة وإرسال أصنافه إلى المطبخ. يتطلب صلاحية دخول الطاولات.', 'tables', 135, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label=VALUES(label),
  label_ar=VALUES(label_ar),
  description=VALUES(description),
  description_ar=VALUES(description_ar),
  category=VALUES(category),
  sort_order=VALUES(sort_order),
  implemented=VALUES(implemented);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-permission-catalog-v2', 'a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-14-permission-catalog-v2 | a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408

-- BEGIN AUTO MIGRATION: 2026-09-17-print-queue-timings-v1 | 3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e
-- 2026-09-17-print-queue-timings-v1
-- Requires migration: 2026-09-14-permission-catalog-v2
-- Requires checksum: a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408
-- Store bounded per-job renderer and local transport timing without another write or table.
SET NAMES utf8mb4;

ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS render_duration_ms INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS local_duration_ms INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS renderer VARCHAR(16) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS transport_mode VARCHAR(24) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-17-print-queue-timings-v1', '3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-17-print-queue-timings-v1 | 3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e

-- BEGIN AUTO MIGRATION: 2026-09-19-customer-phone-index-v1 | 3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a
-- 2026-09-19-customer-phone-index-v1
-- Requires migration: 2026-09-17-print-queue-timings-v1
-- Requires checksum: 3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e
-- Index the existing customer-phone normalization without changing raw values or uniqueness.
SET NAMES utf8mb4;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(20)
    GENERATED ALWAYS AS (
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), '')
    ) STORED AFTER phone;

ALTER TABLE customers
  ADD INDEX IF NOT EXISTS idx_customers_phone_normalized (phone_normalized, id);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-19-customer-phone-index-v1', '3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-19-customer-phone-index-v1 | 3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a

-- BEGIN AUTO MIGRATION: 2026-09-20-order-intake-requests-v1 | 8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab
-- 2026-09-20-order-intake-requests-v1
-- Requires migration: 2026-09-19-customer-phone-index-v1
-- Requires checksum: 3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a
-- Keep external request identity after a held order is completed or canceled.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS order_intake_requests (
  client_id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  external_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  held_order_id INT NOT NULL,
  result_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, external_request_id),
  KEY idx_order_intake_held_order (held_order_id),
  KEY idx_order_intake_created_at (created_at),
  CONSTRAINT chk_order_intake_result_json CHECK (JSON_VALID(result_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-20-order-intake-requests-v1', '8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-20-order-intake-requests-v1 | 8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab

-- BEGIN AUTO MIGRATION: 2026-09-22-product-customer-info-v1 | e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30
-- 2026-09-22-product-customer-info-v1
-- Requires migration: 2026-09-20-order-intake-requests-v1
-- Requires checksum: 8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab
-- Optional customer-facing information; no price, stock or order changes.
SET NAMES utf8mb4;
ALTER TABLE products ADD COLUMN IF NOT EXISTS customer_info TEXT DEFAULT NULL, ALGORITHM=INSTANT, LOCK=NONE;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-22-product-customer-info-v1', 'e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-22-product-customer-info-v1 | e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30

-- BEGIN AUTO MIGRATION: 2026-09-23-subscriptions-retirement-v1 | 2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd
-- 2026-09-23-subscriptions-retirement-v1
-- Requires migration: 2026-09-22-product-customer-info-v1
-- Requires checksum: e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30
-- Stop application writers before running. Customer subscription history blocks retirement; unused plan configuration may be dropped.
SET NAMES utf8mb4;
SET @subscription_retirement_empty =
  (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-22-product-customer-info-v1' AND checksum='e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30')=1
  AND (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-23-subscriptions-retirement-v1')=0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items') AND TABLE_TYPE='BASE TABLE' AND ENGINE='InnoDB')=8
  AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items') AND TABLE_NAME NOT IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items'))
  AND (SELECT COUNT(*) FROM customer_subscriptions)=0
  AND (SELECT COUNT(*) FROM customer_subscription_products)=0
  AND (SELECT COUNT(*) FROM subscription_extensions)=0
  AND (SELECT COUNT(*) FROM subscription_collections)=0
  AND (SELECT COUNT(*) FROM subscription_redemptions)=0
  AND (SELECT COUNT(*) FROM subscription_redemption_items)=0;
SET @subscription_retirement_guard = IF(@subscription_retirement_empty, 'SELECT 1', 'SUBSCRIPTION_RETIREMENT_BLOCKED_NONEMPTY_DATA');
PREPARE subscription_retirement_check FROM @subscription_retirement_guard;
EXECUTE subscription_retirement_check;
DEALLOCATE PREPARE subscription_retirement_check;
DROP TABLE subscription_redemption_items;
DROP TABLE subscription_redemptions;
DROP TABLE subscription_collections;
DROP TABLE subscription_extensions;
DROP TABLE customer_subscription_products;
DROP TABLE customer_subscriptions;
DROP TABLE subscription_plan_products;
DROP TABLE subscription_plans;
DELETE FROM user_permissions WHERE perm_key IN ('pos.subscriptions','pos.subscription_credit');
DELETE FROM permissions WHERE perm_key IN ('pos.subscriptions','pos.subscription_credit');
DELETE FROM settings WHERE setting_key='subscription_receivables_enabled';
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-23-subscriptions-retirement-v1', '2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-23-subscriptions-retirement-v1 | 2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd

-- BEGIN AUTO MIGRATION: 2026-09-26-expense-request-id-v1 | 317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63
-- 2026-09-26-expense-request-id-v1
-- Requires migration: 2026-09-23-subscriptions-retirement-v1
-- Requires checksum: 2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd
-- Optional client request id so a retried POS expense replays instead of deducting the drawer twice.
SET NAMES utf8mb4;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS request_id varchar(64) DEFAULT NULL, ALGORITHM=INSTANT, LOCK=NONE;
ALTER TABLE expenses ADD UNIQUE KEY IF NOT EXISTS uq_expenses_request (created_by, request_id), ALGORITHM=INPLACE, LOCK=NONE;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-26-expense-request-id-v1', '317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-26-expense-request-id-v1 | 317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63
-- BEGIN AUTO MIGRATION: 2026-09-30-printer-last-printed-v1 | c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031
-- 2026-09-30-printer-last-printed-v1
-- Requires migration: 2026-09-26-expense-request-id-v1
-- Requires checksum: 317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63
-- When a printer last printed a job, kept on the printer so it survives the daily print_queue purge (UTC).
SET NAMES utf8mb4;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS last_printed_at datetime DEFAULT NULL, ALGORITHM=INSTANT, LOCK=NONE;
-- Seed from acknowledged rows that still exist (they are purged daily, so this scans little); rerun safe.
UPDATE printers p SET p.last_printed_at = (SELECT MAX(q.acknowledged_at) FROM print_queue q WHERE q.printer_id = p.id AND q.status = 'acknowledged') WHERE p.last_printed_at IS NULL;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-30-printer-last-printed-v1', 'c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-30-printer-last-printed-v1 | c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031
-- BEGIN AUTO MIGRATION: 2026-09-30-multi-terminal-permission-v1 | 39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893
-- 2026-09-30-multi-terminal-permission-v1
-- Requires migration: 2026-09-30-printer-last-printed-v1
-- Requires checksum: c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031
-- Install the auth.multi_terminal permission; preserve grants and installation defaults.

SET NAMES utf8mb4;

INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
('auth.multi_terminal', 'Stay signed in on several terminals', 'البقاء مسجلاً على أكثر من جهاز', 'Signing in on another terminal does not sign this employee out of the first one. Both terminals sell into the same shift.', 'تسجيل الدخول من جهاز آخر لا يُخرج الموظف من الجهاز الأول. يبيع الجهازان ضمن الوردية نفسها.', 'auth', 300, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label=VALUES(label),
  label_ar=VALUES(label_ar),
  description=VALUES(description),
  description_ar=VALUES(description_ar),
  category=VALUES(category),
  sort_order=VALUES(sort_order),
  implemented=VALUES(implemented);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-30-multi-terminal-permission-v1',
  '39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-30-multi-terminal-permission-v1 | 39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893
-- BEGIN AUTO MIGRATION: 2026-09-30-purchase-invoices-v1 | d229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9
-- 2026-09-30-purchase-invoices-v1
-- Requires migration: 2026-09-30-multi-terminal-permission-v1
-- Requires checksum: 39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893
-- Purchase invoices: suppliers, invoice headers and lines that post stock through the stock ledger.
-- The retired stock_suppliers, stock_purchase_* and stock_receipts* tables are not reused.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_suppliers (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NULL,
  tax_number VARCHAR(40) NULL,
  notes VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_supplier_name (name),
  CONSTRAINT ck_purchase_supplier_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id INT NOT NULL,
  supplier_invoice_no VARCHAR(60) NOT NULL,
  invoice_date DATE NOT NULL,
  status ENUM('draft','posted','reversed') NOT NULL DEFAULT 'draft',
  payment_status ENUM('paid','credit') NOT NULL DEFAULT 'credit',
  subtotal DECIMAL(14,3) NOT NULL DEFAULT 0,
  tax_total DECIMAL(14,3) NOT NULL DEFAULT 0,
  total DECIMAL(14,3) NOT NULL DEFAULT 0,
  paper_total DECIMAL(14,3) NULL,
  notes VARCHAR(255) NULL,
  cost_includes_tax TINYINT(1) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  create_key VARCHAR(64) NULL,
  post_key VARCHAR(64) NULL,
  reverse_key VARCHAR(64) NULL,
  stock_result JSON NULL,
  created_by INT NULL,
  posted_by INT NULL,
  reversed_by INT NULL,
  posted_at DATETIME NULL,
  reversed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_invoice_supplier_no (supplier_id, supplier_invoice_no),
  UNIQUE KEY uq_purchase_invoice_create_key (create_key),
  UNIQUE KEY uq_purchase_invoice_post_key (post_key),
  UNIQUE KEY uq_purchase_invoice_reverse_key (reverse_key),
  KEY idx_purchase_invoice_status_date (status, invoice_date, id),
  CONSTRAINT fk_purchase_invoice_supplier FOREIGN KEY (supplier_id) REFERENCES purchase_suppliers (id),
  CONSTRAINT ck_purchase_invoice_status CHECK (status IN ('draft','posted','reversed')),
  CONSTRAINT ck_purchase_invoice_payment CHECK (payment_status IN ('paid','credit')),
  CONSTRAINT ck_purchase_invoice_amounts CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  stock_item_id BIGINT UNSIGNED NOT NULL,
  qty DECIMAL(14,3) NOT NULL,
  unit_label VARCHAR(40) NOT NULL,
  unit_factor DECIMAL(16,6) NOT NULL,
  unit_price DECIMAL(14,4) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL,
  line_subtotal DECIMAL(14,3) NOT NULL,
  line_tax DECIMAL(14,3) NOT NULL,
  line_total DECIMAL(14,3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_line_no (invoice_id, line_no),
  KEY idx_purchase_line_item (stock_item_id, invoice_id),
  CONSTRAINT fk_purchase_line_invoice FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_purchase_line_item FOREIGN KEY (stock_item_id) REFERENCES stock_items (id),
  CONSTRAINT ck_purchase_line_qty CHECK (qty > 0),
  CONSTRAINT ck_purchase_line_factor CHECK (unit_factor > 0),
  CONSTRAINT ck_purchase_line_price CHECK (unit_price >= 0),
  CONSTRAINT ck_purchase_line_tax CHECK (tax_rate IN (0,4,16))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-30-purchase-invoices-v1',
  'd229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-09-30-purchase-invoices-v1 | d229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9
-- BEGIN AUTO MIGRATION: 2026-10-01-retire-purchasing-tables-v1 | 1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b
-- 2026-10-01-retire-purchasing-tables-v1
-- Requires migration: 2026-09-30-purchase-invoices-v1
-- Requires checksum: d229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9
-- Retires the purchasing tables that have had no writer since 2026-09-09. Each table is dropped only when it exists and holds no rows; a table with history is kept untouched.

SET NAMES utf8mb4;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustment_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_price_adjustment_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustment_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_price_adjustment_lines'), 'DROP TABLE `stock_price_adjustment_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustments' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_price_adjustments` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustments' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_price_adjustments'), 'DROP TABLE `stock_price_adjustments`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_return_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_vendor_return_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_return_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_vendor_return_lines'), 'DROP TABLE `stock_vendor_return_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_returns' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_vendor_returns` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_returns' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_vendor_returns'), 'DROP TABLE `stock_vendor_returns`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_receipt_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_receipt_lines'), 'DROP TABLE `stock_receipt_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipts' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_receipts` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipts' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_receipts'), 'DROP TABLE `stock_receipts`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_order_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_purchase_order_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_order_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_purchase_order_lines'), 'DROP TABLE `stock_purchase_order_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_orders' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_purchase_orders` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_orders' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_purchase_orders'), 'DROP TABLE `stock_purchase_orders`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_supplier_items' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_supplier_items` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_supplier_items' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_supplier_items'), 'DROP TABLE `stock_supplier_items`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_suppliers' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_suppliers` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_suppliers' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_suppliers'), 'DROP TABLE `stock_suppliers`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-01-retire-purchasing-tables-v1',
  '1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

-- END AUTO MIGRATION: 2026-10-01-retire-purchasing-tables-v1 | 1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b
-- BEGIN AUTO MIGRATION: 2026-10-01-stock-documents-v1 | 81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0
-- 2026-10-01-stock-documents-v1
-- Requires migration: 2026-10-01-retire-purchasing-tables-v1
-- Requires checksum: 1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b
-- Moves purchase invoices into the shared stock_documents / stock_document_lines tables, keeping every id
-- (invoice id = document id, line id = line id) so stock movements and saved stock results still point at them.
-- A line whose stock item is neither a product nor an ingredient stops the upgrade before anything changes.
-- The old purchase_invoices and purchase_invoice_lines tables are dropped only after the copy is verified.

SET NAMES utf8mb4;

SET @sd_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-01-retire-purchasing-tables-v1' AND checksum='1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-01-stock-documents-v1' AND checksum<>'81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0')),'SELECT * FROM posapp_stock_documents_requires_review','SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_ok = 1;
SET @sd_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE'), 'SELECT NOT EXISTS(SELECT 1 FROM purchase_invoice_lines l LEFT JOIN stock_items s ON s.id = l.stock_item_id LEFT JOIN products p ON p.id = s.legacy_product_id LEFT JOIN ingredients g ON g.id = s.legacy_ingredient_id WHERE s.id IS NULL OR (s.legacy_product_id IS NULL AND s.legacy_ingredient_id IS NULL) OR (s.legacy_product_id IS NOT NULL AND s.legacy_ingredient_id IS NOT NULL) OR (s.legacy_product_id IS NOT NULL AND p.id IS NULL) OR (s.legacy_ingredient_id IS NOT NULL AND g.id IS NULL)) INTO @sd_ok', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(NOT (@sd_ok=1), 'SELECT * FROM posapp_stock_documents_requires_review', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;

CREATE TABLE IF NOT EXISTS stock_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_type ENUM('purchase','count') NOT NULL,
  status ENUM('draft','posted','reversed') NOT NULL DEFAULT 'draft',
  supplier_id INT NULL,
  reference VARCHAR(60) NULL,
  doc_date DATE NOT NULL,
  payment_status ENUM('paid','credit') NULL,
  subtotal DECIMAL(14,3) NOT NULL DEFAULT 0,
  tax_total DECIMAL(14,3) NOT NULL DEFAULT 0,
  total DECIMAL(14,3) NOT NULL DEFAULT 0,
  paper_total DECIMAL(14,3) NULL,
  notes VARCHAR(255) NULL,
  cost_includes_tax TINYINT(1) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  create_key VARCHAR(64) NULL,
  post_key VARCHAR(64) NULL,
  reverse_key VARCHAR(64) NULL,
  stock_result JSON NULL,
  created_by INT NULL,
  posted_by INT NULL,
  reversed_by INT NULL,
  posted_at DATETIME NULL,
  reversed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  open_count TINYINT GENERATED ALWAYS AS (IF(doc_type = 'count' AND status = 'draft', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_document_supplier_reference (supplier_id, reference),
  UNIQUE KEY uq_stock_document_create_key (create_key),
  UNIQUE KEY uq_stock_document_post_key (post_key),
  UNIQUE KEY uq_stock_document_reverse_key (reverse_key),
  UNIQUE KEY uq_stock_document_open_count (open_count),
  KEY idx_stock_document_type_status_date (doc_type, status, doc_date, id),
  CONSTRAINT fk_stock_document_supplier FOREIGN KEY (supplier_id) REFERENCES purchase_suppliers (id),
  CONSTRAINT ck_stock_document_shape CHECK (
    (doc_type = 'purchase' AND supplier_id IS NOT NULL AND reference IS NOT NULL AND payment_status IS NOT NULL
      AND subtotal >= 0 AND tax_total >= 0 AND total >= 0)
    OR (doc_type = 'count' AND supplier_id IS NULL AND payment_status IS NULL AND status IN ('draft','posted')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_document_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  product_id INT NULL,
  ingredient_id INT NULL,
  qty DECIMAL(14,3) NULL,
  unit_label VARCHAR(40) NOT NULL,
  unit_factor DECIMAL(16,6) NOT NULL,
  unit_price DECIMAL(14,4) NULL,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_subtotal DECIMAL(14,3) NOT NULL DEFAULT 0,
  line_tax DECIMAL(14,3) NOT NULL DEFAULT 0,
  line_total DECIMAL(14,3) NOT NULL DEFAULT 0,
  expected_qty DECIMAL(16,6) NULL,
  counted_by INT NULL,
  counted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_document_line_no (document_id, line_no),
  UNIQUE KEY uq_stock_document_line_product (document_id, product_id),
  UNIQUE KEY uq_stock_document_line_ingredient (document_id, ingredient_id),
  KEY idx_stock_document_line_product (product_id, document_id),
  KEY idx_stock_document_line_ingredient (ingredient_id, document_id),
  CONSTRAINT fk_stock_document_line_document FOREIGN KEY (document_id) REFERENCES stock_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_document_line_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_stock_document_line_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT ck_stock_document_line_item CHECK (
    (product_id IS NOT NULL AND ingredient_id IS NULL) OR (product_id IS NULL AND ingredient_id IS NOT NULL)),
  CONSTRAINT ck_stock_document_line_qty CHECK (qty IS NULL OR qty >= 0),
  CONSTRAINT ck_stock_document_line_factor CHECK (unit_factor > 0),
  CONSTRAINT ck_stock_document_line_price CHECK (unit_price IS NULL OR unit_price >= 0),
  CONSTRAINT ck_stock_document_line_tax CHECK (tax_rate IN (0,4,16))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @sd_ok = 1;
SET @sd_sql = IF((EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE')), 'INSERT INTO stock_documents (id, doc_type, status, supplier_id, reference, doc_date, payment_status, subtotal, tax_total, total, paper_total, notes, cost_includes_tax, version, create_key, post_key, reverse_key, stock_result, created_by, posted_by, reversed_by, posted_at, reversed_at, created_at, updated_at) SELECT i.id, ''purchase'', i.status, i.supplier_id, i.supplier_invoice_no, i.invoice_date, i.payment_status, i.subtotal, i.tax_total, i.total, i.paper_total, i.notes, i.cost_includes_tax, i.version, i.create_key, i.post_key, i.reverse_key, i.stock_result, i.created_by, i.posted_by, i.reversed_by, i.posted_at, i.reversed_at, i.created_at, i.updated_at FROM purchase_invoices i WHERE NOT EXISTS (SELECT 1 FROM stock_documents d WHERE d.id = i.id)', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF((EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE')), 'INSERT INTO stock_document_lines (id, document_id, line_no, product_id, ingredient_id, qty, unit_label, unit_factor, unit_price, tax_rate, line_subtotal, line_tax, line_total) SELECT l.id, l.invoice_id, l.line_no, s.legacy_product_id, s.legacy_ingredient_id, l.qty, l.unit_label, l.unit_factor, l.unit_price, l.tax_rate, l.line_subtotal, l.line_tax, l.line_total FROM purchase_invoice_lines l JOIN stock_items s ON s.id = l.stock_item_id WHERE NOT EXISTS (SELECT 1 FROM stock_document_lines d WHERE d.id = l.id)', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF((EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE')), 'SELECT (SELECT COUNT(*) FROM purchase_invoices) = (SELECT COUNT(*) FROM stock_documents WHERE doc_type = ''purchase'') AND (SELECT COUNT(*) FROM purchase_invoice_lines) = (SELECT COUNT(*) FROM stock_document_lines l JOIN stock_documents d ON d.id = l.document_id WHERE d.doc_type = ''purchase'') INTO @sd_ok', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(NOT (@sd_ok=1), 'SELECT * FROM posapp_stock_documents_requires_review', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE') AND @sd_ok=1, 'DROP TABLE purchase_invoice_lines', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND @sd_ok=1, 'DROP TABLE purchase_invoices', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-01-stock-documents-v1',
  '81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-10-01-stock-documents-v1 | 81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0
-- BEGIN AUTO MIGRATION: 2026-10-02-purchase-item-kind-v1 | ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e
-- 2026-10-02-purchase-item-kind-v1
-- Requires migration: 2026-10-01-stock-documents-v1
-- Requires checksum: 81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0
-- A purchase invoice holds products or ingredients, never both: stock_documents gets item_kind (NULL on stock counts).
-- Existing purchase documents whose lines are all ingredients (at least one) become 'ingredient'; every other
-- purchase document (product-only, mixed, or without lines) becomes 'product'.
-- The header rule now requires item_kind on purchases and forbids it on counts, and the same supplier invoice number
-- may be entered once per kind. Rerun safe; it stops before changing anything when the predecessor is missing.

SET NAMES utf8mb4;

SET @pk_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-01-stock-documents-v1' AND checksum='81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-02-purchase-item-kind-v1' AND checksum<>'ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e')),'SELECT * FROM posapp_purchase_item_kind_requires_review','SELECT 1');
PREPARE pk_stmt FROM @pk_sql;
EXECUTE pk_stmt;
DEALLOCATE PREPARE pk_stmt;

ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS item_kind ENUM('product','ingredient') NULL AFTER doc_type;

UPDATE stock_documents d
   SET d.item_kind = IF(EXISTS (SELECT 1 FROM stock_document_lines l WHERE l.document_id = d.id)
                          AND NOT EXISTS (SELECT 1 FROM stock_document_lines l WHERE l.document_id = d.id AND l.product_id IS NOT NULL),
                        'ingredient', 'product')
 WHERE d.doc_type = 'purchase' AND d.item_kind IS NULL;

ALTER TABLE stock_documents
  DROP INDEX IF EXISTS uq_stock_document_supplier_reference,
  ADD UNIQUE KEY uq_stock_document_supplier_reference (supplier_id, reference, item_kind);

ALTER TABLE stock_documents
  DROP CONSTRAINT IF EXISTS ck_stock_document_shape,
  ADD CONSTRAINT ck_stock_document_shape CHECK (
    (doc_type = 'purchase' AND item_kind IS NOT NULL AND supplier_id IS NOT NULL AND reference IS NOT NULL AND payment_status IS NOT NULL
      AND subtotal >= 0 AND tax_total >= 0 AND total >= 0)
    OR (doc_type = 'count' AND item_kind IS NULL AND supplier_id IS NULL AND payment_status IS NULL AND status IN ('draft','posted')));

-- Each invoice list (one kind, newest first, optionally one status) reads only its own kind through this index.
ALTER TABLE stock_documents ADD INDEX IF NOT EXISTS idx_stock_document_kind_list (doc_type, item_kind, status, id);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-02-purchase-item-kind-v1',
  'ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-10-02-purchase-item-kind-v1 | ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e

-- BEGIN AUTO MIGRATION: 2026-10-03-product-barcodes-v1 | d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e
-- 2026-10-03-product-barcodes-v1
-- Requires migration: 2026-10-02-purchase-item-kind-v1
-- Requires checksum: ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e
-- A product keeps its main barcode in products.barcode and may hold extra barcodes in product_barcodes.
-- An extra barcode is unique across all products (the application also keeps it distinct from every main barcode),
-- and it follows its product: deleting the product deletes its extras. The barcode column uses the products
-- collation so a lookup compares and uses the index exactly like products.idx_barcode.
-- Rerun safe; it stops before changing anything when the predecessor is missing.

SET NAMES utf8mb4;

SET @pb_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-02-purchase-item-kind-v1' AND checksum='ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-03-product-barcodes-v1' AND checksum<>'d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e')),'SELECT * FROM posapp_product_barcodes_requires_review','SELECT 1');
PREPARE pb_stmt FROM @pb_sql;
EXECUTE pb_stmt;
DEALLOCATE PREPARE pb_stmt;

CREATE TABLE IF NOT EXISTS product_barcodes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT NOT NULL,
  barcode VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_barcode (barcode),
  KEY idx_product_barcodes_product (product_id, id),
  CONSTRAINT fk_product_barcodes_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-03-product-barcodes-v1',
  'd7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-10-03-product-barcodes-v1 | d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e

-- BEGIN AUTO MIGRATION: 2026-10-04-packaging-units-v1 | bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6
-- 2026-10-04-packaging-units-v1
-- Requires migration: 2026-10-03-product-barcodes-v1
-- Requires checksum: d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e
-- Packaging units. A product keeps one stock balance in its base unit; product_packs names the packs it is bought
-- or counted in (a carton of 12, a sack of 10 kg) with how many base units each holds. A pack sold at the register
-- has its own sale product (sale_product_id: its price and barcode) linked to the same stock item. A purchase line may carry
-- free bonus quantity in base units (bonus_qty) that is received with the line without changing what was paid.
-- A category may be kept off the POS product grid (hide_in_pos) while its products still sell by barcode.
-- Rerun safe; it stops before changing anything when the predecessor is missing.

SET NAMES utf8mb4;

SET @pu_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-03-product-barcodes-v1' AND checksum='d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-04-packaging-units-v1' AND checksum<>'bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6')),'SELECT * FROM posapp_packaging_units_requires_review','SELECT 1');
PREPARE pu_stmt FROM @pu_sql;
EXECUTE pu_stmt;
DEALLOCATE PREPARE pu_stmt;

ALTER TABLE categories ADD COLUMN IF NOT EXISTS hide_in_pos TINYINT(1) NOT NULL DEFAULT 0 AFTER is_notes;

ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS bonus_qty DECIMAL(16,6) NOT NULL DEFAULT 0 AFTER qty;

ALTER TABLE stock_document_lines
  DROP CONSTRAINT IF EXISTS ck_stock_document_line_bonus,
  ADD CONSTRAINT ck_stock_document_line_bonus CHECK (bonus_qty >= 0);

CREATE TABLE IF NOT EXISTS product_packs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT NOT NULL,
  label VARCHAR(40) NOT NULL,
  factor DECIMAL(16,6) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  sale_product_id INT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_pack_label (product_id, label),
  UNIQUE KEY uq_product_pack_sale_product (sale_product_id),
  CONSTRAINT fk_product_packs_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_product_packs_sale_product FOREIGN KEY (sale_product_id) REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT ck_product_pack_factor CHECK (factor > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-04-packaging-units-v1',
  'bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
-- END AUTO MIGRATION: 2026-10-04-packaging-units-v1 | bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6