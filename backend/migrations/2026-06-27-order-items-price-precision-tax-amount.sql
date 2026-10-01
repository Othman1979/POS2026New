-- Widen price_at_sale to DECIMAL(10,6) to match products.price precision.
-- Add tax_amount column for per-item tax recording (required for JoFotara).
--
-- Backfill: existing rows have tax-inclusive prices (stored before today's
-- pricing change), so tax is extracted via gross × rate/(100+rate).

ALTER TABLE order_items MODIFY COLUMN price_at_sale DECIMAL(10,6) NOT NULL;

ALTER TABLE order_items
    ADD COLUMN tax_amount DECIMAL(10,6) NOT NULL DEFAULT 0 AFTER tax_rate;

-- Backfill tax_amount for existing rows (tax-inclusive price formula)
UPDATE order_items SET tax_amount =
    CASE
        WHEN tax_rate = 0 THEN 0
        WHEN discount_type = 'fixed' THEN
            GREATEST(0, (price_at_sale - COALESCE(discount_value, 0)) * quantity) * tax_rate / (100 + tax_rate)
        WHEN discount_type = 'percent' THEN
            price_at_sale * quantity * (1 - COALESCE(discount_value, 0) / 100) * tax_rate / (100 + tax_rate)
        ELSE
            price_at_sale * quantity * tax_rate / (100 + tax_rate)
    END;
