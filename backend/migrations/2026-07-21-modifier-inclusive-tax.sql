ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS modifier_tax_amount DECIMAL(10,6) DEFAULT NULL
  AFTER modifier_surcharge;
