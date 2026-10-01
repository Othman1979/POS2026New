-- Increase price precision to DECIMAL(10,6) so pre-tax stored prices
-- (gross / (1 + rate/100)) retain enough decimal places for exact
-- tax reconstruction at checkout (required for Jordan tax authority integration).
-- price_history columns matched for consistency.

ALTER TABLE products MODIFY COLUMN price DECIMAL(10,6) NOT NULL;
ALTER TABLE price_history MODIFY COLUMN old_price DECIMAL(10,6) NOT NULL;
ALTER TABLE price_history MODIFY COLUMN new_price DECIMAL(10,6) NOT NULL;

-- Backfill: existing rows were first divided with only DECIMAL(10,2) precision
-- (e.g. 6.00/1.08 stored as 5.56 instead of 5.555556).
-- Reconstruct the original gross price via ROUND(...,2) then re-divide at full precision.
UPDATE products
SET price = ROUND(price * (1 + tax_rate / 100), 2) / (1 + tax_rate / 100)
WHERE tax_rate > 0;
