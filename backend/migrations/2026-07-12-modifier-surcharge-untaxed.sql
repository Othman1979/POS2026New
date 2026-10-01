ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS modifier_surcharge decimal(10,6) DEFAULT NULL;
