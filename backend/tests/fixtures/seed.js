// seed.js — Creates and populates the posapp_test database with the minimum
// data required for Phase A integration tests.
//
// Design principles:
//   - Repeatable: recreate tables only in an allowlisted local test database.
//   - Minimal: only the tables and rows needed for the test suite.
//   - Deterministic: all IDs are fixed constants exported for use in tests.
//   - Self-contained: no dependency on the production database.

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.test'), override: true });

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getTestDatabaseOptions } = require('../testDatabase.cjs');

// ─── Constants exported for test files ───────────────────────────────────────
const SEED = {
    adminUser: { id: 1, user_number: '9001', name: 'Test Admin', role: 'admin', pin: '1234' },
    cashierUser: { id: 2, user_number: '9002', name: 'Test Cashier', role: 'cashier' },
    waiterUser: { id: 3, user_number: '9003', name: 'Test Waiter', role: 'waiter' },
    inactiveUser: { id: 4, user_number: '9004', name: 'Inactive User', role: 'cashier' },
    priceOverrideUser: { id: 5, user_number: '9005', name: 'Price Override Cashier', role: 'cashier' },
    priceOverrideWaiter: { id: 6, user_number: '9006', name: 'Price Override Waiter', role: 'waiter' },
    product1: { id: 1, name: 'Test Burger', price: 5.00, tax_rate: 16 },
    product2: { id: 2, name: 'Test Drink', price: 2.00, tax_rate: 0 },
    modifierProduct: { id: 10, name: 'Modifier Product', price: 5.00, tax_rate: 16 },
    bundleProduct: { id: 4, name: 'Family Package', price: 10.00, tax_rate: 16 },
    category: { id: 1, name: 'Test Category' },
    orderType: { id: 1, name: 'Dine In' },
    section: { id: 1, name: 'Test Section' },
    table: { id: 1, table_number: 1 },
    table2: { id: 2, table_number: 2 },
};

function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

async function createTestDatabase(conn, dbName) {
    // Create the test DB if it doesn't exist (the pool connection might already be on it)
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${dbName}\``);
}

async function createSchema(conn) {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    // Drop all test tables in reverse FK order
    const drops = [
        'stock_document_lines', 'stock_documents', 'purchase_invoice_lines', 'purchase_invoices', 'purchase_suppliers',
        'stock_price_adjustment_lines', 'stock_price_adjustments', 'stock_vendor_return_lines', 'stock_vendor_returns',
        'stock_receipt_lines', 'stock_receipts', 'stock_purchase_order_lines', 'stock_purchase_orders',
        'stock_supplier_items', 'stock_suppliers',
        'stock_report_daily', 'ingredient_working_balances', 'stock_report_counts', 'stock_report_count_corrections', 'stock_report_meals', 'stock_report_ingredients', 'stock_report_events', 'stock_report_operations',
        'stock_report_backfill', 'stock_report_dirty', 'stock_report_worker', 'stock_report_builds',
        'stock_operation_sources', 'stock_ingredient_links',
        'stock_movements', 'stock_balances', 'product_stock_links', 'stock_lots', 'stock_items', 'stock_locations',
        'stock_operations', 'recipe_ledger_lines', 'ingredient_movements', 'product_recipe_lines', 'ingredients',
        'subscription_redemption_items', 'subscription_redemptions', 'subscription_collections', 'subscription_extensions',
        'customer_subscription_products', 'customer_subscriptions', 'subscription_plan_products', 'subscription_plans',
        'jofotara_documents', 'deleted', 'refund_items', 'refunds', 'expenses', 'expense_categories',
        'audit_report_documents', 'order_intake_requests', 'table_action_operations',
        'user_permissions', 'permissions', 'price_history',
        'platform_remittance_adjustments', 'platform_remittance_lines', 'platform_remittances',
        'bundle_modifications', 'product_bundle_items', 'order_items', 'orders', 'y_held_report_archives', 'master_held', 'held_orders', 'service_charge_snapshots', 'shifts', 'invoice_sequences', 'daily_order_type_sequences', 'daily_sequences',
        'print_template_revision_tests', 'print_template_revisions', 'print_templates',
        'print_queue', 'spooler_agents', 'spooler_stations', 'qr_table_drafts', 'restaurant_tables', 'sections',
        'printer_categories', 'printers', 'product_price_overrides', 'products', 'categories',
        'webauthn_ceremonies', 'auth_sessions', 'webauthn_credentials', 'webauthn_recovery_codes',
        'order_types', 'customers', 'users', 'settings', 'audit_events', 'schema_migrations',
    ];
    for (const t of drops) {
        await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }

    await conn.query(`CREATE TABLE IF NOT EXISTS table_action_operations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json LONGTEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_table_action_operation (operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

    await conn.query(`CREATE TABLE order_intake_requests (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

    // Create tables (exact schema from production/development)
    await conn.query(`
        CREATE TABLE settings (
          setting_key varchar(50) NOT NULL,
          setting_value text NOT NULL,
          PRIMARY KEY (setting_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE schema_migrations (
          migration_name varchar(190) NOT NULL,
          checksum char(64) NOT NULL,
          applied_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (migration_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE users (
          id int(11) NOT NULL AUTO_INCREMENT,
          user_number varchar(50) NOT NULL,
          name varchar(100) NOT NULL,
          role enum('admin','cashier','programmer','waiter','table_manager','call_center') NOT NULL DEFAULT 'cashier',
          allowed_sections varchar(255) DEFAULT NULL,
          table_access_scope enum('all','selected','none') NOT NULL DEFAULT 'selected',
          webauthn_user_handle varbinary(64) DEFAULT NULL,
          is_active tinyint(1) DEFAULT 1,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          admin_pin varchar(64) DEFAULT NULL,
          xyz tinyint(1) NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          UNIQUE KEY user_number (user_number),
          UNIQUE KEY uq_users_webauthn_user_handle (webauthn_user_handle),
          KEY idx_users_admin_pin (admin_pin)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE webauthn_recovery_codes (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          batch_id char(36) NOT NULL,
          code_hash char(64) NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          created_by_user_id int DEFAULT NULL,
          expires_at datetime DEFAULT NULL,
          used_at datetime DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_webauthn_recovery_code_hash (code_hash),
          KEY idx_webauthn_recovery_user_batch (user_id,batch_id,used_at),
          KEY idx_webauthn_recovery_expiry (expires_at,used_at),
          CONSTRAINT fk_webauthn_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_webauthn_recovery_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE webauthn_credentials (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          credential_lookup binary(32) NOT NULL,
          credential_id varbinary(1024) NOT NULL,
          public_key blob NOT NULL,
          counter bigint unsigned NOT NULL DEFAULT 0,
          device_type enum('singleDevice','multiDevice') NOT NULL,
          backed_up tinyint(1) NOT NULL DEFAULT 0,
          authenticator_attachment enum('platform','cross-platform') DEFAULT NULL,
          transports varchar(255) DEFAULT NULL,
          aaguid char(36) DEFAULT NULL,
          attestation_format varchar(32) DEFAULT NULL,
          device_label varchar(100) NOT NULL,
          status enum('active','revoked') NOT NULL DEFAULT 'active',
          registered_by_user_id int DEFAULT NULL,
          registered_at datetime NOT NULL DEFAULT current_timestamp(),
          last_used_at datetime DEFAULT NULL,
          revoked_at datetime DEFAULT NULL,
          revoked_by_user_id int DEFAULT NULL,
          revoke_reason varchar(255) DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_webauthn_credential_lookup (credential_lookup),
          KEY idx_webauthn_credentials_user_status (user_id,status),
          KEY idx_webauthn_credentials_last_used (last_used_at),
          CONSTRAINT fk_webauthn_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_webauthn_credentials_registrar FOREIGN KEY (registered_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT fk_webauthn_credentials_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE auth_sessions (
          id char(36) NOT NULL,
          token_hash char(64) NOT NULL,
          user_id int NOT NULL,
          credential_id bigint unsigned DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          last_seen_at datetime NOT NULL DEFAULT current_timestamp(),
          idle_expires_at datetime NOT NULL,
          absolute_expires_at datetime NOT NULL,
          webauthn_verified_at datetime DEFAULT NULL,
          revoked_at datetime DEFAULT NULL,
          revoke_reason varchar(100) DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_auth_sessions_token_hash (token_hash),
          KEY idx_auth_sessions_user_active (user_id,revoked_at,idle_expires_at),
          KEY idx_auth_sessions_credential_active (credential_id,revoked_at,idle_expires_at),
          CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_auth_sessions_credential FOREIGN KEY (credential_id) REFERENCES webauthn_credentials(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE webauthn_ceremonies (
          id char(36) NOT NULL,
          flow enum('bootstrap_registration','enrollment_registration','authentication','step_up','recovery_registration') NOT NULL,
          user_id int DEFAULT NULL,
          requesting_user_id int DEFAULT NULL,
          replacement_credential_id bigint unsigned DEFAULT NULL,
          recovery_code_id bigint unsigned DEFAULT NULL,
          is_decoy tinyint(1) NOT NULL DEFAULT 0,
          challenge varbinary(128) NOT NULL,
          enrollment_token_hash char(64) DEFAULT NULL,
          enrollment_expires_at datetime DEFAULT NULL,
          intended_device_label varchar(100) DEFAULT NULL,
          attempt_count tinyint unsigned NOT NULL DEFAULT 0,
          issued_at datetime NOT NULL DEFAULT current_timestamp(),
          expires_at datetime NOT NULL,
          consumed_at datetime DEFAULT NULL,
          terminal_state enum('pending','consumed','expired','cancelled','failed') NOT NULL DEFAULT 'pending',
          PRIMARY KEY (id),
          KEY idx_webauthn_ceremonies_flow_user (flow,user_id,terminal_state,expires_at),
          KEY idx_webauthn_ceremonies_challenge (challenge,terminal_state,expires_at),
          KEY idx_webauthn_ceremonies_token (enrollment_token_hash,enrollment_expires_at),
          KEY idx_webauthn_ceremonies_recovery (recovery_code_id,terminal_state),
          CONSTRAINT fk_webauthn_ceremonies_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT fk_webauthn_ceremonies_requester FOREIGN KEY (requesting_user_id) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT fk_webauthn_ceremonies_replacement FOREIGN KEY (replacement_credential_id) REFERENCES webauthn_credentials(id) ON DELETE SET NULL,
          CONSTRAINT fk_webauthn_ceremonies_recovery FOREIGN KEY (recovery_code_id) REFERENCES webauthn_recovery_codes(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE service_charge_snapshots (
          id char(36) NOT NULL,
          percentage decimal(7,4) NOT NULL,
          tax_rate decimal(5,2) NOT NULL,
          jofotara_tax_category char(1) NOT NULL DEFAULT 'O',
          parent_snapshot_id char(36) DEFAULT NULL,
          state enum('draft','held','claimed','open_order','split_parent','finalized','abandoned') NOT NULL,
          holder_type enum('none','held_order','claim','order') NOT NULL DEFAULT 'none',
          holder_id varchar(80) DEFAULT NULL,
          claim_token_hash char(64) DEFAULT NULL,
          created_by int(11) NOT NULL,
          version int(11) NOT NULL DEFAULT 1,
          expires_at datetime DEFAULT NULL,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_scs_state_expires (state, expires_at),
          KEY idx_scs_holder (holder_type, holder_id),
          KEY idx_scs_parent (parent_snapshot_id),
          CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots(id),
          CONSTRAINT fk_scs_creator FOREIGN KEY (created_by) REFERENCES users(id),
          CONSTRAINT chk_service_charge_snapshots_jofotara_tax_category CHECK (jofotara_tax_category IN ('S','Z','O'))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE permissions (
          perm_key        VARCHAR(64)  NOT NULL,
          label           VARCHAR(120) NOT NULL,
          label_ar        VARCHAR(120) NOT NULL,
          description     VARCHAR(255) NOT NULL DEFAULT '',
          description_ar  VARCHAR(255) NOT NULL DEFAULT '',
          category        VARCHAR(32)  NOT NULL,
          sort_order      INT          NOT NULL DEFAULT 0,
          implemented     TINYINT(1)   NOT NULL DEFAULT 1,
          default_cashier TINYINT(1)   NOT NULL DEFAULT 0,
          overridable     TINYINT(1)   NOT NULL DEFAULT 0,
          PRIMARY KEY (perm_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE user_permissions (
          user_id  INT         NOT NULL,
          perm_key VARCHAR(64) NOT NULL,
          PRIMARY KEY (user_id, perm_key),
          KEY idx_user_permissions_perm (perm_key),
          CONSTRAINT fk_uperm_user FOREIGN KEY (user_id)  REFERENCES users(id)            ON DELETE CASCADE,
          CONSTRAINT fk_uperm_perm FOREIGN KEY (perm_key) REFERENCES permissions(perm_key) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE audit_report_documents (
          id INT NOT NULL AUTO_INCREMENT,
          report_type ENUM('x_audit','z_audit') NOT NULL,
          serial_no INT NOT NULL,
          serial_label VARCHAR(32) NOT NULL,
          business_date DATE NOT NULL,
          business_start_at DATETIME NOT NULL,
          business_end_at DATETIME NOT NULL,
          z_business_date_lock DATE DEFAULT NULL,
          status ENUM('issued','voided') NOT NULL DEFAULT 'issued',
          payload_json JSON NOT NULL,
          payload_hash CHAR(64) NOT NULL,
          issued_by_user_id INT NOT NULL,
          issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_print_status ENUM('queued','printed','failed','browser_ready') NOT NULL DEFAULT 'queued',
          last_print_error TEXT DEFAULT NULL,
          last_printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_printed_by_user_id INT DEFAULT NULL,
          reprint_count INT NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          UNIQUE KEY uq_audit_serial (report_type, serial_no),
          UNIQUE KEY uq_audit_z_business_date (report_type, z_business_date_lock),
          KEY idx_audit_business_date (business_date, report_type),
          KEY idx_audit_issued_at (issued_at),
          CONSTRAINT fk_audit_documents_user FOREIGN KEY (issued_by_user_id) REFERENCES users(id),
          CONSTRAINT fk_audit_documents_last_printed_by FOREIGN KEY (last_printed_by_user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(require('../../config/permissionCatalog').permissionCatalogSql());

    await conn.query(`
        CREATE TABLE categories (
          id int(11) NOT NULL AUTO_INCREMENT,
          parent_id int(11) DEFAULT NULL,
          name varchar(50) NOT NULL,
          is_active tinyint(1) DEFAULT 1,
          is_notes tinyint(1) DEFAULT 0,
          price_list_root_id int(11) DEFAULT NULL,
          PRIMARY KEY (id),
          KEY idx_categories_parent_id (parent_id),
          KEY idx_categories_price_list_tree (price_list_root_id, is_active, id),
          CONSTRAINT fk_categories_price_list_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE products (
          id int(11) NOT NULL AUTO_INCREMENT,
          category_id int(11) DEFAULT NULL,
          barcode varchar(50) DEFAULT NULL,
          sku varchar(50) DEFAULT NULL,
          name varchar(100) NOT NULL,
          price decimal(10,6) NOT NULL,
          cost_price decimal(10,2) DEFAULT 0.00,
          modifiers longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(modifiers)),
          tax_rate decimal(5,2) DEFAULT 0.00,
          jofotara_tax_category char(1) NOT NULL DEFAULT 'O',
          image varchar(255) DEFAULT NULL,
          color varchar(20) DEFAULT 'bg-blue-500',
          is_active tinyint(1) DEFAULT 1,
          is_available tinyint(1) NOT NULL DEFAULT 1,
          stock decimal(16,6) DEFAULT NULL,
          min_stock_level decimal(16,6) DEFAULT 10,
          max_stock_level decimal(16,6) DEFAULT 100,
          show_in_grid tinyint(1) NOT NULL DEFAULT 1,
          is_bundle tinyint(1) NOT NULL DEFAULT 0,
          background_color varchar(7) DEFAULT NULL,
          price_override_locked tinyint(1) NOT NULL DEFAULT 0,
          customer_info text DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY idx_barcode (barcode),
          UNIQUE KEY sku (sku),
          KEY products_ibfk_1 (category_id),
          KEY idx_products_active_name (is_active,name),
          KEY idx_products_active_category (is_active,category_id),
          KEY idx_products_stock_alert (is_active,stock),
          KEY idx_products_active_id (is_active,id),
          CONSTRAINT products_ibfk_1 FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL,
          CONSTRAINT chk_products_jofotara_tax_category CHECK (jofotara_tax_category IN ('S','Z','O'))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE product_price_overrides (
          price_list_root_id int(11) NOT NULL,
          product_id int(11) NOT NULL,
          price decimal(10,6) NOT NULL,
          updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (price_list_root_id, product_id),
          CONSTRAINT fk_product_price_overrides_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE CASCADE,
          CONSTRAINT fk_product_price_overrides_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
          CONSTRAINT chk_product_price_overrides_nonnegative CHECK (price >= 0)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE price_history (
          id int(10) unsigned NOT NULL AUTO_INCREMENT,
          product_id int(10) unsigned NOT NULL,
          old_price decimal(10,6) NOT NULL,
          new_price decimal(10,6) NOT NULL,
          changed_by int(10) unsigned NOT NULL COMMENT 'users.id of the admin who changed the price',
          changed_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_price_history_product (product_id),
          KEY idx_price_history_changed_at (changed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
        CREATE TABLE order_types (
          id int(11) NOT NULL AUTO_INCREMENT,
          name varchar(100) NOT NULL,
          is_active tinyint(1) DEFAULT 1,
          requires_hash tinyint(1) DEFAULT 0,
          is_deferred_settlement tinyint(1) NOT NULL DEFAULT 0,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE sections (
          id int(11) NOT NULL AUTO_INCREMENT,
          name varchar(100) NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE restaurant_tables (
          id int(11) NOT NULL AUTO_INCREMENT,
          section_id int(11) NOT NULL,
          table_number varchar(50) NOT NULL,
          status enum('available','occupied','printed') DEFAULT 'available',
          current_order_id int(11) DEFAULT NULL,
          x_pos int(11) DEFAULT 20,
          y_pos int(11) DEFAULT 20,
          qr_code_token varchar(32) DEFAULT NULL,
          parent_table_id int(11) DEFAULT NULL,
          seating_parent_id int(11) DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_table_section_number (section_id,table_number),
          UNIQUE KEY qr_code_token (qr_code_token),
          KEY idx_tables_parent_table_id (parent_table_id),
          KEY idx_tables_seating_parent (seating_parent_id),
          CONSTRAINT fk_tables_seating_parent FOREIGN KEY (seating_parent_id) REFERENCES restaurant_tables (id) ON DELETE SET NULL,
          CONSTRAINT fk_parent_table FOREIGN KEY (parent_table_id) REFERENCES restaurant_tables (id) ON DELETE SET NULL,
          CONSTRAINT restaurant_tables_ibfk_1 FOREIGN KEY (section_id) REFERENCES sections (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE shifts (
          id int(11) NOT NULL AUTO_INCREMENT,
          user_id int(11) NOT NULL,
          opened_at timestamp NOT NULL DEFAULT current_timestamp(),
          closed_at timestamp NULL DEFAULT NULL,
          starting_cash decimal(10,2) DEFAULT 0.00,
          expected_cash decimal(10,2) DEFAULT 0.00,
          actual_cash decimal(10,2) DEFAULT 0.00,
          status enum('open','closed') DEFAULT 'open',
          final_gross_sales decimal(15,2) DEFAULT 0.00,
          final_cash_sales decimal(15,2) DEFAULT 0.00,
          final_card_sales decimal(15,2) DEFAULT 0.00,
          final_discounts decimal(15,2) DEFAULT 0.00,
          final_tax decimal(15,2) DEFAULT 0.00,
          last_order_seq int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          KEY user_id (user_id),
          CONSTRAINT shifts_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE expense_categories (
          id int(11) NOT NULL AUTO_INCREMENT,
          name varchar(120) NOT NULL,
          is_active tinyint(1) NOT NULL DEFAULT 1,
          sort_order int(11) NOT NULL DEFAULT 0,
          created_by int(11) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY uq_expense_categories_name (name),
          KEY idx_expense_categories_active_sort (is_active,sort_order,id),
          CONSTRAINT fk_expense_categories_user FOREIGN KEY (created_by) REFERENCES users (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE expenses (
          id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
          category_id int(11) NOT NULL,
          amount decimal(10,2) NOT NULL,
          source varchar(16) NOT NULL,
          shift_id int(11) DEFAULT NULL,
          note varchar(255) NOT NULL DEFAULT '',
          status varchar(16) NOT NULL DEFAULT 'active',
          created_by int(11) NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          canceled_by int(11) DEFAULT NULL,
          canceled_at datetime DEFAULT NULL,
          request_id varchar(64) DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_expenses_request (created_by,request_id),
          KEY idx_expenses_created_status (created_at,status),
          KEY idx_expenses_shift_status (shift_id,status),
          KEY idx_expenses_category_created (category_id,created_at),
          KEY idx_expenses_created_by (created_by),
          CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories (id),
          CONSTRAINT fk_expenses_shift FOREIGN KEY (shift_id) REFERENCES shifts (id),
          CONSTRAINT fk_expenses_created_by FOREIGN KEY (created_by) REFERENCES users (id),
          CONSTRAINT fk_expenses_canceled_by FOREIGN KEY (canceled_by) REFERENCES users (id),
          CONSTRAINT chk_expenses_amount CHECK (amount >= 0),
          CONSTRAINT chk_expenses_source CHECK (source IN ('drawer','outside')),
          CONSTRAINT chk_expenses_status CHECK (status IN ('active','canceled')),
          CONSTRAINT chk_expenses_drawer_shift CHECK ((source='drawer' AND shift_id IS NOT NULL) OR (source='outside' AND shift_id IS NULL))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE ingredients (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE product_recipe_lines (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE recipe_ledger_lines (
          line_key char(32) NOT NULL PRIMARY KEY,
          ingredient_ids JSON NOT NULL,
          CONSTRAINT chk_rll_array CHECK (JSON_TYPE(ingredient_ids)='ARRAY')
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE ingredient_movements (
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
          KEY idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date),
          KEY idx_im_ingredient_kind_id (ingredient_id, kind, id),
          KEY idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost),
          KEY idx_im_line_key (line_key),
          KEY idx_im_source (source_type, source_id),
          CONSTRAINT fk_im_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
          CONSTRAINT chk_im_signs CHECK (
            (kind IN ('usage','waste') AND qty <= 0) OR
            (kind IN ('reversal','receipt') AND qty >= 0) OR
            (kind = 'count' AND qty >= 0) OR
            kind = 'correction'),
          CONSTRAINT chk_im_reason CHECK (kind = 'waste' OR reason IS NULL)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE customers (
          id int(11) NOT NULL AUTO_INCREMENT,
          phone varchar(20) NOT NULL,
          phone_normalized varchar(20) GENERATED ALWAYS AS (replace(replace(replace(replace(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+',''),'.',''),char(9),''),char(10),''),char(13),'')) STORED,
          name varchar(100) DEFAULT NULL,
          address text DEFAULT NULL,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY phone (phone),
          KEY idx_customers_phone_normalized (phone_normalized,id),
          KEY idx_customers_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE orders (
          invoice_id int(11) NOT NULL AUTO_INCREMENT,
          order_id int(11) DEFAULT NULL,
          order_seq_scope varchar(40) DEFAULT NULL,
          invoice_number int(11) DEFAULT NULL,
          invoice_issued_at datetime DEFAULT NULL,
          user_id int(11) NOT NULL,
          waiter_id int(11) DEFAULT NULL,
          shift_id int(11) DEFAULT NULL,
          order_type_id int(11) DEFAULT NULL,
          customer_id int(11) DEFAULT NULL,
          table_id int(11) DEFAULT NULL,
          call_center_user_id int(11) DEFAULT NULL,
          delivery_date datetime DEFAULT NULL,
          subtotal decimal(10,2) NOT NULL,
          tax decimal(10,2) NOT NULL,
          tax_inclusive_at_sale tinyint(1) DEFAULT NULL,
          receipt_tax_inclusive_at_sale tinyint(1) DEFAULT NULL,
          tax_registration_type_at_sale enum('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax',
          tax_exempt_at_sale tinyint(1) NOT NULL DEFAULT 0,
          total decimal(10,2) NOT NULL,
          payment_method enum('cash','card','split','receivable','platform','unpaid_table','voided') NOT NULL,
          payment_due_on date DEFAULT NULL,
          receivable_reason varchar(255) DEFAULT NULL,
          buyer_name_at_sale varchar(100) DEFAULT NULL,
          buyer_phone_at_sale varchar(20) DEFAULT NULL,
          buyer_address_at_sale text DEFAULT NULL,
          note text DEFAULT NULL,
          discount_type enum('percent','fixed') DEFAULT NULL,
          discount_value decimal(10,2) DEFAULT 0.00,
          amount_tendered decimal(10,2) DEFAULT NULL,
          cash_amount decimal(10,2) DEFAULT 0.00,
          card_amount decimal(10,2) DEFAULT 0.00,
          change_due decimal(10,2) DEFAULT 0.00,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          hash_number varchar(100) DEFAULT NULL,
          version int(11) DEFAULT 1,
          idempotency_key varchar(80) DEFAULT NULL,
          void_reason varchar(255) DEFAULT NULL,
          parent_invoice_id int(11) DEFAULT NULL,
          refund_status enum('none','partial','full') NOT NULL DEFAULT 'none',
          original_total decimal(10,3) DEFAULT NULL,
          original_subtotal decimal(10,3) DEFAULT NULL,
          original_tax decimal(10,3) DEFAULT NULL,
          service_charge_snapshot_id char(36) DEFAULT NULL,
          PRIMARY KEY (invoice_id),
          UNIQUE KEY uq_orders_invoice_number (invoice_number),
          UNIQUE KEY uq_orders_seq_scope (order_seq_scope, order_id),
          UNIQUE KEY uq_orders_idempotency (idempotency_key),
          KEY idx_orders_invoice_issued_at (invoice_issued_at),
          KEY user_id (user_id),
          KEY idx_orders_waiter_id (waiter_id),
          KEY idx_orders_order_type_id (order_type_id),
          KEY idx_orders_created_at (created_at),
          KEY idx_orders_payment_created (payment_method,created_at),
          KEY idx_orders_parent_payment (parent_invoice_id,payment_method),
          KEY idx_orders_shift_payment (shift_id,payment_method),
          KEY idx_orders_customer_payment (customer_id,payment_method),
          KEY idx_orders_receivable_due (payment_method,payment_due_on,invoice_id),
          KEY idx_orders_platform_provider (payment_method,order_type_id,invoice_id),
          KEY idx_orders_order_id (order_id),
          KEY idx_orders_table_id (table_id),
          KEY idx_orders_call_center_user (call_center_user_id),
          KEY idx_orders_service_charge_snapshot (service_charge_snapshot_id),
          CONSTRAINT orders_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id),
          CONSTRAINT orders_ibfk_2 FOREIGN KEY (shift_id) REFERENCES shifts (id),
          CONSTRAINT fk_orders_waiter FOREIGN KEY (waiter_id) REFERENCES users (id),
          CONSTRAINT fk_orders_order_type FOREIGN KEY (order_type_id) REFERENCES order_types (id),
          CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
          CONSTRAINT fk_orders_table FOREIGN KEY (table_id) REFERENCES restaurant_tables (id),
          CONSTRAINT fk_orders_call_center_user FOREIGN KEY (call_center_user_id) REFERENCES users (id) ON DELETE RESTRICT,
          CONSTRAINT fk_orders_service_charge_snapshot FOREIGN KEY (service_charge_snapshot_id) REFERENCES service_charge_snapshots (id),
          CONSTRAINT chk_orders_receivable_terms CHECK ((payment_method='receivable' AND payment_due_on IS NOT NULL AND char_length(trim(receivable_reason)) > 0 AND char_length(trim(buyer_name_at_sale)) > 0 AND coalesce(cash_amount,0)=0 AND coalesce(card_amount,0)=0 AND coalesce(amount_tendered,0)=0 AND coalesce(change_due,0)=0) OR (payment_method<>'receivable' AND payment_due_on IS NULL AND receivable_reason IS NULL))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE platform_remittances (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE platform_remittance_lines (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE platform_remittance_adjustments (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE order_items (
          id int(11) NOT NULL AUTO_INCREMENT,
          invoice_id int(11) NOT NULL,
          product_id int(11) DEFAULT NULL,
          item_name varchar(255) DEFAULT NULL,
          quantity decimal(12,6) NOT NULL,
          price_at_sale decimal(10,6) NOT NULL,
          price_before_tax_exemption decimal(10,6) DEFAULT NULL,
          tax_rate decimal(10,2) NOT NULL DEFAULT 0.00,
          jofotara_tax_category char(1) NOT NULL DEFAULT 'O',
          tax_amount decimal(10,6) NOT NULL DEFAULT 0,
          note text DEFAULT NULL,
          discount_type enum('percent','fixed') DEFAULT NULL,
          discount_value decimal(10,2) DEFAULT 0.00,
          sort_order int(11) DEFAULT 0,
          parent_item_id int(11) DEFAULT NULL,
          selected_modifiers longtext DEFAULT NULL,
          modifier_surcharge decimal(10,6) DEFAULT NULL,
          modifier_tax_amount decimal(10,6) DEFAULT NULL,
          recipe_line_key char(32) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_order_items_invoice (invoice_id),
          KEY idx_order_items_product (product_id),
          UNIQUE KEY uq_order_items_id_invoice (id, invoice_id),
          KEY idx_order_items_parent_invoice (parent_item_id, invoice_id),
          KEY idx_order_items_recipe_line_key (recipe_line_key),
          CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0),
          CONSTRAINT chk_order_items_jofotara_tax_category CHECK (jofotara_tax_category IN ('S','Z','O')),
          CONSTRAINT order_items_ibfk_1 FOREIGN KEY (invoice_id) REFERENCES orders (invoice_id) ON DELETE CASCADE,
          CONSTRAINT order_items_ibfk_2 FOREIGN KEY (product_id) REFERENCES products (id),
          CONSTRAINT fk_order_items_parent_invoice
            FOREIGN KEY (parent_item_id, invoice_id)
            REFERENCES order_items (id, invoice_id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE refunds (
          id INT NOT NULL AUTO_INCREMENT,
          kind ENUM('void','refund') NOT NULL,
          invoice_id INT NOT NULL,
          scope ENUM('order','item') NOT NULL DEFAULT 'order',
          subtotal_refunded DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          tax_refunded DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          amount_refunded DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          refund_method VARCHAR(20) DEFAULT NULL,
          reason TEXT DEFAULT NULL,
          restocked TINYINT(1) NOT NULL DEFAULT 0,
          user_id INT NOT NULL,
          shift_id INT DEFAULT NULL,
          table_id INT DEFAULT NULL,
          table_number VARCHAR(50) DEFAULT NULL,
          ip_address VARCHAR(64) DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_refunds_invoice (invoice_id),
          KEY idx_refunds_kind (kind),
          KEY idx_refunds_created (created_at),
          KEY idx_refunds_user (user_id),
          KEY idx_refunds_shift (shift_id),
          CONSTRAINT fk_refunds_invoice FOREIGN KEY (invoice_id) REFERENCES orders (invoice_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE refund_items (
          id INT NOT NULL AUTO_INCREMENT,
          refund_id INT NOT NULL,
          order_item_id INT DEFAULT NULL,
          product_id INT DEFAULT NULL,
          item_name VARCHAR(255) DEFAULT NULL,
          note VARCHAR(255) DEFAULT NULL,
          quantity DECIMAL(12,6) NOT NULL,
          unit_price DECIMAL(10,6) NOT NULL,
          line_subtotal DECIMAL(10,2) NOT NULL,
          line_tax DECIMAL(10,2) NOT NULL,
          line_total DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_refund_items_refund (refund_id),
          KEY idx_refund_items_order_item (order_item_id),
          KEY idx_refund_items_product (product_id),
          CONSTRAINT fk_refund_items_refund FOREIGN KEY (refund_id) REFERENCES refunds (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE jofotara_documents (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          source_key VARCHAR(96) NOT NULL,
          order_invoice_id INT NOT NULL,
          refund_id INT NULL,
          original_document_id BIGINT UNSIGNED NULL,
          document_kind ENUM('invoice','credit_note') NOT NULL,
          tax_registration_type ENUM('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax',
          document_number VARCHAR(96) NOT NULL,
          document_uuid CHAR(36) NOT NULL,
          status ENUM('pending','submitting','accepted','rejected','unknown') NOT NULL DEFAULT 'pending',
          legal_snapshot_json LONGTEXT NULL,
          request_xml LONGTEXT NULL,
          qr_text LONGTEXT NULL,
          response_body LONGTEXT NULL,
          http_status SMALLINT UNSIGNED NULL,
          attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
          last_error TEXT NULL,
          submitted_by_user_id INT NULL,
          last_attempt_at DATETIME NULL,
          accepted_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_jofotara_source (source_key),
          UNIQUE KEY uq_jofotara_uuid (document_uuid),
          UNIQUE KEY uq_jofotara_number (document_number),
          KEY idx_jofotara_order (order_invoice_id, status),
          KEY idx_jofotara_status_attempt (status, last_attempt_at),
          CONSTRAINT fk_jofotara_order FOREIGN KEY (order_invoice_id) REFERENCES orders(invoice_id),
          CONSTRAINT fk_jofotara_refund FOREIGN KEY (refund_id) REFERENCES refunds(id),
          CONSTRAINT fk_jofotara_original FOREIGN KEY (original_document_id) REFERENCES jofotara_documents(id),
          CONSTRAINT fk_jofotara_user FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE product_bundle_items (
          id int(11) NOT NULL AUTO_INCREMENT,
          bundle_id int(11) NOT NULL,
          product_id int(11) NOT NULL,
          qty decimal(10,3) NOT NULL DEFAULT 1.000,
          sort_order int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          KEY idx_pbi_bundle (bundle_id),
          KEY idx_pbi_product (product_id),
          CONSTRAINT fk_pbi_bundle FOREIGN KEY (bundle_id) REFERENCES products (id) ON DELETE CASCADE,
          CONSTRAINT fk_pbi_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE bundle_modifications (
          id int(11) NOT NULL AUTO_INCREMENT,
          order_id int(11) NOT NULL,
          cashier_id int(11) NOT NULL,
          product_name varchar(255) DEFAULT NULL,
          action enum('removed','swapped','note_modified') NOT NULL,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_bundle_mods_order (order_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE held_orders (
          id int(11) NOT NULL AUTO_INCREMENT,
          user_id int(11) NOT NULL,
          call_center_user_id int(11) DEFAULT NULL,
          reference_name varchar(100) NOT NULL,
          cart_data longtext NOT NULL,
          subtotal decimal(10,2) DEFAULT 0.00,
          kitchen_fired tinyint(1) NOT NULL DEFAULT 0,
          service_charge_snapshot_id char(36) DEFAULT NULL,
          parent_invoice_id int(11) DEFAULT NULL,
          table_id int(11) DEFAULT NULL,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          version int(10) unsigned NOT NULL DEFAULT 1,
          hold_request_id varchar(64) DEFAULT NULL,
          claimed_by_user_id int(11) DEFAULT NULL,
          claim_token_hash char(64) DEFAULT NULL,
          claim_expires_at datetime DEFAULT NULL,
          updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          kitchen_snapshot longtext DEFAULT NULL,
          kitchen_dispatch_version int(10) unsigned NOT NULL DEFAULT 0,
          last_operation_id varchar(64) DEFAULT NULL,
          last_operation_kind varchar(32) DEFAULT NULL,
          last_operation_result longtext DEFAULT NULL,
          PRIMARY KEY (id),
          KEY idx_held_orders_user_id (user_id),
          KEY idx_held_orders_call_center_user (call_center_user_id),
          UNIQUE KEY uq_held_orders_user_request (user_id, hold_request_id),
          KEY idx_held_orders_claim_owner (claimed_by_user_id),
          KEY idx_held_orders_service_charge_snapshot (service_charge_snapshot_id),
          KEY idx_held_orders_parent_invoice (parent_invoice_id, id),
          KEY idx_held_orders_split_table (table_id, id),
          CONSTRAINT fk_held_service_charge_snapshot FOREIGN KEY (service_charge_snapshot_id) REFERENCES service_charge_snapshots (id),
          CONSTRAINT fk_held_orders_call_center_user FOREIGN KEY (call_center_user_id) REFERENCES users (id) ON DELETE RESTRICT,
          CONSTRAINT fk_held_orders_claim_user FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
          CONSTRAINT fk_held_orders_parent_invoice FOREIGN KEY (parent_invoice_id) REFERENCES orders (invoice_id) ON DELETE RESTRICT,
          CONSTRAINT fk_held_orders_split_table FOREIGN KEY (table_id) REFERENCES restaurant_tables (id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE master_held (
          id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
          business_start_at datetime NOT NULL,
          business_end_at datetime NOT NULL,
          report_payload longtext NOT NULL,
          held_orders_payload longtext NOT NULL,
          generated_by_user_id int(11) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          expires_at datetime NOT NULL,
          restored_at datetime DEFAULT NULL,
          PRIMARY KEY (id),
          KEY idx_master_held_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE invoice_sequences (
          sequence_name varchar(64) NOT NULL,
          current_value int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (sequence_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE daily_sequences (
          sequence_date date NOT NULL,
          current_value int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (sequence_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE spooler_stations (
          spooler_id varchar(96) NOT NULL,
          delivery_protocol enum('v1','transitioning','v2') NOT NULL DEFAULT 'v1',
          v2_activated_at datetime DEFAULT NULL,
          first_v2_accepted_at datetime DEFAULT NULL,
          updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (spooler_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE spooler_agents (
          agent_id char(36) NOT NULL,
          spooler_id varchar(96) NOT NULL,
          token_hash char(64) NOT NULL,
          name varchar(120) NOT NULL DEFAULT '',
          agent_version varchar(40) DEFAULT NULL,
          protocol_version int NOT NULL DEFAULT 2,
          status enum('active','draining','revoked','decommissioned') NOT NULL DEFAULT 'active',
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          revoked_at datetime DEFAULT NULL,
          last_sync_at datetime DEFAULT NULL,
          last_error varchar(255) DEFAULT NULL,
          local_queue_depth int DEFAULT NULL,
          health_summary varchar(255) DEFAULT NULL,
          active_station_key varchar(96) AS (case when status in ('active','draining') then spooler_id else NULL end) STORED,
          PRIMARY KEY (agent_id),
          UNIQUE KEY uq_spooler_agents_active_station (active_station_key),
          KEY idx_spooler_agents_station (spooler_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE printers (
          id int(11) NOT NULL AUTO_INCREMENT,
          name varchar(100) NOT NULL,
          role enum('receipt','kitchen') NOT NULL DEFAULT 'receipt',
          type enum('network','windows') NOT NULL DEFAULT 'windows',
          network_ip varchar(50) DEFAULT NULL,
          network_port varchar(10) DEFAULT '9100',
          windows_name varchar(100) DEFAULT NULL,
          is_active tinyint(1) DEFAULT 1,
          status_capability enum('write_only','escpos_status','snmp_status') NOT NULL DEFAULT 'write_only',
          device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown',
          status_checked_at datetime DEFAULT NULL,
          status_source varchar(32) DEFAULT NULL,
          last_printed_at datetime DEFAULT NULL,
          assigned_ips varchar(255) DEFAULT NULL,
          spooler_id varchar(96) NOT NULL DEFAULT 'primary',
          active_endpoint_key varchar(255) AS (case when is_active = 1 and type = 'network' then concat(role,':network:',lcase(trim(network_ip)),':',coalesce(nullif(trim(network_port),''),'9100')) when is_active = 1 and type = 'windows' then concat(role,':windows:',lcase(trim(spooler_id)),':',lcase(trim(windows_name))) else NULL end) STORED,
          PRIMARY KEY (id),
          UNIQUE KEY uq_printers_active_endpoint (active_endpoint_key),
          KEY idx_printers_spooler (spooler_id,is_active,id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE printer_categories (
          printer_id int(11) NOT NULL,
          category_id int(11) NOT NULL,
          PRIMARY KEY (printer_id,category_id),
          KEY idx_printer_categories_category (category_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE print_queue (
          id int(11) NOT NULL AUTO_INCREMENT,
          idempotency_key varchar(160) DEFAULT NULL,
          payload longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(payload)),
          payload_hash char(64) DEFAULT NULL,
          printer_id int(11) DEFAULT NULL,
          print_type varchar(64) DEFAULT NULL,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          status enum('pending','processing','sent','acknowledged','failed','dead_letter','canceled','local_accepted','cancel_requested') NOT NULL DEFAULT 'pending',
          claimed_by varchar(128) DEFAULT NULL,
          spooler_id varchar(128) DEFAULT NULL,
          spooler_version varchar(64) DEFAULT NULL,
          locked_until datetime DEFAULT NULL,
          attempts int(11) NOT NULL DEFAULT 0,
          max_attempts int(11) NOT NULL DEFAULT 5,
          first_attempt_at datetime DEFAULT NULL,
          last_error text DEFAULT NULL,
          device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown',
          sent_at datetime DEFAULT NULL,
          acknowledged_at datetime DEFAULT NULL,
          duration_ms int(11) DEFAULT NULL,
          next_retry_at datetime DEFAULT NULL,
          reprint_of_queue_id bigint(20) DEFAULT NULL,
          last_seen_at datetime DEFAULT NULL,
          agent_id char(36) DEFAULT NULL,
          accepted_at datetime DEFAULT NULL,
          last_error_code varchar(64) DEFAULT NULL,
          last_failure_class enum('transient_safe','permanent_safe','uncertain') DEFAULT NULL,
          artifact_hash char(64) DEFAULT NULL,
          artifact_bytes int unsigned DEFAULT NULL,
          render_duration_ms int unsigned DEFAULT NULL,
          local_duration_ms int unsigned DEFAULT NULL,
          renderer varchar(16) DEFAULT NULL,
          transport_mode varchar(24) DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_print_queue_idempotency (idempotency_key),
          KEY idx_print_queue_claim (status,locked_until,id),
          KEY idx_print_queue_state_locked (status,locked_until),
          KEY idx_print_queue_state_created (status,created_at),
          KEY idx_print_queue_reprint_of (reprint_of_queue_id),
          KEY idx_print_queue_owner_claim (printer_id,status,locked_until,id),
          KEY idx_print_queue_agent_claim (agent_id,status,locked_until,id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE print_templates (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE print_template_revisions (
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
          UNIQUE KEY uq_print_template_revision_no (template_id, revision_no),
          UNIQUE KEY uq_print_template_revision_hash (template_id, definition_hash),
          KEY idx_print_template_revisions_history (template_id, created_at, id),
          CONSTRAINT fk_print_template_revisions_template FOREIGN KEY (template_id) REFERENCES print_templates(id) ON DELETE RESTRICT,
          CONSTRAINT fk_print_template_revisions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT chk_print_template_revision_no CHECK (revision_no > 0),
          CONSTRAINT chk_print_template_revision_json CHECK (json_valid(definition_json))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE print_template_revision_tests (
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
          KEY idx_print_template_tests_revision_printer (revision_id, printer_id, confirmed_at, id),
          CONSTRAINT fk_print_template_tests_revision FOREIGN KEY (revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
          CONSTRAINT fk_print_template_tests_printer FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL,
          CONSTRAINT fk_print_template_tests_queue FOREIGN KEY (queue_id) REFERENCES print_queue(id) ON DELETE SET NULL,
          CONSTRAINT fk_print_template_tests_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE qr_table_drafts (
          table_id int(11) NOT NULL,
          cart_data longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(cart_data)),
          updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (table_id),
          CONSTRAINT qr_table_drafts_ibfk_1 FOREIGN KEY (table_id) REFERENCES restaurant_tables (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE subscription_plan_products (
          plan_id bigint unsigned NOT NULL,
          product_id int(11) NOT NULL,
          PRIMARY KEY (plan_id,product_id),
          KEY idx_subscription_plan_products_product (product_id,plan_id),
          CONSTRAINT fk_subscription_plan_products_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
          CONSTRAINT fk_subscription_plan_products_product FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE customer_subscription_products (
          subscription_id bigint unsigned NOT NULL,
          product_id int(11) NOT NULL,
          PRIMARY KEY (subscription_id,product_id),
          KEY idx_customer_subscription_products_product (product_id,subscription_id),
          CONSTRAINT fk_customer_subscription_products_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
          CONSTRAINT fk_customer_subscription_products_product FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE subscription_redemption_items (
          id bigint unsigned NOT NULL AUTO_INCREMENT,
          redemption_id bigint unsigned NOT NULL,
          product_id int(11) NOT NULL,
          item_name varchar(255) NOT NULL,
          quantity smallint unsigned NOT NULL,
          note text DEFAULT NULL,
          selected_modifiers longtext DEFAULT NULL,
          bundle_items longtext DEFAULT NULL,
          recipe_line_key char(32) DEFAULT NULL,
          sort_order int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          KEY idx_subscription_redemption_items_redemption (redemption_id,sort_order,id),
          KEY idx_subscription_redemption_items_product (product_id,redemption_id),
          KEY idx_sri_recipe_line_key (recipe_line_key),
          CONSTRAINT fk_subscription_redemption_items_redemption FOREIGN KEY (redemption_id) REFERENCES subscription_redemptions(id) ON DELETE CASCADE,
          CONSTRAINT fk_subscription_redemption_items_product FOREIGN KEY (product_id) REFERENCES products(id),
          CONSTRAINT chk_subscription_redemption_items_quantity CHECK (quantity > 0),
          CONSTRAINT chk_subscription_redemption_items_modifiers_json CHECK (selected_modifiers IS NULL OR json_valid(selected_modifiers)),
          CONSTRAINT chk_subscription_redemption_items_bundle_json CHECK (bundle_items IS NULL OR json_valid(bundle_items))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await conn.query(`
        CREATE TABLE audit_events (
          id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
          event_type varchar(64) NOT NULL,
          user_id int(10) unsigned DEFAULT NULL,
          manager_id int(10) unsigned DEFAULT NULL,
          entity_type varchar(32) DEFAULT NULL,
          entity_id bigint(20) DEFAULT NULL,
          old_value text DEFAULT NULL,
          new_value text DEFAULT NULL,
          ip_address varchar(64) DEFAULT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_audit_event_type (event_type),
          KEY idx_audit_user_id (user_id),
          KEY idx_audit_created_at (created_at),
          KEY idx_audit_entity (entity_type,entity_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.query(`
        ALTER TABLE print_templates
          ADD CONSTRAINT fk_print_templates_active_revision
            FOREIGN KEY (active_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
          ADD CONSTRAINT fk_print_templates_draft_revision
            FOREIGN KEY (draft_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT
    `);
}

async function seedData(conn) {
    const adminPinHash = bcrypt.hashSync(SEED.adminUser.pin, 12);

    // Settings
    await conn.query(`
        INSERT INTO settings (setting_key, setting_value) VALUES
        ('tax_inclusive_pricing', '0'),
        ('tables_enabled', '1'),
        ('table_mode', 'fixed'),
        ('admin_language', 'en'),
        ('stock_enabled', '0'),
        ('recipe_ledger_enabled', '0'),
        ('use_invoice_no_only', '0'),
        ('service_charge_enabled', '0'),
        ('service_charge_percentage', '10'),
        ('service_charge_tax_rate', '0'),
        ('service_charge_jofotara_tax_category', 'O'),
        ('auto_apply_service_charge', '0'),
        ('default_order_type_id', ''),
        ('y_order_type_id', ''),
        ('jofotara_enabled', '0'),
        ('tax_registration_type', 'sales_tax'),
        ('jofotara_auto_submit', '0'),
        ('jofotara_auto_submit_since', ''),
        ('jofotara_sales_tax_client_id', ''),
        ('jofotara_sales_tax_secret_key', ''),
        ('jofotara_sales_tax_income_source_sequence', ''),
        ('jofotara_sales_tax_seller_tax_number', ''),
        ('jofotara_sales_tax_seller_registered_name', ''),
        ('jofotara_income_tax_client_id', ''),
        ('jofotara_income_tax_secret_key', ''),
        ('jofotara_income_tax_income_source_sequence', ''),
        ('jofotara_income_tax_seller_tax_number', ''),
        ('jofotara_income_tax_seller_registered_name', ''),
        ('subscription_receivables_enabled', '0'),
        ('low_stock_threshold', '3'),
        ('staff_device_auth_mode', 'disabled'),
        ('webauthn_bootstrap_consumed', '0')
    `);

    await conn.query(`
        INSERT INTO invoice_sequences (sequence_name, current_value)
        VALUES ('global_invoice', 0)
    `);

    await conn.query(`
        INSERT INTO schema_migrations (migration_name, checksum)
        VALUES
        ('2026-07-23-admin-manual-subscriptions-v1', 'bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf'),
        ('2026-07-24-progressive-split-checks-v1', '14178039d66459e3b898cd2038e5570df68edd714e31fb4fb9935ce7b765c3c4'),
        ('2026-07-24-jofotara-operations-v1', '3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e'),
        ('2026-07-25-print-templates-v1', 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07'),
        ('2026-07-29-subscription-receivables-v1', 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da'),
        ('2026-07-31-platform-held-order-settlement-v1', 'cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85'),
        ('2026-07-31-tax-exempt-checks-v1', '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3'),
        ('2026-08-01-additive-schema-reconciliation-v1', '5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679'),
        ('2026-08-03-platform-provider-reconciliation-v1', '21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999'),
        ('2026-08-04-jofotara-tax-categories-v1', 'dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41'),
        ('2026-08-04-special-source-buyer-snapshots-v1', '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244'),
        ('2026-08-05-service-charge-jofotara-tax-category-v1', '9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678'),
        ('2026-08-08-settings-value-capacity-v1', 'ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff'),
        ('2026-08-09-imported-schema-drift-repair-v1', '0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73'),
        ('2026-08-09-baseline-foreign-key-authority-v1', '8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937'),
        ('2026-08-10-order-reference-authority-v1', 'da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35'),
        ('2026-08-10-legacy-permission-column-retirement-v1', 'd3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550'),
        ('2026-08-10-refund-status-reconciliation-v1', '00b8fedabceb21101e6bb2739f89c54a6f7ee8fef6aa7b155a4e037b093f7ee6'),
        ('2026-08-10-order-reference-index-authority-v1', '8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d'),
        ('2026-08-10-held-order-lifecycle-v1', 'af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160'),
        ('2026-08-10-call-center-held-orders-v1', 'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b'),
        ('2026-08-11-receipt-tax-display-v1', '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3'),
        ('2026-08-13-split-quantity-precision-v1', 'eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76'),
        ('2026-08-13-webauthn-registered-device-access-v1', '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09'),
        ('2026-08-17-spooler-v2-agents-v1', 'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985'),
        ('2026-08-23-audit-browser-preview-v1', 'e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af'),
        ('2026-08-30-jofotara-stale-submission-index-v1', '5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed'),
        ('2026-08-31-pos-order-history-default-v1', '862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b'),
        ('2026-09-01-product-price-override-lock-v1', 'e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8'),
        ('2026-09-01-fractional-stock-precision-v1', 'b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e'),
        ('2026-09-02-expense-zero-amount-v1', '264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75'),
        ('2026-09-03-y-order-type-setting-v1', '4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3'),
        ('2026-09-05-recipe-ledger-v1', '9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb'),
        ('2026-09-06-recipe-ledger-performance-v1', 'f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c')
    `);

    await conn.query(`INSERT INTO print_templates (document_type) VALUES ('receipt'), ('kitchen')`);


    // Users — use fixed IDs via INSERT with explicit id
    await conn.query(`
        INSERT INTO users (id, user_number, name, role, admin_pin, is_active,
            allowed_sections, table_access_scope, xyz)
        VALUES
        (1, '9001', 'Test Admin', 'admin', ?, 1, NULL, 'all', 0),
        (2, '9002', 'Test Cashier', 'cashier', NULL, 1, NULL, 'all', 0),
        (3, '9003', 'Test Waiter', 'waiter', NULL, 1, '1', 'selected', 0),
        (4, '9004', 'Inactive User', 'cashier', NULL, 0, NULL, 'all', 0),
        (5, '9005', 'Price Override Cashier', 'cashier', NULL, 1, NULL, 'all', 0),
        (6, '9006', 'Price Override Waiter', 'waiter', NULL, 1, '1', 'selected', 0)
    `, [adminPinHash]);

    // User permissions seed
    await conn.query(`
        INSERT INTO user_permissions (user_id, perm_key) VALUES
        (2, 'pos.checkout'),
        (2, 'pos.hold_orders'),
        (2, 'orders.view'),
        (2, 'shift.open'),
        (2, 'shift.close'),
        (3, 'pos.hold_orders'),
        (3, 'pos.split_checks'),
        (3, 'tables.access'),
        (3, 'waiter.edit_locked'),
        (3, 'pos.refund'),
        (5, 'pos.checkout'),
        (5, 'shift.open'),
        (5, 'shift.close'),
        (5, 'pos.price_override'),
        (6, 'tables.access'),
        (6, 'waiter.edit_locked'),
        (6, 'pos.price_override')
    `);

    // Category + Products
    await conn.query(`
        INSERT INTO categories (id, name, is_active)
        VALUES (1, 'Test Category', 1)
    `);
    await conn.query(`
        INSERT INTO products (id, name, price, tax_rate, jofotara_tax_category, category_id, is_active, is_bundle)
        VALUES
        (1, 'Test Burger', 5.0000, 16, 'S', 1, 1, 0),
        (2, 'Test Drink', 2.0000, 0, 'O', 1, 1, 0),
        (3, 'No Stock Item', 3.0000, 0, 'O', 1, 1, 0),
        (4, 'Family Package', 10.0000, 16, 'S', 1, 1, 1)
    `);

    // Modifier-bearing product for held-order modifier tamper coverage (5d): base 5.00 + "Large" +2.00.
    await conn.query(`
        INSERT INTO products (id, name, price, tax_rate, jofotara_tax_category, category_id, is_active, is_bundle, modifiers)
        VALUES (10, 'Modifier Product', 5.0000, 16, 'S', 1, 1, 0, '[{"name":"Size","options":[{"name":"Large","price":2.00}]}]')
    `);

    await conn.query(`
        INSERT INTO product_bundle_items (id, bundle_id, product_id, qty, sort_order)
        VALUES
        (1, 4, 1, 1.000, 0),
        (2, 4, 2, 1.000, 1)
    `);

    // Order types
    await conn.query(`
        INSERT INTO order_types (id, name, requires_hash, is_active)
        VALUES (1, 'Dine In', 0, 1), (2, 'Hash Required Type', 1, 1)
    `);

    // Sections + Tables
    await conn.query(`INSERT INTO sections (id, name) VALUES (1, 'Test Section')`);
    await conn.query(`
        INSERT INTO restaurant_tables (id, section_id, table_number, status, qr_code_token)
        VALUES
        (1, 1, 1, 'available', 'test_qr_token_abc123'),
        (2, 1, 2, 'available', 'test_qr_token_def456')
    `);
}

// ─── Main export: use in beforeAll of integration test suites ─────────────────
async function seedDatabase({ legacyStockSchema = false, legacyIngredientState = false, legacyMovementSchema = false } = {}) {
    const { database, ...connectionOptions } = getTestDatabaseOptions();
    const pool = await mysql.createConnection({
        ...connectionOptions,
        multipleStatements: false,
    });

    try {
        await createTestDatabase(pool, database);
        await createSchema(pool);
        await seedData(pool);
        for (const migration of ['2026-09-07-ingredient-analysis-v1', '2026-09-08-stock-adjustments-v1', '2026-09-08-stock-ledger-core-v1', '2026-09-08-stock-sale-snapshots-v1', '2026-09-08-stock-read-index-v1', '2026-09-08-stock-report-generations-v1', '2026-09-08-stock-report-facts-v1', '2026-09-08-stock-availability-policy-v1', '2026-09-08-stock-ingredient-cutover-v1', '2026-09-08-stock-item-projections-v1', '2026-09-08-stock-report-ingredient-rebuild-v1', '2026-09-08-stock-resolved-product-links-v1', '2026-09-08-stock-report-backfill-v1', '2026-09-08-stock-report-count-intervals-v1', '2026-09-08-ingredient-working-balances-v1', '2026-09-08-stock-report-daily-projection-v1', '2026-09-08-stock-procurement-v1', '2026-09-08-procurement-request-integrity-v1', '2026-09-09-held-order-numbers-v1', '2026-09-12-order-type-numbering-v1', ...(legacyStockSchema ? [] : ['2026-09-12-stock-item-identity-v1', ...(legacyIngredientState ? [] : ['2026-09-12-ingredient-state-v1', ...(legacyMovementSchema ? [] : ['2026-09-12-unified-stock-movements-v1', '2026-09-12-held-report-date-index-v1', '2026-09-13-table-action-recovery-v1', '2026-09-13-paid-split-parent-index-v1', '2026-09-13-table-seating-v1', '2026-09-14-deleted-table-items-v1', '2026-09-14-permission-catalog-v1', '2026-09-14-table-access-scope-v1', '2026-09-14-permission-catalog-v2', '2026-09-17-print-queue-timings-v1', '2026-09-19-customer-phone-index-v1', '2026-09-20-order-intake-requests-v1', '2026-09-22-product-customer-info-v1', '2026-09-23-subscriptions-retirement-v1', '2026-09-26-expense-request-id-v1', '2026-09-30-printer-last-printed-v1', '2026-09-30-multi-terminal-permission-v1', '2026-09-30-purchase-invoices-v1', '2026-10-01-retire-purchasing-tables-v1', '2026-10-01-stock-documents-v1', '2026-10-02-purchase-item-kind-v1', '2026-10-03-product-barcodes-v1'])])])]) {
            const migrationSql = require('fs').readFileSync(require('path').join(__dirname, `../../migrations/${migration}.auto.sql`), 'utf8');
            for (const statement of require('../../migrations/runPendingMigrations').splitMysqlScript(migrationSql)) await pool.query(statement);
        }
    } finally {
        await pool.end();
    }
}

module.exports = { seedDatabase, SEED, hashToken };
