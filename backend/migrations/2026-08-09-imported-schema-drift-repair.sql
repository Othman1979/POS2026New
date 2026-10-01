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
