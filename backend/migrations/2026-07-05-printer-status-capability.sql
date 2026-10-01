ALTER TABLE printers
  ADD COLUMN IF NOT EXISTS status_capability enum('write_only','escpos_status','snmp_status') NOT NULL DEFAULT 'write_only' AFTER is_active,
  ADD COLUMN IF NOT EXISTS device_status enum('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') NOT NULL DEFAULT 'unknown' AFTER status_capability,
  ADD COLUMN IF NOT EXISTS status_checked_at datetime DEFAULT NULL AFTER device_status,
  ADD COLUMN IF NOT EXISTS status_source varchar(32) DEFAULT NULL AFTER status_checked_at;
