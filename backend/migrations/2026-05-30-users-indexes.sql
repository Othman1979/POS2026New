-- Migration: Add missing indexes to users table for authentication performance.
-- Author: Antigravity

ALTER TABLE users
  ADD UNIQUE INDEX idx_users_session_token (session_token),
  ADD UNIQUE INDEX idx_users_number (user_number),
  ADD INDEX idx_users_admin_pin (admin_pin);
