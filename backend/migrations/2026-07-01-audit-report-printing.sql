-- Serialized X/Z audit report printing.
--
-- Single combined table. Serial allocation uses MySQL named locks
-- (GET_LOCK/RELEASE_LOCK around MAX(serial_no)+1) instead of a dedicated
-- counter table. Print-attempt tracking is collapsed into
-- last_print_status/last_print_error/last_printed_at/last_printed_by_user_id/
-- reprint_count columns instead of a per-event child table, since nothing
-- in the app ever read individual print-event rows.

CREATE TABLE IF NOT EXISTS audit_report_documents (
  id INT NOT NULL AUTO_INCREMENT,
  report_type ENUM('x_audit','z_audit') NOT NULL,
  serial_no INT NOT NULL,
  serial_label VARCHAR(32) NOT NULL,
  business_date DATE NOT NULL,
  business_start_at DATETIME NOT NULL,
  business_end_at DATETIME NOT NULL,
  z_business_date_lock DATE DEFAULT NULL,
  status ENUM('issued','voided') NOT NULL DEFAULT 'issued',
  payload_json JSON NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  issued_by_user_id INT NOT NULL,
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_print_status ENUM('queued','printed','failed') NOT NULL DEFAULT 'queued',
  last_print_error TEXT DEFAULT NULL,
  last_printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_printed_by_user_id INT DEFAULT NULL,
  reprint_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_serial (report_type, serial_no),
  UNIQUE KEY uq_audit_z_business_date (report_type, z_business_date_lock),
  KEY idx_audit_business_date (business_date, report_type),
  KEY idx_audit_issued_at (issued_at),
  CONSTRAINT fk_audit_documents_user FOREIGN KEY (issued_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_audit_documents_last_printed_by FOREIGN KEY (last_printed_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
