ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tax_inclusive_at_sale TINYINT(1) NULL AFTER tax;
