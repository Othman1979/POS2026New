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
