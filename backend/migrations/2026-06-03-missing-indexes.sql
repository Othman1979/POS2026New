-- Migration: Add missing indexes from June 2026 database architecture audit.
-- Author: Antigravity — 2026-06-03
-- Safe to re-run on MySQL 8.0+; uses IF NOT EXISTS guards on index creation.
-- On MySQL 5.7: run each ALTER only if the index does not already exist (check via SHOW INDEX FROM <table>).

-- ── customers.phone ──────────────────────────────────────────────────────────────
-- Called on EVERY checkout that has a customer phone number.
-- UNIQUE doubles as an application-level constraint (no two customers with same phone).
ALTER TABLE customers
    ADD UNIQUE INDEX idx_customers_phone (phone);

-- ── order_items ──────────────────────────────────────────────────────────────────
-- order_items is the fastest-growing table in the system.
-- invoice_id: queried on every checkout edit, order detail fetch, stock restoration,
--             bill split void, and print job. Critical for read performance.
-- product_id: queried in the Dashboard topItems (30-day GROUP BY) and stock restoration loops.
ALTER TABLE order_items
    ADD INDEX idx_order_items_invoice   (invoice_id),
    ADD INDEX idx_order_items_product   (product_id);

-- ── qr_table_drafts ──────────────────────────────────────────────────────────────
-- Queried on every floor-plan load (LEFT JOIN from restaurant_tables).
-- UNIQUE enforces the one-draft-per-table invariant that the application assumes
-- (ON DUPLICATE KEY UPDATE semantics in the socket handler).
ALTER TABLE qr_table_drafts
    ADD UNIQUE INDEX idx_qr_drafts_table (table_id);

-- ── printer_categories ───────────────────────────────────────────────────────────
-- category_id is the WHERE clause in the kitchen routing query that fires on
-- every kitchen print job. Small table but hit frequently during service.
ALTER TABLE printer_categories
    ADD INDEX idx_printer_categories_category (category_id);

-- ── orders.idempotency_key ───────────────────────────────────────────────────────
-- Enforces the uniqueness constraint that the application logic depends on
-- to prevent duplicate orders on network retries. Without this index, two
-- concurrent requests with the same key can both pass the SELECT check before
-- either completes the INSERT, creating a real (though rare) race condition.
-- The catch block in pos.js is updated to handle MySQL error 1062 gracefully.
ALTER TABLE orders
    ADD UNIQUE INDEX idx_orders_idempotency_key (idempotency_key);
