-- Track real serialized audit print outcomes after the spooler acknowledges a job.
ALTER TABLE audit_report_documents
  MODIFY last_print_status ENUM('queued','printed','failed') NOT NULL DEFAULT 'queued';