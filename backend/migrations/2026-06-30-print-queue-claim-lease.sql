ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS claimed_by varchar(128) DEFAULT NULL AFTER status,
  ADD COLUMN IF NOT EXISTS locked_until datetime DEFAULT NULL AFTER claimed_by,
  ADD COLUMN IF NOT EXISTS attempts int(11) NOT NULL DEFAULT 0 AFTER locked_until,
  ADD COLUMN IF NOT EXISTS last_error text DEFAULT NULL AFTER attempts,
  ADD KEY IF NOT EXISTS idx_print_queue_claim (status, locked_until, id);
