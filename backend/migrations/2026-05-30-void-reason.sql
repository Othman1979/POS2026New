-- Migration: Add void_reason column to orders table
-- Author: Antigravity

ALTER TABLE orders
  ADD COLUMN void_reason VARCHAR(255) DEFAULT NULL;
