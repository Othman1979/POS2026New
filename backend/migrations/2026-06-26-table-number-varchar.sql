-- Allow alphanumeric table numbers (e.g. "T1", "Bar-3")
ALTER TABLE restaurant_tables
  MODIFY COLUMN table_number VARCHAR(50) NOT NULL DEFAULT '';
