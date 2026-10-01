-- Hostinger-safe automatic form of 2026-08-04-special-source-buyer-snapshots-v1.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms,
  ADD CONSTRAINT chk_orders_receivable_terms CHECK (
    (payment_method='receivable'
      AND payment_due_on IS NOT NULL
      AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
      AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0
      AND COALESCE(cash_amount,0)=0 AND COALESCE(card_amount,0)=0
      AND COALESCE(amount_tendered,0)=0 AND COALESCE(change_due,0)=0)
    OR
    (payment_method<>'receivable'
      AND payment_due_on IS NULL
      AND receivable_reason IS NULL)
  );

UPDATE orders AS o
LEFT JOIN customer_subscriptions AS cs ON cs.purchase_invoice_id = o.invoice_id
LEFT JOIN customers ON customers.id = COALESCE(o.customer_id, cs.customer_id)
   SET buyer_name_at_sale = COALESCE(buyer_name_at_sale, customers.name),
       buyer_phone_at_sale = COALESCE(buyer_phone_at_sale, customers.phone),
       buyer_address_at_sale = COALESCE(buyer_address_at_sale, customers.address)
 WHERE (o.payment_method = 'platform'
        OR EXISTS (
            SELECT 1
              FROM customer_subscriptions cs2
             WHERE cs2.purchase_invoice_id = o.invoice_id
        ))
   AND (o.buyer_name_at_sale IS NULL
        OR o.buyer_phone_at_sale IS NULL
        OR o.buyer_address_at_sale IS NULL);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-08-04-special-source-buyer-snapshots-v1', '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
