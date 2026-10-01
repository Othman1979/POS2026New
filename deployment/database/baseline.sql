-- Canonical fresh POS schema. Generated from the verified schema fixture; no business rows.
SET FOREIGN_KEY_CHECKS = 0;
CREATE TABLE settings (
          setting_key varchar(50) NOT NULL,
          setting_value text NOT NULL,
          PRIMARY KEY (setting_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE schema_migrations (
          migration_name varchar(190) NOT NULL,
          checksum char(64) NOT NULL,
          applied_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (migration_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE user_permissions (
          user_id  INT         NOT NULL,
          perm_key VARCHAR(64) NOT NULL,
          PRIMARY KEY (user_id, perm_key),
          KEY idx_user_permissions_perm (perm_key),
          CONSTRAINT fk_uperm_user FOREIGN KEY (user_id)  REFERENCES users(id)            ON DELETE CASCADE,
          CONSTRAINT fk_uperm_perm FOREIGN KEY (perm_key) REFERENCES permissions(perm_key) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE product_price_overrides (
          price_list_root_id int(11) NOT NULL,
          product_id int(11) NOT NULL,
          price decimal(10,6) NOT NULL,
          updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (price_list_root_id, product_id),
          CONSTRAINT fk_product_price_overrides_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE CASCADE,
          CONSTRAINT fk_product_price_overrides_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
          CONSTRAINT chk_product_price_overrides_nonnegative CHECK (price >= 0)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE order_types (
          id int(11) NOT NULL AUTO_INCREMENT,
          name varchar(100) NOT NULL,
          is_active tinyint(1) DEFAULT 1,
          requires_hash tinyint(1) DEFAULT 0,
          is_deferred_settlement tinyint(1) NOT NULL DEFAULT 0,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE sections (
          id int(11) NOT NULL AUTO_INCREMENT,
          name varchar(100) NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
          created_at datetime NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_order_items_invoice (invoice_id),
          KEY idx_order_items_product (product_id),
          UNIQUE KEY uq_order_items_id_invoice (id, invoice_id),
          KEY idx_order_items_parent_invoice (parent_item_id, invoice_id),
          CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0),
          CONSTRAINT chk_order_items_jofotara_tax_category CHECK (jofotara_tax_category IN ('S','Z','O')),
          CONSTRAINT order_items_ibfk_1 FOREIGN KEY (invoice_id) REFERENCES orders (invoice_id) ON DELETE CASCADE,
          CONSTRAINT order_items_ibfk_2 FOREIGN KEY (product_id) REFERENCES products (id),
          CONSTRAINT fk_order_items_parent_invoice
            FOREIGN KEY (parent_item_id, invoice_id)
            REFERENCES order_items (id, invoice_id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE refunds (
          id INT NOT NULL AUTO_INCREMENT,
          kind ENUM('void','refund') NOT NULL,
          invoice_id INT DEFAULT NULL,
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE deleted (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE bundle_modifications (
          id int(11) NOT NULL AUTO_INCREMENT,
          order_id int(11) NOT NULL,
          cashier_id int(11) NOT NULL,
          product_name varchar(255) DEFAULT NULL,
          action enum('removed','swapped','note_modified') NOT NULL,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_bundle_mods_order (order_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE held_orders (
          id int(11) NOT NULL AUTO_INCREMENT,
          order_id int(11) DEFAULT NULL,
          order_seq_scope varchar(40) DEFAULT NULL,
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
          UNIQUE KEY uq_held_order_sequence (order_seq_scope, order_id),
          KEY idx_held_orders_user_id (user_id),
          KEY idx_held_orders_call_center_user (call_center_user_id),
          UNIQUE KEY uq_held_orders_user_request (user_id, hold_request_id),
          KEY idx_held_orders_claim_owner (claimed_by_user_id),
          KEY idx_held_orders_service_charge_snapshot (service_charge_snapshot_id),
          KEY idx_held_orders_parent_invoice (parent_invoice_id, id),
          KEY idx_held_orders_split_table (table_id, id),
          KEY idx_held_orders_created_id (created_at, id),
          CONSTRAINT fk_held_service_charge_snapshot FOREIGN KEY (service_charge_snapshot_id) REFERENCES service_charge_snapshots (id),
          CONSTRAINT fk_held_orders_call_center_user FOREIGN KEY (call_center_user_id) REFERENCES users (id) ON DELETE RESTRICT,
          CONSTRAINT fk_held_orders_claim_user FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
          CONSTRAINT fk_held_orders_parent_invoice FOREIGN KEY (parent_invoice_id) REFERENCES orders (invoice_id) ON DELETE RESTRICT,
          CONSTRAINT fk_held_orders_split_table FOREIGN KEY (table_id) REFERENCES restaurant_tables (id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE invoice_sequences (
          sequence_name varchar(64) NOT NULL,
          current_value int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (sequence_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE daily_sequences (
          sequence_date date NOT NULL,
          current_value int(11) NOT NULL DEFAULT 0,
          PRIMARY KEY (sequence_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE spooler_stations (
          spooler_id varchar(96) NOT NULL,
          delivery_protocol enum('v1','transitioning','v2') NOT NULL DEFAULT 'v1',
          v2_activated_at datetime DEFAULT NULL,
          first_v2_accepted_at datetime DEFAULT NULL,
          updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (spooler_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE printer_categories (
          printer_id int(11) NOT NULL,
          category_id int(11) NOT NULL,
          PRIMARY KEY (printer_id,category_id),
          KEY idx_printer_categories_category (category_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE qr_table_drafts (
          table_id int(11) NOT NULL,
          cart_data longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(cart_data)),
          updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (table_id),
          CONSTRAINT qr_table_drafts_ibfk_1 FOREIGN KEY (table_id) REFERENCES restaurant_tables (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SET FOREIGN_KEY_CHECKS = 1;
ALTER TABLE print_templates ADD CONSTRAINT fk_print_templates_active_revision FOREIGN KEY (active_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT, ADD CONSTRAINT fk_print_templates_draft_revision FOREIGN KEY (draft_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

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
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_item_product (legacy_product_id),
 UNIQUE KEY uq_stock_item_ingredient (legacy_ingredient_id),
 KEY idx_stock_item_name (name,id),
 CONSTRAINT ck_stock_item_source CHECK (legacy_product_id IS NULL OR legacy_ingredient_id IS NULL),
 CONSTRAINT ck_stock_item_measure CHECK ((measure='weight' AND base_unit='g') OR (measure='volume' AND base_unit='ml') OR (measure='count' AND base_unit='unit')),
 CONSTRAINT ck_stock_item_state CHECK (tracking_state IN ('draft','active')),
 CONSTRAINT ck_stock_item_flags CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_balances (
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NULL DEFAULT NULL,
 lot_id BIGINT UNSIGNED NULL DEFAULT NULL,
 quantity DECIMAL(16,6) NOT NULL DEFAULT 0,
 quantity_known TINYINT NOT NULL DEFAULT 0,
 version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 last_operation_id BIGINT UNSIGNED DEFAULT NULL,
 PRIMARY KEY (stock_item_id),
 CONSTRAINT fk_stock_balance_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_balance_known CHECK (quantity_known IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE stock_operations
 ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'posted',
 ADD COLUMN IF NOT EXISTS business_date DATE DEFAULT NULL,
 ADD COLUMN IF NOT EXISTS original_operation_id BIGINT UNSIGNED DEFAULT NULL;
CREATE TABLE IF NOT EXISTS stock_movements (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 movement_type ENUM('stock','ingredient') NOT NULL DEFAULT 'stock',
 PRIMARY KEY(movement_type,id),
 KEY idx_stock_movement_id(id),
 operation_id BIGINT UNSIGNED NULL,
 line_ordinal SMALLINT UNSIGNED NULL,
 stock_item_id BIGINT UNSIGNED NULL,
 location_id BIGINT UNSIGNED NULL DEFAULT NULL,
 lot_id BIGINT UNSIGNED NULL DEFAULT NULL,
 quantity DECIMAL(16,6) NULL,
 establishes_known TINYINT NOT NULL DEFAULT 0,
 unit_snapshot VARCHAR(8) NULL,
 source_line VARCHAR(100) DEFAULT NULL,
 business_date DATE NOT NULL,
 UNIQUE KEY uq_stock_movement_operation (operation_id,line_ordinal),
 KEY idx_stock_movement_history (stock_item_id,id),
 KEY idx_stock_movement_day (business_date,id),
 CONSTRAINT fk_stock_movement_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT fk_stock_movement_balance FOREIGN KEY (stock_item_id) REFERENCES stock_balances(stock_item_id),
 ingredient_id INT NULL,
 kind ENUM('usage','reversal','receipt','waste','count','correction') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 qty DECIMAL(16,6) NULL,
 unit_cost DECIMAL(16,8) NULL,
 reason ENUM('spoiled','expired','dropped_or_burnt','over_prepared','staff_meal','other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 expected_qty DECIMAL(16,6) NULL,
 period_usage_qty DECIMAL(16,6) NULL,
 line_key CHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 unit_qty DECIMAL(16,6) NULL,
 product_qty DECIMAL(16,6) NULL,
 source_type ENUM('order','redemption','refund','void','manual') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 source_id INT NULL,
 source_label VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 product_id INT NULL,
 product_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 user_id INT NULL,
 user_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 occurred_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
 note VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 client_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 corrects_movement_id BIGINT UNSIGNED NULL,
 purchase_priced TINYINT(1) NOT NULL DEFAULT 0,
 cost_source VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'legacy',
 UNIQUE KEY uq_im_client_key (client_key),
 UNIQUE KEY uq_im_corrects (corrects_movement_id),
 KEY idx_im_ingredient_kind_id (ingredient_id,kind,id),
 KEY idx_im_line_key (line_key),
 KEY idx_im_source (source_type,source_id),
 KEY idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date),
 KEY idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost),
 KEY idx_im_purchase_cost (ingredient_id,kind,business_date,purchase_priced),
 CONSTRAINT ck_stock_movement_identity CHECK ((movement_type='stock' AND ingredient_id IS NULL AND kind IS NULL AND qty IS NULL AND operation_id IS NOT NULL AND occurred_at IS NULL) OR (movement_type='ingredient' AND ingredient_id IS NOT NULL AND kind IS NOT NULL AND qty IS NOT NULL AND source_type IS NOT NULL AND occurred_at IS NOT NULL)),
 CONSTRAINT ck_stock_movement_physical CHECK ((operation_id IS NULL AND stock_item_id IS NULL AND line_ordinal IS NULL AND quantity IS NULL AND unit_snapshot IS NULL AND establishes_known=0) OR (operation_id IS NOT NULL AND stock_item_id IS NOT NULL AND line_ordinal IS NOT NULL AND quantity IS NOT NULL AND unit_snapshot IS NOT NULL AND establishes_known IN (0,1))),
 CONSTRAINT chk_im_signs CHECK (kind IS NULL OR (kind IN ('usage','waste') AND qty<=0) OR (kind IN ('reversal','receipt','count') AND qty>=0) OR kind='correction'),
 CONSTRAINT chk_im_reason CHECK (kind='waste' OR reason IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS product_stock_links (
 product_id INT NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 PRIMARY KEY (product_id,stock_item_id),
 KEY idx_product_stock_physical (stock_item_id,product_id),
 qty_per_sale DECIMAL(16,6) NOT NULL,
 policy_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 CONSTRAINT fk_product_stock_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_product_stock_qty CHECK (qty_per_sale > 0),
 CONSTRAINT fk_product_stock_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2026-09-08-stock-sale-snapshots-v1
-- Requires migration: 2026-09-08-stock-ledger-core-v1
-- Requires checksum: 39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4
-- NULL snapshots identify historical lines whose original mapping is unknown.
-- Never backfill them from today's catalog configuration.
ALTER TABLE order_items
 ADD COLUMN IF NOT EXISTS stock_authority varchar(24) NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS stock_snapshot JSON DEFAULT NULL;

-- 2026-09-08-stock-read-index-v1
ALTER TABLE stock_items
 ADD INDEX IF NOT EXISTS idx_stock_item_active_name (tracking_state,is_active,name,id);

-- 2026-09-08-stock-report-generations-v1
-- Requires migration: 2026-09-08-stock-read-index-v1
-- Requires checksum: 318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081
-- Publication metadata only. No source rows are inferred or activated.
CREATE TABLE stock_report_builds (
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
CREATE TABLE stock_report_dirty (
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
CREATE TABLE stock_report_worker (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
 lease_until DATETIME(6) DEFAULT NULL,
 CONSTRAINT chk_stock_report_worker_singleton CHECK (id=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2026-09-08-stock-report-facts-v1
-- Requires migration: 2026-09-08-stock-report-generations-v1
-- Requires checksum: 724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510
-- Derived staging only. Published generation pointers control visibility.
CREATE TABLE stock_report_meals (
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
CREATE TABLE stock_report_ingredients (
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
CREATE TABLE stock_report_events (
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
CREATE TABLE stock_report_operations (
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

-- 2026-09-08-stock-availability-policy-v1
-- Requires migration: 2026-09-08-stock-report-facts-v1
-- Requires checksum: c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb
-- Strict remains the default for existing packaged-stock identities.
-- Estimate records recipe usage without inventing a counted opening balance.
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS availability_policy VARCHAR(12) NOT NULL DEFAULT 'strict';
ALTER TABLE stock_items ADD CONSTRAINT IF NOT EXISTS ck_stock_item_availability
 CHECK (availability_policy IN ('strict','estimate'));

-- 2026-09-08-stock-ingredient-cutover-v1
-- Requires migration: 2026-09-08-stock-availability-policy-v1
-- Requires checksum: 161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88
-- Durable ingredient authority cutover and source identity provenance.
-- Provenance is keyed by operation line and source identity, not reconstructed movement IDs.
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

-- Retired purchasing tables are omitted from fresh installations.

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
,
 stock_item_id BIGINT UNSIGNED NULL,
 stock_activation_operation_id BIGINT UNSIGNED NULL,
 stock_movement_watermark BIGINT UNSIGNED NULL,
 stock_activation_count_id BIGINT UNSIGNED NULL,
 stock_observation_token CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
 stock_activation_quantity DECIMAL(16,6) NULL,
 stock_activation_quantity_known TINYINT NULL,
 stock_activation_request_key VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
 stock_activated_at DATETIME(6) NULL,
 working_quantity DECIMAL(28,6) NOT NULL DEFAULT 0,
 working_quantity_known TINYINT(1) NOT NULL DEFAULT 0,
 working_last_count_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 working_period_usage DECIMAL(28,6) NOT NULL DEFAULT 0,
 working_variance_qty DECIMAL(28,6) NULL,
 working_initialized TINYINT(1) NOT NULL DEFAULT 0,
 UNIQUE KEY uq_stock_ingredient_item (stock_item_id),
 UNIQUE KEY uq_stock_ingredient_request (stock_activation_request_key),
 KEY idx_stock_ingredient_operation (stock_activation_operation_id),
 KEY idx_ingredient_working_init (working_initialized,id),
 CONSTRAINT fk_ingredient_stock_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_ingredient_stock_operation FOREIGN KEY (stock_activation_operation_id) REFERENCES stock_operations(id),
 CONSTRAINT ck_ingredient_stock_link CHECK (
 (stock_item_id IS NULL AND stock_activation_operation_id IS NULL AND stock_movement_watermark IS NULL
  AND stock_activation_count_id IS NULL AND stock_observation_token IS NULL AND stock_activation_quantity IS NULL
  AND stock_activation_quantity_known IS NULL AND stock_activation_request_key IS NULL AND stock_activated_at IS NULL)
 OR (stock_item_id IS NOT NULL AND stock_activation_operation_id IS NOT NULL AND stock_movement_watermark IS NOT NULL
  AND stock_observation_token IS NOT NULL AND stock_activation_request_key IS NOT NULL AND stock_activated_at IS NOT NULL
  AND stock_activation_quantity_known IS NOT NULL AND stock_activation_quantity_known IN (0,1)
  AND ((stock_activation_quantity_known=0 AND stock_activation_quantity IS NULL) OR (stock_activation_quantity_known=1 AND stock_activation_quantity IS NOT NULL)))),
 CONSTRAINT ck_ingredient_working_state CHECK (working_quantity_known IN (0,1) AND working_initialized IN (0,1))
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

ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movement_ingredient FOREIGN KEY(ingredient_id) REFERENCES ingredients(id);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

ALTER TABLE order_items
  ADD KEY IF NOT EXISTS idx_order_items_recipe_line_key (recipe_line_key),
  ALGORITHM=INPLACE, LOCK=NONE;



CREATE TABLE IF NOT EXISTS recipe_ledger_lines (
  line_key char(32) NOT NULL PRIMARY KEY,
  ingredient_ids JSON NOT NULL,
  CONSTRAINT chk_rll_array CHECK (JSON_TYPE(ingredient_ids)='ARRAY')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;



ALTER TABLE order_items ADD COLUMN IF NOT EXISTS recipe_cost_snapshot JSON DEFAULT NULL;

ALTER TABLE product_recipe_lines ADD COLUMN IF NOT EXISTS yield_pct decimal(10,4) NOT NULL DEFAULT 100;


CREATE TABLE IF NOT EXISTS stock_report_backfill (
 source VARCHAR(24) NOT NULL PRIMARY KEY,
 last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 complete TINYINT(1) NOT NULL DEFAULT 0,
 CONSTRAINT ck_stock_report_backfill_source CHECK (source IN ('orders','refunds','ingredient_movements','stock_operations'))
) ENGINE=InnoDB;

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

CREATE TABLE daily_order_type_sequences (
  sequence_date DATE NOT NULL,
  order_type_id INT NOT NULL,
  prefix_ordinal INT UNSIGNED NOT NULL,
  current_value INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (sequence_date, order_type_id),
  UNIQUE KEY uq_daily_type_prefix (sequence_date, prefix_ordinal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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

CREATE TABLE IF NOT EXISTS stock_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_type ENUM('purchase','count') NOT NULL,
  item_kind ENUM('product','ingredient') NULL,
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
  UNIQUE KEY uq_stock_document_supplier_reference (supplier_id, reference, item_kind),
  UNIQUE KEY uq_stock_document_create_key (create_key),
  UNIQUE KEY uq_stock_document_post_key (post_key),
  UNIQUE KEY uq_stock_document_reverse_key (reverse_key),
  UNIQUE KEY uq_stock_document_open_count (open_count),
  KEY idx_stock_document_type_status_date (doc_type, status, doc_date, id),
  KEY idx_stock_document_kind_list (doc_type, item_kind, status, id),
  CONSTRAINT fk_stock_document_supplier FOREIGN KEY (supplier_id) REFERENCES purchase_suppliers (id),
  CONSTRAINT ck_stock_document_shape CHECK (
    (doc_type = 'purchase' AND item_kind IS NOT NULL AND supplier_id IS NOT NULL AND reference IS NOT NULL AND payment_status IS NOT NULL
      AND subtotal >= 0 AND tax_total >= 0 AND total >= 0)
    OR (doc_type = 'count' AND item_kind IS NULL AND supplier_id IS NULL AND payment_status IS NULL AND status IN ('draft','posted')))
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
