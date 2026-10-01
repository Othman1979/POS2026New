-- Products with tax_rate > 0 had tax-inclusive prices stored in the price column.
-- The POS was adding tax on top, causing double-taxation.
-- This migration divides existing prices by (1 + tax_rate/100) to store pre-tax prices.
-- Going forward, admin enters gross (tax-inclusive) price; backend strips tax before storing.

UPDATE products
SET price = price / (1 + tax_rate / 100)
WHERE tax_rate > 0;
