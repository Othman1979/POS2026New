-- Special-source buyer snapshots (phpMyAdmin-safe, forward-only).
-- Relaxes receivable terms for frozen buyer identity on finalized special-source orders.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260804_special_source_buyer_snapshots`$$
CREATE PROCEDURE `_ps_20260804_special_source_buyer_snapshots`()
migration: BEGIN
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-08-04-special-source-buyer-snapshots-v1';
    IF v_checksum IS NOT NULL
       AND v_checksum <> '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244' THEN
        LEAVE migration;
    END IF;

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
    VALUES ('2026-08-04-special-source-buyer-snapshots-v1', '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244');
END$$

CALL `_ps_20260804_special_source_buyer_snapshots`()$$
DROP PROCEDURE `_ps_20260804_special_source_buyer_snapshots`$$

DELIMITER ;
