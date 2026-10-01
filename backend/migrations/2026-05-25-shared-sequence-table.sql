-- Migration: Create daily_sequences table for high-concurrency shared sequences
CREATE TABLE IF NOT EXISTS daily_sequences (
    sequence_date DATE NOT NULL,
    current_value INT NOT NULL DEFAULT 0,
    PRIMARY KEY (sequence_date)
) ENGINE=InnoDB;
