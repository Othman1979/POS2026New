-- order_id is a display-only daily counter; defer assignment to checkout.
-- Open tables store NULL. invoice_id (PK) remains the relational key.
ALTER TABLE orders MODIFY COLUMN order_id INT NULL;
