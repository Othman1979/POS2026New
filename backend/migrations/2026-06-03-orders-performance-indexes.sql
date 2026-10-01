-- Migration: Add performance-critical indexes on orders table.
-- Author: Antigravity — 2026-06-03
-- Purpose: All major analytics queries (dashboard, reports, orders list, waiter report)
--          filter on created_at, user_id, and payment_method. Without these indexes,
--          every query does a full table scan — acceptable at 1,000 orders, painful at 50,000+.
--
-- Safe to re-run on MySQL 8.0+: uses IF NOT EXISTS guards.
-- On MySQL 5.7: check with SHOW INDEX FROM orders before running each ALTER.

-- ── orders.created_at ────────────────────────────────────────────────────────────
-- Hit by: dashboard (today + 7-day + 30-day), reports (BETWEEN), orders list
--         (CURDATE filter), waiter report (DATE_ADD filter).
-- Without this: full table scan on every analytics query.
ALTER TABLE orders
    ADD INDEX idx_orders_created_at (created_at);

-- ── orders.user_id ───────────────────────────────────────────────────────────────
-- Hit by: orders list cashier filter (WHERE o.user_id = ?),
--         shift verification inside checkout (WHERE user_id = ? AND status = 'open'),
--         waiter report JOIN on users.
ALTER TABLE orders
    ADD INDEX idx_orders_user_id (user_id);

-- ── orders.payment_method ────────────────────────────────────────────────────────
-- Hit by: dashboard (payment_method != 'unpaid_table' on every query),
--         orders list payment_methods filter (IN (...) clause),
--         reports (payment_method != 'unpaid_table' range scan).
-- A targeted index lets MySQL skip unpaid_table rows before evaluating the date range.
ALTER TABLE orders
    ADD INDEX idx_orders_payment_method (payment_method);
